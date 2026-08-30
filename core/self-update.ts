import type { GithubService } from './github-service.ts'
import type { QueuedTask } from './workflow-engine.ts'

export interface SelfUpdateCheck {
  currentSha: string
  latestSha: string
  updateAvailable: boolean
}

export interface SelfUpdateTarget {
  owner: string
  repo: string
  branch: string
}

export const MAO_SELF_UPDATE_TARGET: SelfUpdateTarget = {
  owner: 'dragoncowkarma',
  repo: 'mao',
  branch: 'main',
}

/**
 * Compares the running Electron build against MAO's own default update branch. The GitHub lookup is
 * delegated to GithubService so this module stays Electron-free and testable under plain Node.
 */
export async function checkForUpdates(
  githubService: GithubService,
  currentSha: string,
  target: SelfUpdateTarget = MAO_SELF_UPDATE_TARGET,
): Promise<SelfUpdateCheck> {
  const normalizedCurrentSha = currentSha.trim()
  if (!normalizedCurrentSha) throw new Error('Current build SHA is not set')

  const latestSha = await githubService.getBranchHeadSha(target.owner, target.repo, target.branch)
  return {
    currentSha: normalizedCurrentSha,
    latestSha,
    updateAvailable: latestSha !== normalizedCurrentSha,
  }
}

/** Counts workflow stages that are actively in flight and should prompt before relaunch. */
export function countRunningWorkflowTasks(tasks: QueuedTask[]): number {
  return tasks.filter((task) => task.status === 'running').length
}

/**
 * Shared relaunch policy for Electron's update flow. Keeping the gate in core prevents the displayed
 * warning count and the final relaunch check from drifting apart in shell code.
 */
export function assertCanRelaunchForUpdate(tasks: QueuedTask[], force = false): number {
  const runningTaskCount = countRunningWorkflowTasks(tasks)
  if (runningTaskCount > 0 && !force) {
    throw new Error(`${runningTaskCount} workflow task(s) are still running`)
  }
  return runningTaskCount
}
