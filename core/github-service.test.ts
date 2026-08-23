import { describe, expect, it, vi } from 'vitest'
import { GithubService } from './github-service.ts'

/**
 * Builds a GithubService wired to a fake Octokit-shaped object instead of a real client.
 * `octokit` is private with no constructor injection point, so the fake is installed via a cast —
 * the same pattern `applyGithubAction`'s retry path exercises against the real Octokit surface.
 */
function makeServiceWithFakeOctokit(gitOverrides: Record<string, unknown> = {}) {
  const service = new GithubService()
  const octokit = {
    rest: {
      repos: { get: vi.fn(async () => ({ data: { default_branch: 'main' } })) },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'base-sha' } } })),
        createRef: vi.fn(async () => ({ data: {} })),
        ...gitOverrides,
      },
    },
  }
  ;(service as unknown as { octokit: unknown }).octokit = octokit
  return { service, octokit }
}

describe('GithubService.createBranch', () => {
  it('creates the branch and returns the default branch as base', async () => {
    const { service, octokit } = makeServiceWithFakeOctokit()
    const result = await service.createBranch('acme', 'widgets', 'workflow/1-add-feature')
    expect(result).toEqual({ base: 'main' })
    expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      ref: 'refs/heads/workflow/1-add-feature',
      sha: 'base-sha',
    })
  })

  it('treats "Reference already exists" as success so a retry after createBranch reuses the branch', async () => {
    const alreadyExists = Object.assign(new Error('Reference already exists'), { status: 422 })
    const { service, octokit } = makeServiceWithFakeOctokit({
      createRef: vi.fn(async () => {
        throw alreadyExists
      }),
    })

    // Must not throw — a bare retry of the notes-only `pr` stage (core/workflow-engine.ts) calls
    // createBranch again after the ref was already created on a prior, partially-failed attempt.
    await expect(service.createBranch('acme', 'widgets', 'workflow/1-add-feature')).resolves.toEqual({
      base: 'main',
    })
    expect(octokit.rest.git.createRef).toHaveBeenCalledTimes(1)
  })

  it('rethrows a 422 that is not "already exists"', async () => {
    const validationError = Object.assign(new Error('Validation Failed: sha is invalid'), { status: 422 })
    const { service } = makeServiceWithFakeOctokit({
      createRef: vi.fn(async () => {
        throw validationError
      }),
    })

    await expect(service.createBranch('acme', 'widgets', 'workflow/1-add-feature')).rejects.toThrow(
      /Validation Failed/,
    )
  })

  it('rethrows non-422 errors unchanged', async () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 })
    const { service } = makeServiceWithFakeOctokit({
      createRef: vi.fn(async () => {
        throw serverError
      }),
    })

    await expect(service.createBranch('acme', 'widgets', 'workflow/1-add-feature')).rejects.toThrow(
      /Internal Server Error/,
    )
  })
})
