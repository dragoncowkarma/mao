import type { GithubService } from './github-service.ts'
import { WORKFLOW_ACTIVE_LABEL, type RepoRef, type WorkflowEngine } from './workflow-engine.ts'
import type { AiAgentOverride, AiEffort } from './ai/types.ts'

const DEFAULT_POLL_INTERVAL_MS = 30_000
/** How often the scheduler wakes up to check whether any repo's own poll interval has elapsed. */
const SCHEDULER_TICK_MS = 5_000

export interface AutoTriggerStatus {
  key: string
  lastPolledAt: number | null
  lastError: string | null
}

const EFFORTS = new Set<AiEffort>(['low', 'medium', 'high'])

/**
 * Extracts `/model <model>`, `/provider <id>`, and `/effort <low|medium|high>` directives.
 * Directives may be anywhere in an issue body or comment and are case-insensitive.
 */
export function parseAgentOverride(text?: string): AiAgentOverride | undefined {
  if (!text) return undefined
  const providerId = text.match(/(?:^|\s)\/provider\s+([^\s]+)/i)?.[1]
  const model = text.match(/(?:^|\s)\/model\s+([^\s]+)/i)?.[1]
  const rawEffort = text.match(/(?:^|\s)\/effort\s+([^\s]+)/i)?.[1]?.toLowerCase()
  if (rawEffort && !EFFORTS.has(rawEffort as AiEffort)) {
    throw new Error(`Invalid /effort directive: ${rawEffort}. Expected low, medium, or high.`)
  }
  const effort = rawEffort as AiEffort | undefined
  return providerId || model || effort ? { providerId, model, effort } : undefined
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

        const latestComment = await githubService.getLatestIssueComment(owner, repo, task.number)
        // The latest comment wins only for directives it includes, allowing a human to amend one
        // setting without having to repeat the directives originally put in the issue body.
        const bodyOverride = parseAgentOverride(task.body)
        const commentOverride = parseAgentOverride(latestComment)
        const override = bodyOverride || commentOverride ? { ...bodyOverride, ...commentOverride } : undefined
        workflowEngine.enqueueFromIssue(task.number, task.url, task.title, { owner, repo }, override)
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
