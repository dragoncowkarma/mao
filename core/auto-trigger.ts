import { parseProviderOverride } from './assignment.ts'
import type { GithubService } from './github-service.ts'
import { WORKFLOW_ACTIVE_LABEL, type RepoRef, type WorkflowEngine } from './workflow-engine.ts'

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
  getRepos: () => RepoRef[],
  schedulerTickMs = SCHEDULER_TICK_MS,
) {
  const lastPolledAt = new Map<string, number>()
  const lastError = new Map<string, string>()

  const pollRepo = async ({ owner, repo }: RepoRef) => {
    const key = `${owner}/${repo}`
    try {
      const tasks = await githubService.fetchTasks(owner, repo)
      for (const task of tasks) {
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
        await githubService.addLabel(owner, repo, task.number, WORKFLOW_ACTIVE_LABEL).catch(() => {})
      }
      lastError.delete(key)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      lastError.set(key, message)
      console.error(`[auto-trigger] poll failed for ${key}`, err)
    } finally {
      lastPolledAt.set(key, Date.now())
    }
  }

  const tick = async () => {
    const now = Date.now()
    for (const repoRef of getRepos()) {
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

  tick()
  const handle = setInterval(tick, schedulerTickMs)
  return { handle, getStatus, pollNow: pollRepo }
}
