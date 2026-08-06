import { Octokit } from 'octokit'

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
}

export interface GithubComment {
  id: number
  author: string
  body: string
  createdAt: string
  url: string
}

/** Full issue/PR body + comment thread, fetched on demand when a card is opened in-app. */
export interface GithubTaskDetail extends GithubTask {
  body: string
  author: string
  comments: GithubComment[]
}

export class GithubService {
  private octokit: Octokit | null = null

  setToken(token: string) {
    this.octokit = new Octokit({ auth: token })
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

  async createBranch(owner: string, repo: string, branchName: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data: repoData } = await this.octokit.rest.repos.get({ owner, repo })
    const base = repoData.default_branch
    const { data: ref } = await this.octokit.rest.git.getRef({ owner, repo, ref: `heads/${base}` })
    await this.octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: ref.object.sha,
    })
    return { base }
  }

  async commitFile(owner: string, repo: string, branch: string, path: string, content: string, message: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    await this.octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      branch,
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
    })
  }

  async createPullRequest(owner: string, repo: string, head: string, base: string, title: string, body: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data } = await this.octokit.rest.pulls.create({ owner, repo, head, base, title, body })
    return data
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
