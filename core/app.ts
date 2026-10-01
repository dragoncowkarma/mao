import { GithubService } from './github-service.ts'
import { createRepoRegistrar } from './repo-registry.ts'
import { WorkflowEngine, type QueuedTask } from './workflow-engine.ts'
import { findStoredQueueProblem, type MaoStore } from './store.ts'
import { hasPersistenceBrokenMarker, writePersistenceBrokenMarker } from './persistence-guard.ts'

export interface MaoAppOptions {
  store: MaoStore
  /** Local directory where repos get cloned so CLI agents can make real file edits. */
  workspaceRoot: string
  /**
   * Per-user app data directory (Electron's `app.getPath('userData')`, or the CLI's resolved
   * `defaultDataDir()`/`MAO_DATA_DIR`) — passed explicitly rather than derived from `workspaceRoot`
   * so its location doesn't depend on an incidental relationship between the two. Used only to
   * durably record a confirmed queue-persistence failure via a marker file independent of
   * `MaoStore` (see core/persistence-guard.ts) — both shipped `MaoStore` backends rewrite their
   * entire JSON blob on every `set()`, so a flag written *through* `store` would retry the exact
   * write that just failed.
   */
  dataDir: string
  /**
   * Whether to immediately resume processing any leftover 'pending'/'running' tasks from a previous
   * session. Required (no default) on purpose: a long-lived process (the Electron main process, or
   * `mao run`) should pass true so it picks back up where it left off, but a one-shot CLI command
   * (e.g. `mao config show`) MUST pass false — otherwise loading the app to answer an unrelated
   * question would silently make real GitHub/AI-provider calls and mutate the persisted queue.
   */
  resume: boolean
}

export interface MaoApp {
  githubService: GithubService
  workflowEngine: WorkflowEngine
  store: MaoStore
  /**
   * The only supported way to change the tracked-repository list. Reads, preflights and writes as one
   * serialized unit (see core/repo-registry.ts) — writing `githubRepos` through `store` directly
   * reopens the late-write race that lets a slow registration resurrect a removed repository.
   */
  updateRepos: ReturnType<typeof createRepoRegistrar>
}

/**
 * Wires the core engine (GitHub client, workflow queue) against a persistence backend and loads any
 * previously-queued tasks. This is the single source of truth for how the app boots — both
 * electron/ipc.ts (GUI) and cli/index.ts (headless) call this so they run identical business logic
 * and only differ in how they store settings and surface output.
 *
 * Deliberately does NOT start the auto-trigger poller (see core/auto-trigger.ts): that spins up a
 * `setInterval` that keeps the process alive indefinitely, which is right for a long-lived Electron
 * session but would make every one-shot CLI invocation hang forever. Callers that want continuous
 * polling (the Electron main process, or `mao run`) start it themselves.
 */
/**
 * The store's report for an unreadable `workflowTasks`, or `undefined` when the queue reads normally.
 *
 * Fails closed on a store it cannot inspect at all, and fabricates that reason without interpolating the
 * error: a parse failure is free to quote the file's own text, and `config.json` holds `githubToken` in
 * plaintext. Because the latch is derived once at boot, a transient inspection failure halts only this
 * process — the next start re-inspects rather than inheriting a permanent halt.
 */
function describeUnreadableQueue(store: MaoStore): string | undefined {
  try {
    return findStoredQueueProblem(store.problems())?.message
  } catch {
    return (
      '[store] MAO could not inspect its own stored settings, so it cannot tell whether the workflow ' +
      'queue is readable — refusing to start unattended work. Check the config file reported by `mao ' +
      'config show` and restart.'
    )
  }
}

export function createMaoApp({ store, workspaceRoot, dataDir, resume }: MaoAppOptions): MaoApp {
  const githubService = new GithubService()
  const workflowEngine = new WorkflowEngine(githubService)

  const token = store.get('githubToken')
  if (token) {
    githubService.setToken(token)
    workflowEngine.setGithubToken(token)
  }
  workflowEngine.setProviders(store.get('aiProviders'))
  workflowEngine.setWorkspaceRoot(workspaceRoot)

  // Latched BEFORE the `'change'` subscription below and before restore(), and that ordering is the
  // whole fix. An unreadable `workflowTasks` is coerced to `[]` by the read guard, which looked safe
  // because resuming an empty queue is a no-op — but both long-lived hosts call startAutoTrigger()
  // straight after this function and it ticks immediately, so the first poll's enqueueFromIssue() would
  // notify(), the listener below would store.set('workflowTasks', …), and that single write would destroy
  // the only salvageable copy of the unreadable value *and* start an unattended pipeline on a host that
  // cannot know what was already in flight. Latching here makes every queue path refuse instead.
  workflowEngine.setStoredQueueProbe(() => describeUnreadableQueue(store))
  const queueProblem = describeUnreadableQueue(store)
  if (queueProblem !== undefined) workflowEngine.requireQueueRecovery(queueProblem)

  workflowEngine.on('change', (tasks: QueuedTask[]) => {
    // Last-resort backstop, and a SILENT return rather than a throw: notifyAfterStage() reads a throwing
    // `'change'` listener as a persistence failure and would escalate this read-shape halt into a bogus
    // persistenceBroken. Reads the field only — never the store — because confirmQueueRecovery() clears
    // the field and then notifies, and that one emit IS the write that replaces the unreadable value; a
    // backstop that re-inspected the store here would re-latch inside it and deadlock the only way out.
    // Every public mutator already asserts the latch, so reaching this is a bug in a future emitter; it
    // exists so such a bug costs a missing persist instead of the operator's last copy.
    if (workflowEngine.isQueueRecoveryLatched()) return
    store.set('workflowTasks', tasks)
  })
  // Best-effort durable record of a confirmed persistence failure (see
  // WorkflowEngine.isPersistenceBroken()) — via a marker file independent of `store` (see
  // core/persistence-guard.ts's module doc for why going through `store` here wouldn't actually be
  // independent). If even this minimal write also fails, there's nothing more this process can do;
  // the in-memory flag on workflowEngine still stops it from running further stages for the rest of
  // this process's life.
  workflowEngine.on('persistence-broken', (err: Error) => {
    try {
      writePersistenceBrokenMarker(dataDir, err)
    } catch {
      // Nothing more we can do — even this independent, minimal write has now failed too.
    }
  })

  // A prior process confirmed it could no longer durably persist queue state (see above) and may
  // have advanced a task's stage in memory — including real GitHub writes — without that advance
  // reaching workflowTasks. The on-disk snapshot can therefore predate work that already happened;
  // auto-resuming from it risks re-running (duplicating) that work. Refuse to auto-resume — no
  // matter what the caller asked for — until an operator has verified the queue and explicitly
  // cleared the marker (`mao config clear-persistence-broken`).
  // Two independent facts, deliberately not conflated: the marker means a prior process could no longer
  // *write*, the latch means this process cannot *read* the queue. `mao config show` reports them
  // separately so neither is diagnosed as the other.
  const safeToResume = resume && !hasPersistenceBrokenMarker(dataDir) && !workflowEngine.isQueueRecoveryLatched()
  workflowEngine.restore(store.get('workflowTasks'), { resume: safeToResume })

  return { githubService, workflowEngine, store, updateRepos: createRepoRegistrar(githubService, store) }
}
