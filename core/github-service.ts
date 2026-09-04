import { Octokit } from 'octokit'

const GITHUB_REQUEST_TIMEOUT_MS = 60_000

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

export class GithubService {
  private octokit: Octokit | null = null

  setToken(token: string) {
    const octokit = new Octokit({ auth: token })
    // The paginate plugin drops per-call `request` options when it follows links, so install the
    // timeout at the request hook layer where it runs once for every actual HTTP request/page.
    octokit.hook.before('request', (options) => {
      options.request = {
        ...options.request,
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      }
    })
    this.octokit = octokit
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
