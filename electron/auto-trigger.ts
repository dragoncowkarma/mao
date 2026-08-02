import type { GithubService } from './github-service.ts'
import { WORKFLOW_ACTIVE_LABEL, type RepoRef, type WorkflowEngine } from './workflow-engine.ts'

/** Polls open GitHub issues across all registered repos and auto-enqueues any not yet in the workflow. */
export function startAutoTrigger(
  githubService: GithubService,
  workflowEngine: WorkflowEngine,
  getRepos: () => RepoRef[],
  intervalMs = 30_000,
) {
  const tick = async () => {
    for (const { owner, repo } of getRepos()) {
      if (!owner || !repo) continue

      try {
        const tasks = await githubService.fetchTasks(owner, repo)
        for (const task of tasks) {
          if (task.type !== 'issue' || task.state !== 'open') continue
          if (task.labels.includes(WORKFLOW_ACTIVE_LABEL)) continue

          workflowEngine.enqueueFromIssue(task.number, task.url, task.title, { owner, repo })
          await githubService.addLabel(owner, repo, task.number, WORKFLOW_ACTIVE_LABEL).catch(() => {})
        }
      } catch (err) {
        console.error(`[auto-trigger] poll failed for ${owner}/${repo}`, err)
      }
    }
  }

  tick()
  return setInterval(tick, intervalMs)
}
