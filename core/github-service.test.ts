import { describe, expect, it, vi } from 'vitest'
import { GithubService } from './github-service.ts'

/**
 * Builds a GithubService wired to a fake Octokit-shaped object instead of a real client.
 * `octokit` is private with no constructor injection point, so the fake is installed via a cast —
 * the same pattern `applyGithubAction`'s retry path exercises against the real Octokit surface.
 */
function makeServiceWithFakeOctokit(overrides: {
  git?: Record<string, unknown>
  repos?: Record<string, unknown>
  pulls?: Record<string, unknown>
} = {}) {
  const service = new GithubService()
  const octokit = {
    rest: {
      repos: {
        get: vi.fn(async () => ({ data: { default_branch: 'main' } })),
        getContent: vi.fn(async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 })
        }),
        createOrUpdateFileContents: vi.fn(async () => ({ data: {} })),
        ...overrides.repos,
      },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: 'base-sha' } } })),
        createRef: vi.fn(async () => ({ data: {} })),
        ...overrides.git,
      },
      pulls: {
        create: vi.fn(async () => ({ data: { number: 2, html_url: 'https://github.com/acme/widgets/pull/2' } })),
        list: vi.fn(async () => ({ data: [] })),
        ...overrides.pulls,
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
      git: {
        createRef: vi.fn(async () => {
          throw alreadyExists
        }),
      },
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
      git: {
        createRef: vi.fn(async () => {
          throw validationError
        }),
      },
    })

    await expect(service.createBranch('acme', 'widgets', 'workflow/1-add-feature')).rejects.toThrow(
      /Validation Failed/,
    )
  })

  it('rethrows non-422 errors unchanged', async () => {
    const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 })
    const { service } = makeServiceWithFakeOctokit({
      git: {
        createRef: vi.fn(async () => {
          throw serverError
        }),
      },
    })

    await expect(service.createBranch('acme', 'widgets', 'workflow/1-add-feature')).rejects.toThrow(
      /Internal Server Error/,
    )
  })
})

describe('GithubService.getBranchHeadSha', () => {
  it('returns the sha pointed to by the requested branch ref', async () => {
    const { service, octokit } = makeServiceWithFakeOctokit()

    await expect(service.getBranchHeadSha('acme', 'widgets', 'release')).resolves.toBe('base-sha')
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      ref: 'heads/release',
    })
  })
})

describe('GithubService.commitFile', () => {
  it('writes a new file without a sha when none exists yet', async () => {
    const { service, octokit } = makeServiceWithFakeOctokit()
    await service.commitFile('acme', 'widgets', 'workflow/1', 'notes.md', 'body', 'Add notes')
    expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.not.objectContaining({ sha: expect.anything() }),
    )
  })

  it('reuses the existing blob sha to update the file on retry, instead of failing 422', async () => {
    // Regression for the PR #46 review: a retried notes-only `pr` stage can re-call commitFile after a
    // prior attempt already wrote this same path but failed later (e.g. createPullRequest). Without
    // passing the existing sha, createOrUpdateFileContents rejects the retry the same way createBranch
    // used to (issue #37).
    const getContent = vi.fn(async () => ({ data: { type: 'file', sha: 'old-blob-sha' } }))
    const { service, octokit } = makeServiceWithFakeOctokit({ repos: { getContent } })

    await service.commitFile('acme', 'widgets', 'workflow/1', 'workflow-notes/1.md', 'updated body', 'Update notes')

    expect(getContent).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      path: 'workflow-notes/1.md',
      ref: 'workflow/1',
    })
    expect(octokit.rest.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({ sha: 'old-blob-sha' }),
    )
  })

  it('rethrows a getContent failure that is not 404', async () => {
    const getContent = vi.fn(async () => {
      throw Object.assign(new Error('Internal Server Error'), { status: 500 })
    })
    const { service } = makeServiceWithFakeOctokit({ repos: { getContent } })

    await expect(
      service.commitFile('acme', 'widgets', 'workflow/1', 'notes.md', 'body', 'Add notes'),
    ).rejects.toThrow(/Internal Server Error/)
  })
})

describe('GithubService.createPullRequest', () => {
  it('creates the PR and returns it', async () => {
    const { service } = makeServiceWithFakeOctokit()
    const pr = await service.createPullRequest('acme', 'widgets', 'workflow/1', 'main', 'Title', 'Body')
    expect(pr).toEqual({ number: 2, html_url: 'https://github.com/acme/widgets/pull/2' })
  })

  it('reuses the already-open PR on retry instead of failing on the duplicate-head 422', async () => {
    // Regression for the PR #46 review: a retried notes-only `pr` stage can re-call createPullRequest
    // after a prior attempt already opened the PR but failed on a later step. GitHub rejects the
    // duplicate head/base pair with 422 "A pull request already exists for acme:workflow/1." — that
    // must resolve to the existing PR, not get the task permanently stuck (issue #37 follow-up).
    const existingPr = { number: 5, html_url: 'https://github.com/acme/widgets/pull/5' }
    const create = vi.fn(async () => {
      throw Object.assign(new Error('A pull request already exists for acme:workflow/1.'), { status: 422 })
    })
    const list = vi.fn(async () => ({ data: [existingPr] }))
    const { service } = makeServiceWithFakeOctokit({ pulls: { create, list } })

    const pr = await service.createPullRequest('acme', 'widgets', 'workflow/1', 'main', 'Title', 'Body')

    expect(pr).toEqual(existingPr)
    expect(list).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      head: 'acme:workflow/1',
      base: 'main',
      state: 'open',
    })
  })

  it('rethrows the duplicate-PR 422 when no matching open PR is found', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('A pull request already exists for acme:workflow/1.'), { status: 422 })
    })
    const list = vi.fn(async () => ({ data: [] }))
    const { service } = makeServiceWithFakeOctokit({ pulls: { create, list } })

    await expect(
      service.createPullRequest('acme', 'widgets', 'workflow/1', 'main', 'Title', 'Body'),
    ).rejects.toThrow(/already exists/)
  })

  it('rethrows a 422 that is not the duplicate-PR case', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Validation Failed: no commits between main and workflow/1'), { status: 422 })
    })
    const { service } = makeServiceWithFakeOctokit({ pulls: { create } })

    await expect(
      service.createPullRequest('acme', 'widgets', 'workflow/1', 'main', 'Title', 'Body'),
    ).rejects.toThrow(/Validation Failed/)
  })
})
