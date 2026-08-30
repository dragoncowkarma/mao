import { describe, expect, it, vi } from 'vitest'
import { checkForUpdates } from './self-update.ts'
import type { GithubService } from './github-service.ts'

function makeGithubService(latestSha: string): GithubService {
  return {
    getBranchHeadSha: vi.fn(async () => latestSha),
  } as unknown as GithubService
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
