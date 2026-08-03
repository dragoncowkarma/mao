import type { GithubService } from './github-service.ts'
import { WORKFLOW_ACTIVE_LABEL, type RepoRef, type WorkflowEngine } from './workflow-engine.ts'
import type { AiEffort } from './ai/types.ts'
import type { TaskAiOverride } from './workflow-engine.ts'

const DEFAULT_POLL_INTERVAL_MS = 30_000
/** How often the scheduler wakes up to check whether any repo's own poll interval has elapsed. */
const SCHEDULER_TICK_MS = 5_000

export interface AutoTriggerStatus {
  key: string
  lastPolledAt: number | null
  lastError: string | null
}

/** Parses slash directives without treating ordinary prose as configuration. */
export function parseTaskOverride(content?: string): TaskAiOverride | undefined {
  if (!content) return undefined
  // Directives are deliberately line commands, so prose such as "the /model setting" is ignored.
  const directives = content
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('/'))
    .join(' ')
  const model = directives.match(/(?:^|\s)\/model\s+([^\s]+)/i)?.[1]
  const effort = directives.match(/(?:^|\s)\/effort\s+([^\s]+)/i)?.[1]?.toLowerCase()
  if (!model && !effort) return undefined
  if (effort && !['low', 'medium', 'high'].includes(effort)) {
    throw new Error(`Invalid /effort directive: ${effort}. Use low, medium, or high.`)
  }
  return { model, effort: effort as AiEffort | undefined }
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

        try {
          const bodyOverride = parseTaskOverride(task.body)
          const latestCommentOverride = parseTaskOverride(await githubService.fetchLatestIssueComment(owner, repo, task.number))
          const override = { ...bodyOverride, ...latestCommentOverride }
          workflowEngine.enqueueFromIssue(task.number, task.url, task.title, { owner, repo }, override)
          await githubService.addLabel(owner, repo, task.number, WORKFLOW_ACTIVE_LABEL).catch(() => {})
        } catch (err) {
          // Leave the issue unlabeled so its invalid directive can be corrected and retried on the next poll.
          console.error(`[auto-trigger] could not enqueue ${key}#${task.number}`, err)
        }
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
