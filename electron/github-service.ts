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
}

export class GithubService {
  private octokit: Octokit | null = null
  private timer: NodeJS.Timeout | null = null

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

    return data.map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      type: item.pull_request ? 'pull_request' : 'issue',
      state: item.state,
      url: item.html_url,
      updatedAt: item.updated_at,
      urgent: item.labels.some((label) =>
        (typeof label === 'string' ? label : (label.name ?? '')).toLowerCase().includes('urgent'),
      ),
    }))
  }

  async createIssue(owner: string, repo: string, title: string, body: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    const { data } = await this.octokit.rest.issues.create({ owner, repo, title, body })
    return data
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

  async mergePullRequest(owner: string, repo: string, pullNumber: number, commitTitle: string) {
    if (!this.octokit) throw new Error('GitHub token is not set')
    await this.octokit.rest.pulls.merge({ owner, repo, pull_number: pullNumber, commit_title: commitTitle })
  }

  startPolling(owner: string, repo: string, intervalMs: number, onUpdate: (tasks: GithubTask[]) => void) {
    this.stopPolling()
    const tick = async () => {
      try {
        onUpdate(await this.fetchTasks(owner, repo))
      } catch (err) {
        console.error('[github-service] poll failed', err)
      }
    }
    tick()
    this.timer = setInterval(tick, intervalMs)
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
