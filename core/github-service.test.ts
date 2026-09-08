import { afterEach, describe, expect, it, vi } from 'vitest'
import { GithubService } from './github-service.ts'

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function requireSignal(init?: RequestInit): AbortSignal {
  if (!(init?.signal instanceof AbortSignal)) throw new Error('Octokit fetch has no abort signal')
  return init.signal
}

function accelerateRequestTimeout() {
  const nativeSetTimeout = globalThis.setTimeout
  return vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    return nativeSetTimeout(callback, delay === 60_000 ? 0 : delay, ...args)
  })
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/**
 * Installs a fake REST surface for behavior tests that do not exercise transport. Timeout tests
 * above inject only fetch and retain the real Octokit plugin stack.
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

describe('GithubService request timeouts', () => {
  it('aborts a hanging fetch after 60 seconds through a real Octokit instance', async () => {
    const signals: AbortSignal[] = []
    const timeoutSpy = accelerateRequestTimeout()
    const requestFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = requireSignal(init)
      signals.push(signal)

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason)
        }, { once: true })
      })
    })
    const service = new GithubService(requestFetch as typeof globalThis.fetch)
    service.setToken('test-token')

    const error = await captureError(service.getDefaultBranch('acme', 'widgets'))

    expect(requestFetch).toHaveBeenCalledTimes(1)
    expect(signals[0].aborted).toBe(true)
    expect(signals[0].reason).toMatchObject({
      name: 'AbortError',
      message: 'GitHub request timed out after 60s',
    })
    expect(error.message).toBe('GitHub request timed out after 60s')
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000)
  })

  it('keeps the deadline active while a real Octokit response body is stalled', async () => {
    const timeoutSpy = accelerateRequestTimeout()
    let signal: AbortSignal | undefined
    const requestFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signal = requireSignal(init)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal!.addEventListener('abort', () => controller.error(signal!.reason), { once: true })
        },
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const service = new GithubService(requestFetch as typeof globalThis.fetch)
    service.setToken('test-token')

    const error = await captureError(service.getDefaultBranch('acme', 'widgets'))

    expect(requestFetch).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(true)
    expect(error.message).toBe('GitHub request timed out after 60s')
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000)
  })

  it('creates a fresh deadline for every real Octokit retry attempt', async () => {
    const signals: AbortSignal[] = []
    const requestFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(requireSignal(init))
      if (signals.length === 1) return jsonResponse({ message: 'Temporary failure' }, 500)
      return jsonResponse({ default_branch: 'main' })
    })
    const service = new GithubService(requestFetch as typeof globalThis.fetch)
    service.setToken('test-token')

    await expect(service.getDefaultBranch('acme', 'widgets')).resolves.toBe('main')
    expect(requestFetch).toHaveBeenCalledTimes(2)
    expect(signals).toHaveLength(2)
    expect(new Set(signals).size).toBe(2)
    expect(signals.every((signal) => !signal.aborted)).toBe(true)
  })

  it('creates a fresh deadline for every real Octokit pagination page', async () => {
    const commentSignals: AbortSignal[] = []
    const requestFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const signal = requireSignal(init)
      if (url.includes('/issues/7/comments')) {
        commentSignals.push(signal)
        const page = new URL(url).searchParams.get('page')
        if (page === '2') {
          return jsonResponse([{
            id: 2,
            user: { login: 'reviewer' },
            body: 'second',
            created_at: '2026-09-06T00:01:00Z',
            html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-2',
          }])
        }
        return jsonResponse([{
          id: 1,
          user: { login: 'author' },
          body: 'first',
          created_at: '2026-09-06T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-1',
        }], 200, {
          link:
            '<https://api.github.com/repos/acme/widgets/issues/7/comments?' +
            'per_page=100&page=2>; rel="next"',
        })
      }
      return jsonResponse({
        id: 7,
        number: 7,
        title: 'Timeout issue',
        state: 'open',
        html_url: 'https://github.com/acme/widgets/issues/7',
        updated_at: '2026-09-06T00:00:00Z',
        labels: [],
        body: '',
        user: { login: 'author' },
      })
    })
    const service = new GithubService(requestFetch as typeof globalThis.fetch)
    service.setToken('test-token')

    const detail = await service.fetchTaskDetail('acme', 'widgets', 7)

    expect(detail.comments.map((comment) => comment.body)).toEqual(['first', 'second'])
    expect(commentSignals).toHaveLength(2)
    expect(new Set(commentSignals).size).toBe(2)
    expect(commentSignals.every((signal) => !signal.aborted)).toBe(true)
  })
})

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

describe('GithubService.checkRepoWorkflowCapability', () => {
  const REPO_BODY = {
    archived: false,
    disabled: false,
    has_issues: true,
    private: true,
    permissions: { admin: false, push: true, pull: true },
  }

  /** Drives a real Octokit so header handling and status classification are exercised end to end. */
  function serviceWith(handler: (url: string) => Response) {
    const requestFetch = vi.fn(async (input: string | URL | Request) => handler(String(input)))
    const service = new GithubService(requestFetch as typeof globalThis.fetch)
    service.setToken('test-token')
    return { service, requestFetch }
  }

  it('returns a token-missing verdict without making any request when no token is set', async () => {
    const requestFetch = vi.fn()
    const service = new GithubService(requestFetch as unknown as typeof globalThis.fetch)

    const capability = await service.checkRepoWorkflowCapability('acme', 'widgets')

    expect(capability.gaps).toEqual(['token-missing'])
    expect(requestFetch).not.toHaveBeenCalled()
  })

  it('passes a writable repo and reads no scopes header as an unidentified credential', async () => {
    const { service } = serviceWith(() => jsonResponse(REPO_BODY))

    const capability = await service.checkRepoWorkflowCapability('acme', 'widgets')

    expect(capability.ok).toBe(true)
    expect(capability.observed.credential).toBe('unknown')
    expect(capability.unverified).toEqual(['issues-write', 'contents-write', 'pull-requests-write'])
  })

  it('reads x-oauth-scopes off the real response to identify a classic token', async () => {
    const { service } = serviceWith(() => jsonResponse(REPO_BODY, 200, { 'x-oauth-scopes': 'repo, read:org' }))

    const capability = await service.checkRepoWorkflowCapability('acme', 'widgets')

    expect(capability.observed.credential).toBe('classic')
    expect(capability.unverified).toEqual([])
  })

  it('fails a classic token whose scopes cannot write, even though the repo role says push', async () => {
    const { service } = serviceWith(() => jsonResponse(REPO_BODY, 200, { 'x-oauth-scopes': 'read:user' }))

    const capability = await service.checkRepoWorkflowCapability('acme', 'widgets')

    expect(capability.ok).toBe(false)
    expect(capability.gaps).toEqual(['oauth-scope-missing'])
  })

  it('reports a read-only repository as no-push-permission', async () => {
    const { service } = serviceWith(() =>
      jsonResponse({ ...REPO_BODY, permissions: { admin: false, push: false, pull: true } }),
    )

    await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).resolves.toMatchObject({
      ok: false,
      gaps: ['no-push-permission'],
    })
  })

  it('reports 404 as repo-not-found rather than letting it surface as a raw HTTP error', async () => {
    const { service } = serviceWith(() => jsonResponse({ message: 'Not Found' }, 404))

    await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).resolves.toMatchObject({
      gaps: ['repo-not-found'],
    })
  })

  it('reports 401 as bad-credentials', async () => {
    const { service } = serviceWith(() => jsonResponse({ message: 'Bad credentials' }, 401))

    await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).resolves.toMatchObject({
      gaps: ['bad-credentials'],
    })
  })

  it('reports 451 as legally-unavailable instead of retrying a takedown forever', async () => {
    const { service } = serviceWith(() => jsonResponse({ message: 'Repository access blocked' }, 451))

    await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).resolves.toMatchObject({
      gaps: ['legally-unavailable'],
    })
  })

  describe('403 classification', () => {
    it('reports a SAML-SSO-protected org as sso-authorization-required', async () => {
      const { service } = serviceWith(() =>
        jsonResponse({ message: 'Resource protected by organization SAML enforcement.' }, 403, {
          'x-github-sso': 'required; url=https://github.com/orgs/acme/sso',
        }),
      )

      await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).resolves.toMatchObject({
        gaps: ['sso-authorization-required'],
      })
    })

    it('reports a suspended installation as installation-suspended', async () => {
      const { service } = serviceWith(() =>
        jsonResponse({ message: 'This installation has been suspended' }, 403),
      )

      await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).resolves.toMatchObject({
        gaps: ['installation-suspended'],
      })
    })

    it('reports an ungranted fine-grained token as resource-not-accessible', async () => {
      // The exact shape of the case issue #48 exists for: the token was never granted this repo.
      const { service } = serviceWith(() =>
        jsonResponse({ message: 'Resource not accessible by personal access token' }, 403),
      )

      await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).resolves.toMatchObject({
        gaps: ['resource-not-accessible'],
      })
    })

    // These go through the fake REST surface rather than a real Octokit: the throttling plugin
    // *sleeps until the reset* on a genuine rate-limited response, which is correct behavior but
    // would make the test wait out the clock. The classification itself is what is under test.
    function serviceThrowing(error: unknown) {
      const { service } = makeServiceWithFakeOctokit({
        repos: {
          get: vi.fn(async () => {
            throw error
          }),
        },
      })
      return service
    }

    it('rethrows a primary rate limit rather than calling it a permission problem', async () => {
      const service = serviceThrowing(
        Object.assign(new Error('API rate limit exceeded'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1788899999' } },
        }),
      )

      await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).rejects.toThrow(/rate limit/i)
    })

    it('rethrows a secondary rate limit identified by Retry-After', async () => {
      const service = serviceThrowing(
        Object.assign(new Error('You have exceeded a secondary rate limit'), {
          status: 403,
          response: { headers: { 'retry-after': '60' } },
        }),
      )

      await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).rejects.toThrow(/secondary rate limit/i)
    })

    it('prefers the transient reading when a rate-limited response also looks inaccessible', async () => {
      // Rate limiting is checked first on purpose: mislabeling it as a permanent permission gap
      // would tell the operator to fix a grant that was never the problem.
      const service = serviceThrowing(
        Object.assign(new Error('API rate limit exceeded for installation'), {
          status: 403,
          response: { headers: { 'x-ratelimit-remaining': '0', 'x-github-sso': 'required; url=https://example.test' } },
        }),
      )

      await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).rejects.toThrow(/rate limit/i)
    })

    it('rethrows an unrecognized 403 instead of guessing at a permanent gap', async () => {
      const { service } = serviceWith(() =>
        jsonResponse({ message: 'Something else entirely' }, 403),
      )

      await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).rejects.toThrow(/Something else entirely/)
    })
  })

  it('lets the 60s request deadline surface as a transient error, not a capability verdict', async () => {
    accelerateRequestTimeout()
    const requestFetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = requireSignal(init)
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const service = new GithubService(requestFetch as typeof globalThis.fetch)
    service.setToken('test-token')

    await expect(service.checkRepoWorkflowCapability('acme', 'widgets')).rejects.toThrow(
      'GitHub request timed out after 60s',
    )
  })
})

describe('GithubService.assertRepoWorkflowWritable', () => {
  function serviceReturning(body: unknown, status = 200) {
    const requestFetch = vi.fn(async () => jsonResponse(body, status))
    const service = new GithubService(requestFetch as typeof globalThis.fetch)
    service.setToken('test-token')
    return service
  }

  it('resolves with the verdict when the repo has no known blocker', async () => {
    const service = serviceReturning({ has_issues: true, permissions: { push: true } })
    await expect(service.assertRepoWorkflowWritable('acme', 'widgets')).resolves.toMatchObject({ ok: true })
  })

  it('throws an actionable, secret-free error naming the repo and every gap', async () => {
    const service = serviceReturning({ archived: true, has_issues: false, permissions: { push: false } })

    const error = await captureError(service.assertRepoWorkflowWritable('acme', 'widgets'))

    expect(error.name).toBe('RepoCapabilityError')
    expect(error.message).toContain('acme/widgets')
    expect(error.message).toMatch(/archived/)
    expect(error.message).toMatch(/Issues/)
    expect(error.message).toMatch(/read-only/)
    expect(error.message).not.toContain('test-token')
  })

  it('applies to MAO\'s own repository with no exemption', async () => {
    const service = serviceReturning({ has_issues: true, permissions: { push: false } })

    await expect(service.assertRepoWorkflowWritable('dragoncowkarma', 'mao')).rejects.toThrow(
      /dragoncowkarma\/mao is missing permissions/,
    )
  })
})
