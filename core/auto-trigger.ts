import { parseProviderOverride } from './assignment.ts'
import { canonicalRepoList, sameRepoRef } from './repo-registry.ts'
import type { GithubService, GithubTask } from './github-service.ts'
import { STORE_RESTART_REQUIRED, type StoredObservation } from './store.ts'
import {
  QUEUE_PERSISTENCE_BROKEN,
  WORKFLOW_ACTIVE_LABEL,
  type RepoRef,
  type WorkflowEngine,
} from './workflow-engine.ts'

const DEFAULT_POLL_INTERVAL_MS = 30_000
/** How often the scheduler wakes up to check whether any repo's own poll interval has elapsed. */
const SCHEDULER_TICK_MS = 5_000

export interface AutoTriggerStatus {
  key: string
  lastPolledAt: number | null
  lastError: string | null
}

/** Polls open GitHub issues across all registered repos and auto-enqueues any not yet in the workflow. */
export function startAutoTrigger(
  githubService: GithubService,
  workflowEngine: WorkflowEngine,
  inspectRepos: () => StoredObservation<'githubRepos'>,
  schedulerTickMs = SCHEDULER_TICK_MS,
) {
  const lastPolledAt = new Map<string, number>()
  const lastError = new Map<string, string>()

  /**
   * A fresh observation, not `MaoStore.get()`'s process snapshot.
   *
   * `FileStore.get()` deliberately stays stable for the life of a CLI process, so a `mao run` whose
   * config file becomes unreadable after boot would otherwise keep polling its stale repository list.
   * The ensuing enqueue fails to persist but used to remain in memory, repeating once per tick and all
   * becoming durable after the file was repaired. Both long-lived shells now pass `store.inspect`, whose
   * read is fresh on both backends. The fixed error text is intentional: an arbitrary implementation may
   * throw a parser/backend error that quotes a plaintext token from the file.
   */
  const readReposFresh = (): RepoRef[] => {
    let observed: StoredObservation<'githubRepos'>
    try {
      observed = inspectRepos()
    } catch {
      throw new Error(STORE_RESTART_REQUIRED)
    }
    if (!observed.readable) throw new Error(STORE_RESTART_REQUIRED)
    return observed.value
  }

  /** Upgrade any existing field-only queue halt to the restart-only whole-file state. */
  const latchUnreadableStore = () => {
    const wasRestartRequired = workflowEngine.isQueueRecoveryRestartRequired()
    workflowEngine.requireQueueRecovery(STORE_RESTART_REQUIRED, { restartRequired: true })
    return !wasRestartRequired
  }

  /**
   * A poll is allowed only while both monotone safety blocks are clear.
   *
   * Call this again after every await below. Another renderer/CLI action can discover an unknown queue
   * write while a GitHub read is in flight; checking only at tick/pollNow entry would then spend the
   * next GitHub read or enqueue against state this host has already declared irreconcilable.
   */
  const assertPollingAllowed = () => {
    if (workflowEngine.isPersistenceBroken()) throw new Error(QUEUE_PERSISTENCE_BROKEN)
    const blocked = workflowEngine.getQueueRecoveryReason()
    if (blocked !== undefined) throw new Error(blocked)
  }

  const pollRepo = async (
    { owner, repo }: RepoRef,
  ): Promise<{ tasks: GithubTask[]; error: string | undefined }> => {
    const key = `${owner}/${repo}`
    try {
      assertPollingAllowed()
      // Before any read that could lead to a write, and deliberately before fetchTasks: an
      // unauthorized repo makes listForRepo fail with an opaque 404 that says nothing about the
      // missing grant, whereas this yields a verdict naming the repo and every gap. A failure throws
      // straight to the catch below, so this poll performs zero enqueueFromIssue and zero addLabel
      // calls — the two side effects issue #48 requires be unreachable without permission.
      await githubService.assertRepoWorkflowWritable(owner, repo)
      assertPollingAllowed()

      const tasks = await githubService.fetchTasks(owner, repo)
      assertPollingAllowed()
      for (const task of tasks) {
        assertPollingAllowed()
        if (task.type !== 'issue' || task.state !== 'open') continue
        if (task.labels.includes(WORKFLOW_ACTIVE_LABEL)) continue

        // Directive tags in the issue body: swarm_orchestrator-style [Worker: id] / [Reviewer: id] /
        // [Maintainer: id] pin specific registered providers to specific stages, while [Model: id] /
        // [Effort: level] pin the model and reasoning effort for the whole task (the auto-trigger
        // equivalent of `mao workflow enqueue --model/--effort`). An issue carrying none of them
        // enqueues exactly as before — undefined override, default maker-checker rotation.
        const providerOverride = parseProviderOverride(task.body)

        // autoAdvance stays true here (unchanged auto-trigger behavior) — the role/model/effort
        // preference goes in the providerOverride slot after it.
        workflowEngine.enqueueFromIssue(task.number, task.url, task.title, { owner, repo }, true, providerOverride)
        // enqueueFromIssue starts processQueue synchronously. Its stage-entry persistence can fail and
        // latch an unknown write outcome before this call returns even though the enqueue itself did not
        // throw; do not add the duplicate-protection label after the host has entered that state.
        assertPollingAllowed()
        await githubService.addLabel(owner, repo, task.number, WORKFLOW_ACTIVE_LABEL).catch(() => {})
        assertPollingAllowed()
      }
      lastError.delete(key)
      return { tasks, error: undefined }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      lastError.set(key, message)
      // Message only, never the error object: an Octokit failure carries its whole request — headers
      // included — and this line ends up in shared terminal and agent logs.
      console.error(`[auto-trigger] poll failed for ${key}: ${message}`)
      return { tasks: [], error: message }
    } finally {
      // A permission/network failure is still a completed poll attempt. A queue safety block discovered
      // during an awaited call is different: no trustworthy sync completed, so do not let the UI claim
      // that one did. Both blocks are monotone for this process.
      if (!workflowEngine.isPersistenceBroken() && workflowEngine.getQueueRecoveryReason() === undefined) {
        lastPolledAt.set(key, Date.now())
      }
    }
  }

  const tick = async () => {
    // An unknown queue-write result may already exist in memory, on disk, or both. Polling the same
    // unlabeled issue again can enqueue a duplicate, and any later queue write can make both durable.
    // The independent marker carries this block across restart; this in-memory check closes it now.
    if (workflowEngine.isPersistenceBroken()) return

    // The stored queue is unreadable, so this host does not know what was already in flight. Skip the
    // whole scheduler rather than each poll: returning here keeps `lastPolledAt` from advancing, so the
    // GUI's "last synced" stops claiming syncs that never happened, and nothing is logged once per repo
    // per interval to a console a packaged-app operator never sees. The engine refuses the enqueue
    // anyway — this makes the poll cost zero GitHub calls and write no best-effort label.
    if (workflowEngine.getQueueRecoveryReason() !== undefined) {
      // A field-only queue problem can predate a later whole-file outage. Keep observing just enough to
      // upgrade that halt: after repair, the current field shape alone cannot reveal that this
      // snapshot-backed process already lost sight of the complete settings file.
      if (!workflowEngine.isQueueRecoveryRestartRequired()) {
        try {
          readReposFresh()
        } catch {
          if (latchUnreadableStore()) console.error(`[auto-trigger] ${STORE_RESTART_REQUIRED}`)
        }
      }
      return
    }

    const now = Date.now()
    // Canonicalised per tick, not trusted as stored. A store written before repository identity became
    // case-insensitive can hold one repository twice, and iterating it raw is precisely the harm that
    // motivated the fix: two pollers for one repo, each enqueueing before the best-effort
    // workflow-active label lands, producing two branches and PRs for a single issue. Only a list
    // write heals the store itself, and an unattended `mao run` never performs one — so the scheduler
    // has to stop double-polling on its own. Read-only: nothing here writes `githubRepos`, which keeps
    // `updateRepos` the single writer.
    let repos: RepoRef[]
    try {
      repos = readReposFresh()
    } catch {
      // Skip the whole scheduler, exactly as the latch return above does — and for the same reason, one
      // window later. The fresh observation can fail for a `config.json` that turned unloadable *after*
      // a clean boot; this reaches both Electron and the CLI, whose ordinary FileStore reads are a boot
      // snapshot. `tick` is invoked bare and from `setInterval` (see `pollNow`'s comment), so a throw
      // escaping here is an unhandled rejection no caller can catch.
      //
      // Headless `mao run` has no Sidebar, so report the outage. The fixed message contains neither the
      // caught error nor the observation's problem text. Latching the engine makes this exactly once and
      // is the correctness rule, not log deduplication: FileStore's full startup snapshot must never be
      // allowed to write after an external repair. Not advancing `lastPolledAt` keeps "last synced" honest.
      if (latchUnreadableStore()) console.error(`[auto-trigger] ${STORE_RESTART_REQUIRED}`)
      return
    }
    for (const repoRef of canonicalRepoList(repos, repos)) {
      // A preceding repository in this same tick can discover either block. Stop immediately rather
      // than spending reads on later repositories and relying on their eventual enqueue to refuse.
      if (workflowEngine.isPersistenceBroken() || workflowEngine.getQueueRecoveryReason() !== undefined) {
        return
      }
      const { owner, repo, autoTrigger = true, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = repoRef
      if (!owner || !repo || !autoTrigger) continue

      const key = `${owner}/${repo}`
      const last = lastPolledAt.get(key) ?? 0
      if (now - last < pollIntervalMs) continue

      await pollRepo(repoRef)
    }
  }

  /** Snapshot of per-repo poll status, exposed for the UI's "last synced" display. */
  const getStatus = (owner: string, repo: string): AutoTriggerStatus => {
    const key = `${owner}/${repo}`
    return {
      key,
      lastPolledAt: lastPolledAt.get(key) ?? null,
      lastError: lastError.get(key) ?? null,
    }
  }

  /**
   * The operator-initiated poll behind `github:refreshRepo`, and deliberately a *wrapper* rather than
   * `pollRepo` itself.
   *
   * `pollRepo` records every failure into `lastError` and returns its value-free message. The interval
   * path deliberately ignores that return — throwing there would escape a bare `tick()` as an unhandled
   * rejection — while this wrapper propagates it into the board's error slot. Queue/persistence blocks
   * take precedence because they explain why no further poll may run at all.
   */
  const pollNow = async (repoRef: RepoRef) => {
    if (workflowEngine.isPersistenceBroken()) throw new Error(QUEUE_PERSISTENCE_BROKEN)
    const blocked = workflowEngine.getQueueRecoveryReason()
    if (blocked !== undefined) {
      if (!workflowEngine.isQueueRecoveryRestartRequired()) {
        try {
          readReposFresh()
        } catch {
          latchUnreadableStore()
        }
      }
      throw new Error(workflowEngine.getQueueRecoveryReason() ?? blocked)
    }
    // A manual refresh is another enqueue path, so it must use the same fresh guard as the scheduler.
    // Otherwise the interval is safe while the Refresh button can still append an unpersistable task.
    let repos: RepoRef[]
    try {
      repos = readReposFresh()
    } catch (error) {
      latchUnreadableStore()
      throw error
    }
    const current = canonicalRepoList(repos, repos).find((candidate) => sameRepoRef(candidate, repoRef))
    if (current === undefined) {
      throw new Error(`Repository ${repoRef.owner}/${repoRef.repo} is no longer tracked; nothing was polled.`)
    }
    // Use the current entry rather than the caller's stale card snapshot. Manual refresh deliberately
    // ignores autoTrigger=false, but identity and all other policy come from the fresh tracked list.
    const result = await pollRepo(current)
    // An unknown persistence result is the stricter diagnosis when both blocks appeared during the
    // poll: it requires queue/GitHub reconciliation and marker clearance, while a read-shape halt alone
    // would only direct the operator to repair/restart. Keep the same priority as entry and the IPC state.
    if (workflowEngine.isPersistenceBroken()) throw new Error(QUEUE_PERSISTENCE_BROKEN)
    const blockedAfterPoll = workflowEngine.getQueueRecoveryReason()
    if (blockedAfterPoll !== undefined) throw new Error(blockedAfterPoll)
    // The interval path records and continues; an operator-initiated refresh must reject so the board
    // cannot report a clean sync after permission, network, fetch or enqueue failure.
    if (result.error !== undefined) throw new Error(result.error)
    // Return the list already fetched under the safety gates. The IPC handler must not issue a second
    // fetch after this function returns: a marker can appear in that await boundary, and polling again
    // would violate the very block pollNow just established.
    return result.tasks
  }

  tick()
  const handle = setInterval(tick, schedulerTickMs)
  return { handle, getStatus, pollNow }
}
