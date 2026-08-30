import { describe, expect, it, vi } from 'vitest'
import { assertCanRelaunchForUpdate, checkForUpdates, countRunningWorkflowTasks } from './self-update.ts'
import type { GithubService } from './github-service.ts'
import type { QueuedTask } from './workflow-engine.ts'

function makeGithubService(latestSha: string): GithubService {
  return {
    getBranchHeadSha: vi.fn(async () => latestSha),
  } as unknown as GithubService
}

function makeTask(id: string, status: QueuedTask['status']): QueuedTask {
  return {
    id,
    title: 'Task',
    repo: { owner: 'acme', repo: 'widgets' },
    stage: 'pr',
    history: [],
    status,
    autoAdvance: true,
    github: {},
  }
}

describe('checkForUpdates', () => {
  it('reports no update when the running build already matches the branch head', async () => {
    const github = makeGithubService('abc123')

    await expect(checkForUpdates(github, 'abc123')).resolves.toEqual({
      currentSha: 'abc123',
      latestSha: 'abc123',
      updateAvailable: false,
    })
  })

  it('reports an update when the branch head has advanced', async () => {
    const github = makeGithubService('def456')

    await expect(checkForUpdates(github, 'abc123')).resolves.toEqual({
      currentSha: 'abc123',
      latestSha: 'def456',
      updateAvailable: true,
    })
  })

  it('requires a current build sha so every update verdict compares two concrete commits', async () => {
    const github = makeGithubService('def456')

    await expect(checkForUpdates(github, '  ')).rejects.toThrow(/Current build SHA is not set/)
  })
})

describe('relaunch update policy', () => {
  it('counts only tasks that are currently running', () => {
    expect(
      countRunningWorkflowTasks([
        makeTask('pending', 'pending'),
        makeTask('running-a', 'running'),
        makeTask('paused', 'paused'),
        makeTask('running-b', 'running'),
        makeTask('done', 'done'),
      ]),
    ).toBe(2)
  })

  it('blocks relaunch while workflow tasks are running unless the user forces it', () => {
    const tasks = [makeTask('running', 'running')]

    expect(() => assertCanRelaunchForUpdate(tasks)).toThrow(/1 workflow task\(s\) are still running/)
    expect(assertCanRelaunchForUpdate(tasks, true)).toBe(1)
  })

  it('allows relaunch without force when no workflow task is running', () => {
    expect(assertCanRelaunchForUpdate([makeTask('paused', 'paused')])).toBe(0)
  })
})
