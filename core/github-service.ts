import { Octokit } from 'octokit'
import {
  RepoCapabilityError,
  evaluateRepoCapability,
  type RepoCapabilityFailure,
  type RepoCapabilitySnapshot,
  type RepoWorkflowCapability,
} from './repo-capabilities.ts'

/**
 * A stalled GitHub socket would otherwise block every repository behind the single-flight queue.
 * The deadline is per actual fetch attempt, so pagination and plugin retries each get a fresh budget.
 */
const GITHUB_REQUEST_TIMEOUT_MS = 60_000

type GithubFetch = typeof globalThis.fetch

function rebuildResponse(response: Response, body: ArrayBuffer): Response {
  const buffered = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  // The Response constructor cannot set these fetch metadata fields, but Octokit exposes `url`.
  Object.defineProperties(buffered, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  })
  return buffered
}

function withRequestTimeout(requestFetch: GithubFetch): GithubFetch {
  return async (input, init) => {
    const controller = new AbortController()
    const upstreamSignal = init?.signal
    const forwardAbort = () => controller.abort(upstreamSignal?.reason)

    if (upstreamSignal?.aborted) forwardAbort()
    else upstreamSignal?.addEventListener('abort', forwardAbort, { once: true })

    let cleanedUp = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      if (timer) clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', forwardAbort)
    }

    timer = setTimeout(() => {
      const error = Object.assign(
        new Error(`GitHub request timed out after ${GITHUB_REQUEST_TIMEOUT_MS / 1000}s`),
        { name: 'AbortError' },
      )
      controller.abort(error)
      cleanup()
    }, GITHUB_REQUEST_TIMEOUT_MS)

    try {
      const response = await requestFetch(input, { ...init, signal: controller.signal })
      if (!response.body) {
        cleanup()
        return response
      }
      // Fetch resolves after headers arrive, while Octokit consumes the body later and swallows
      // body-read failures. Buffer inside this transport boundary so a stalled body rejects here.
      const body = await response.arrayBuffer()
      cleanup()
      return rebuildResponse(response, body)
    } catch (error) {
      cleanup()
      throw error
    }
  }
}

export interface GithubTask {
  id: number
  number: number
  title: string
  type: 'issue' | 'pull_request'
  state: string
  url: string
  updatedAt: string
  urgent: boolean
  labels: string[]
  /**
   * Full body text. GitHub's list-issues endpoint already includes it in every item, so this costs no
   * extra API call — carried here (rather than only on `GithubTaskDetail`) so auto-trigger can parse
   * `[Worker: ...]`/`[Reviewer: ...]`/`[Maintainer: ...]` role tags (see core/assignment.ts) directly
   * off the bulk listing without a second fetch per issue.
   */
  body: string
  /**
   * Issue numbers referenced by this PR's closing keywords (`Closes/Fixes/Resolves #N`).
   * Only populated on pull-request items; undefined on issues.
   */
  linkedIssueNumbers?: number[]
}

export interface GithubComment {
  id: number
  author: string
  body: string
  createdAt: string
  url: string
}

/** Full issue/PR body + comment thread, fetched on demand when a card is opened in-app. `body` is inherited from GithubTask. */
export interface GithubTaskDetail extends GithubTask {
  author: string
  comments: GithubComment[]
}

/**
 * Strips contexts where GitHub ignores closing keywords: HTML comments, fenced code blocks
 * (``` or ~~~), inline code spans, and blockquote lines. Mirrors GitHub's documented behaviour
 * so we don't create false linked-item badges from examples or quoted text in a PR body.
 */
function sanitizeBodyForKeywords(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')     // HTML comments
    .replace(/```[\s\S]*?```/g, '')      // fenced code blocks (backtick)
    .replace(/~~~[\s\S]*?~~~/g, '')      // fenced code blocks (tilde)
    .replace(/`[^`\r\n]+`/g, '')        // inline code spans
    .replace(/^>.*$/gm, '')              // blockquote lines
}

/**
 * Parses issue numbers from PR body closing-keyword patterns.
 * Covers all GitHub-supported keywords: close, closes, closed, fix, fixes, fixed,
 * resolve, resolves, resolved (case-insensitive). A word-boundary anchor (`\b`) prevents
 * false matches on substrings like "prefixes #12". Code/quote contexts are stripped first.
 */
function parseLinkedIssues(body: string): number[] {
  const sanitized = sanitizeBodyForKeywords(body)
  const matches = sanitized.matchAll(/\b(?:close[ds]?|fix(?:e[ds]?)?|resolve[ds]?)\s+#(\d+)/gi)
  return [...matches].map((m) => parseInt(m[1], 10))
}

/**
 * Reads one response header across the shapes Octokit can hand back (a plain lowercase-keyed object,
 * or a `Headers`-like with `.get()`). Returns `undefined` only when the header is genuinely absent,
 * never collapsing a present-but-empty value into it: `classifyLookupFailure()` tests `retry-after`
 * and `x-github-sso` with `!== undefined`, so an empty value must still read as present.
 */
function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(header: string): string | null }).get(name)
    return value === null ? undefined : value
  }
  const value = (headers as Record<string, unknown>)[name]
  if (typeof value === 'string') return value
  return typeof value === 'number' ? String(value) : undefined
}

/**
 * Decides whether a failed `repos.get` is a permanent capability verdict or a transient error to
 * rethrow. Getting this split right is the whole difference between "you lack permission, fix the
 * grant" and "GitHub was briefly unhappy, retry" — a task must never be told the former about the
 * latter, and must never retry forever against the former.
 *
 * 404 and 401 are unambiguous. 403 (and 429) are not: GitHub uses them both for rate limiting, which
 * clears on its own, and for several permanent refusals — SAML SSO the credential was never
 * authorized for, a suspended App installation, and "Resource not accessible by integration /
 * personal access token", which is precisely how a fine-grained token reports a grant it never had.
 * Rate limiting is identified first (it is the only genuinely transient one), then the permanent
 * cases by their signature headers and messages; anything else falls through to a rethrow rather than
 * being guessed at. 451 is a legal takedown — permanent, and easily mistaken for a transient 4xx.
 */
function classifyLookupFailure(err: unknown): RepoCapabilityFailure | undefined {
  const status = (err as { status?: number } | null)?.status
  if (status === 404) return 'not-found'
  if (status === 401) return 'bad-credentials'
  if (status === 451) return 'legally-unavailable'
  if (status !== 403 && status !== 429) return undefined

  const headers = (err as { response?: { headers?: unknown } } | null)?.response?.headers
  const message = err instanceof Error ? err.message : String(err)

  // Transient: primary rate limit (remaining 0) and secondary rate limit (Retry-After / message).
  if (readHeader(headers, 'x-ratelimit-remaining') === '0') return undefined
  if (readHeader(headers, 'retry-after') !== undefined) return undefined
  if (/rate limit/i.test(message)) return undefined

  if (readHeader(headers, 'x-github-sso') !== undefined) return 'sso-authorization-required'
  if (/installation has been suspended/i.test(message)) return 'installation-suspended'
  if (/resource not accessible by/i.test(message)) return 'resource-not-accessible'
  return undefined
}

export class GithubService {
  private octokit: Octokit | null = null
  private readonly requestFetch: GithubFetch

  /** The fetch dependency is injectable so timeout behavior can be tested through a real Octokit. */
  constructor(requestFetch: GithubFetch = globalThis.fetch) {
    this.requestFetch = requestFetch
  }

  setToken(token: string) {
    this.octokit = new Octokit({
      auth: token,
      // Octokit calls this at the innermost network boundary. Starting the deadline here keeps
      // retry/throttle waits outside it while bounding every eventual HTTP attempt and page.
      request: {
        fetch: withRequestTimeout(this.requestFetch),
      },
    })
  }

  async fetchTasks(owner: string, repo: string): Promise<GithubTask[]> {
    if (!this.octokit) throw new Error('GitHub token is not set')

    const { data } = await this.octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 50,
    })

    return data.map((item) => {
      const labels = item.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      return {
        id: item.id,
        number: item.number,
        title: item.title,
        type: item.pull_request ? 'pull_request' : 'issue',
        state: item.state,
        url: item.html_url,
        updatedAt: item.updated_at,
        urgent: labels.some((label) => label.toLowerCase().includes('urgent')),
        labels,
        body: item.body ?? '',
        linkedIssueNumbers: item.pull_request ? parseLinkedIssues(item.body ?? '') : undefined,
      }
    })
  }

  /**
   * Fetches the full body + comment thread for an issue or PR (the `fetchTasks` list only carries
   * summary fields). GitHub's issues endpoints cover PRs too — they're issues with a `pull_request`
   * key attached — so one call shape serves both card types the UI opens in-app.
   */
  async fetchTaskDetail(owner: string, repo: string, number: number): Promise<GithubTaskDetail> {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const [{ data: issue }, comments] = await Promise.all([
      this.octokit.rest.issues.get({ owner, repo, issue_number: number }),
      this.octokit.paginate(this.octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }),
    ])

    const labels = issue.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      type: issue.pull_request ? 'pull_request' : 'issue',
      state: issue.state,
      url: issue.html_url,
      updatedAt: issue.updated_at,
      urgent: labels.some((label) => label.toLowerCase().includes('urgent')),
      labels,
      body: issue.body ?? '',
      linkedIssueNumbers: issue.pull_request ? parseLinkedIssues(issue.body ?? '') : undefined,
      author: issue.user?.login ?? 'unknown',
      comments: comments.map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? 'unknown',
        body: comment.body ?? '',
        createdAt: comment.created_at,
        url: comment.html_url,
      })),
    }
  }

  /**
   * Read-only preflight: does the current credential have what MAO's pipeline needs in this repo?
   * One `GET /repos/{owner}/{repo}` supplies every signal GitHub is willing to give without a write —
   * `archived`, `disabled`, `has_issues`, the `permissions` role block, and (for classic tokens only)
   * the `x-oauth-scopes` response header. The verdict itself is computed by the pure
   * `evaluateRepoCapability()` in core/repo-capabilities.ts.
   *
   * Only *definitive* negatives become part of the verdict — a missing token plus whatever
   * `classifyLookupFailure()` recognizes as permanent. Everything else (rate limiting, 5xx, socket
   * errors, this class's own 60s request deadline) is rethrown so the caller surfaces it as a
   * transient, retryable failure rather than a permanent "you lack permission".
   */
  async checkRepoWorkflowCapability(owner: string, repo: string): Promise<RepoWorkflowCapability> {
    if (!this.octokit) return evaluateRepoCapability({ owner, repo, failure: 'token-missing' })

    try {
      const response = await this.octokit.rest.repos.get({ owner, repo })
      return evaluateRepoCapability({
        owner,
        repo,
        repository: response.data as RepoCapabilitySnapshot,
        // Passed through verbatim rather than normalized to '': absent and empty are deliberately
        // equivalent for the verdict (both mean an unidentified credential — see RepoCredentialKind),
        // but normalizing here would hide a real, non-empty value if this ever changed shape.
        oauthScopes: readHeader(response.headers, 'x-oauth-scopes'),
      })
    } catch (err) {
      const failure = classifyLookupFailure(err)
      if (failure) return evaluateRepoCapability({ owner, repo, failure })
      throw err
    }
  }

  /**
   * `checkRepoWorkflowCapability()` as a guard: throws `RepoCapabilityError` (message names the repo
   * and every missing capability, no secrets) when the repo cannot host the workflow. Callers put this
   * in front of every externally-visible side effect — registration, a workflow stage, an auto-trigger
   * enqueue — so a permission problem costs nothing but one read.
   */
  async assertRepoWorkflowWritable(owner: string, repo: string): Promise<RepoWorkflowCapability> {
    const capability = await this.checkRepoWorkflowCapability(owner, repo)
    if (!capability.ok) throw new RepoCapabilityError(capability)
    return capability
  }

  async addLabel(owner: string, repo: string, issueNumber: number, label: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    await this.octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [label] })
  }

  /** Fetches a single issue (or PR, since GitHub treats PRs as issues) by number. */
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<{ number: number; title: string; url: string }> {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data } = await this.octokit.rest.issues.get({ owner, repo, issue_number: issueNumber })
    return { number: data.number, title: data.title, url: data.html_url }
  }

  async createIssue(owner: string, repo: string, title: string, body: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data } = await this.octokit.rest.issues.create({ owner, repo, title, body })
    return data
  }

  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data } = await this.octokit.rest.repos.get({ owner, repo })
    return data.default_branch
  }

  /** Fetches the commit SHA currently pointed to by a branch ref. */
  async getBranchHeadSha(owner: string, repo: string, branch: string): Promise<string> {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data } = await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
    return data.object.sha
  }

  /**
   * Idempotent by design: a retried `applyGithubAction`'s notes-only `pr` case (`core/workflow-engine.ts`)
   * re-calls this after a prior attempt already created the ref but failed on a later step
   * (`commitFile`/`createPullRequest`). Without this, `createRef` rejects with "Reference already
   * exists" on every subsequent retry and the task is stuck forever (issue #37) — so a 422 whose
   * message says the ref already exists is treated as success (the branch is reused) rather than
   * rethrown. Any other failure (including a genuine 422 for an unrelated reason) still throws.
   */
  async createBranch(owner: string, repo: string, branchName: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data: repoData } = await this.octokit.rest.repos.get({ owner, repo })
    const base = repoData.default_branch
    const { data: ref } = await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })
    try {
      await this.octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: ref.object.sha,
      })
    } catch (err) {
      const status = (err as { status?: number } | null)?.status
      const message = err instanceof Error ? err.message : String(err)
      if (status !== 422 || !/already exists/i.test(message)) throw err
    }
    return { base }
  }

  /**
   * Idempotent by design: a retried notes-only `pr` stage (`core/workflow-engine.ts`) can re-call this
   * after a prior attempt already wrote this same `path` on `branch` but failed on a later step
   * (`createPullRequest`). `createOrUpdateFileContents` requires the existing blob's `sha` to update a
   * file — without it GitHub rejects the retry with 422 and the task is stuck again, same failure mode
   * as issue #37's `createBranch` case. Look up any existing sha on `branch` first and pass it through
   * when present; a missing file (404) means this is the first write, so no sha is needed.
   */
  async commitFile(owner: string, repo: string, branch: string, path: string, content: string, message: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    let sha: string | undefined
    try {
      const { data: existing } = await this.octokit.rest.repos.getContent({ owner, repo, path, ref: branch })
      if (!Array.isArray(existing) && existing.type === 'file') sha = existing.sha
    } catch (err) {
      const status = (err as { status?: number } | null)?.status
      if (status !== 404) throw err
    }
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      branch,
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      ...(sha ? { sha } : {}),
    })
  }

  /**
   * Idempotent by design: see `createBranch`'s doc comment (issue #37) — a retried notes-only `pr`
   * stage can reach this call again after a prior attempt already opened the PR but failed afterward
   * (e.g. the CI-gate/notify path). GitHub rejects a duplicate head/base PR with 422 ("A pull request
   * already exists for <owner>:<head>."); on that specific error, look the existing PR up and return
   * it instead of throwing so the retry completes. Any other failure still throws.
   */
  async createPullRequest(owner: string, repo: string, head: string, base: string, title: string, body: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    try {
      const { data } = await this.octokit.rest.pulls.create({ owner, repo, head, base, title, body })
      return data
    } catch (err) {
      const status = (err as { status?: number } | null)?.status
      const message = err instanceof Error ? err.message : String(err)
      if (status !== 422 || !/already exists/i.test(message)) throw err
      const { data: existing } = await this.octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${head}`,
        base,
        state: 'open',
      })
      const pr = existing[0]
      if (!pr) throw err
      return pr
    }
  }

  async reviewPullRequest(owner: string, repo: string, pullNumber: number, body: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body,
      event: 'COMMENT',
    })
  }

  async commentOnIssue(owner: string, repo: string, issueNumber: number, body: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    await this.octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body })
  }

  /** Combines GitHub Actions check-runs and legacy commit statuses on the PR's head commit. */
  async getChecksStatus(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<'pending' | 'success' | 'failure' | 'none'> {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data: pr } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })
    const ref = pr.head.sha

    const [checkRuns, { data: combinedStatus }] = await Promise.all([
      this.octokit.paginate(this.octokit.rest.checks.listForRef, { owner, repo, ref, per_page: 100 }),
      this.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref }),
    ])

    const hasLegacyStatuses = combinedStatus.statuses.length > 0
    if (checkRuns.length === 0 && !hasLegacyStatuses) return 'none'

    // getCombinedStatusForRef reports state: 'pending' by default even with zero legacy statuses,
    // so its state only means anything when there are actual statuses to back it up.
    const anyPending =
      checkRuns.some((run) => run.status !== 'completed') || (hasLegacyStatuses && combinedStatus.state === 'pending')
    if (anyPending) return 'pending'

    const anyFailed =
      checkRuns.some((run) => !['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')) ||
      (hasLegacyStatuses && combinedStatus.state === 'failure')
    return anyFailed ? 'failure' : 'success'
  }

  async mergePullRequest(owner: string, repo: string, pullNumber: number, commitTitle: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    await this.octokit.rest.pulls.merge({ owner, repo, pull_number: pullNumber, commit_title: commitTitle })
  }
}
