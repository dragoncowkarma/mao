import type { GithubService } from './github-service.ts'
import { WORKFLOW_ACTIVE_LABEL, type WorkflowEngine } from './workflow-engine.ts'

/** Polls open GitHub issues and auto-enqueues any that haven't entered the workflow yet. */
export function startAutoTrigger(
  githubService: GithubService,
  workflowEngine: WorkflowEngine,
  getRepo: () => { owner: string; repo: string },
  intervalMs = 30_000,
) {
  const tick = async () => {
    const { owner, repo } = getRepo()
    if (!owner || !repo) return

    try {
      const tasks = await githubService.fetchTasks(owner, repo)
      for (const task of tasks) {
        if (task.type !== 'issue' || task.state !== 'open') continue
        if (task.labels.includes(WORKFLOW_ACTIVE_LABEL)) continue

        workflowEngine.enqueueFromIssue(task.number, task.url, task.title)
        await githubService.addLabel(owner, repo, task.number, WORKFLOW_ACTIVE_LABEL).catch(() => {})
      }
    } catch (err) {
      console.error('[auto-trigger] poll failed', err)
    }
  }

  tick()
  return setInterval(tick, intervalMs)
}
