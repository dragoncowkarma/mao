import { randomUUID } from 'node:crypto'
import { createAiProvider } from './ai/index.ts'
import type { AiProviderConfig } from './ai/types.ts'
import type { GithubService } from './github-service.ts'

export type WorkflowStageName = 'issue' | 'pr' | 'review' | 'merge'

const STAGE_ORDER: WorkflowStageName[] = ['issue', 'pr', 'review', 'merge']

/** Applied to every issue that enters the workflow, so the auto-trigger poller never processes it twice. */
export const WORKFLOW_ACTIVE_LABEL = 'workflow-active'

export interface WorkflowStepResult {
  stage: WorkflowStageName
  agentId: string
  agentName: string
  output: string
}

export interface QueuedTask {
  id: string
  title: string
  stage: WorkflowStageName
  history: WorkflowStepResult[]
  status: 'pending' | 'running' | 'done' | 'error'
  error?: string
  github: {
    issueNumber?: number
    issueUrl?: string
    prNumber?: number
    prUrl?: string
    branch?: string
  }
}

function buildPromptForStage(task: QueuedTask): string {
  switch (task.stage) {
    case 'issue':
      return `Draft a concise GitHub issue description for: ${task.title}`
    case 'pr':
      return `Implementation notes for a pull request that resolves this issue: ${task.title}`
    case 'review':
      return `Review the following pull request for correctness and quality: ${task.title}`
    case 'merge':
      return `Confirm this pull request is ready to merge and summarize why: ${task.title}`
  }
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'task'
}

export class WorkflowEngine {
  private queue: QueuedTask[] = []
  private providers: AiProviderConfig[] = []
  private owner = ''
  private repo = ''
  private processing = false
  private github: GithubService
  private onChange?: () => void

  constructor(github: GithubService) {
    this.github = github
  }

  setProviders(providers: AiProviderConfig[]) {
    this.providers = providers
  }

  setRepo(owner: string, repo: string) {
    this.owner = owner
    this.repo = repo
  }

  /** Called after every queue mutation, so the caller can persist state. */
  setOnChange(callback: () => void) {
    this.onChange = callback
  }

  private notify() {
    this.onChange?.()
  }

  getTasks(): QueuedTask[] {
    return this.queue
  }

  /** Loads previously-persisted tasks (e.g. after an app restart) and resumes any that are unfinished. */
  restore(tasks: QueuedTask[]) {
    this.queue = tasks.map((task) => (task.status === 'running' ? { ...task, status: 'pending' } : task))
    void this.processQueue()
  }

  /** Re-attempts the current stage of a failed task. */
  retry(taskId: string): QueuedTask {
    const task = this.queue.find((t) => t.id === taskId)
    if (!task) throw new Error(`Unknown task: ${taskId}`)
    if (task.status !== 'error') throw new Error(`Task is not in an error state: ${task.status}`)

    task.status = 'pending'
    task.error = undefined
    this.notify()
    void this.processQueue()
    return task
  }

  enqueue(title: string): QueuedTask {
    const task: QueuedTask = {
      id: randomUUID(),
      title,
      stage: STAGE_ORDER[0],
      history: [],
      status: 'pending',
      github: {},
    }
    this.queue.push(task)
    this.notify()
    void this.processQueue()
    return task
  }

  /** Starts the pipeline at the 'pr' stage for an issue that already exists on GitHub (e.g. human-filed). */
  enqueueFromIssue(issueNumber: number, issueUrl: string, title: string): QueuedTask {
    const task: QueuedTask = {
      id: randomUUID(),
      title,
      stage: 'pr',
      history: [],
      status: 'pending',
      github: { issueNumber, issueUrl },
    }
    this.queue.push(task)
    this.notify()
    void this.processQueue()
    return task
  }

  /** Prevents the AI that handled the previous stage from being assigned the next one (Maker-Checker). */
  private selectAgent(task: QueuedTask): AiProviderConfig {
    if (this.providers.length === 0) throw new Error('No AI providers registered')
    const previousAgentId = task.history[task.history.length - 1]?.agentId
    const candidates = this.providers.filter((p) => p.id !== previousAgentId)
    return candidates[0] ?? this.providers[0]
  }

  private async processQueue() {
    if (this.processing) return
    this.processing = true
    try {
      let advanced = true
      while (advanced) {
        advanced = false
        for (const task of this.queue) {
          if (task.status !== 'pending') continue
          await this.runStage(task)
          advanced = true
        }
      }
    } finally {
      this.processing = false
    }
  }

  private async runStage(task: QueuedTask) {
    task.status = 'running'
    this.notify()
    try {
      const agentConfig = this.selectAgent(task)
      const provider = createAiProvider(agentConfig)
      const output = await provider.run(buildPromptForStage(task))

      await this.applyGithubAction(task, output)

      task.history.push({
        stage: task.stage,
        agentId: agentConfig.id,
        agentName: agentConfig.name,
        output,
      })

      const nextStage = STAGE_ORDER[STAGE_ORDER.indexOf(task.stage) + 1]
      if (nextStage) {
        task.stage = nextStage
        task.status = 'pending'
      } else {
        task.status = 'done'
      }
    } catch (err) {
      task.status = 'error'
      task.error = err instanceof Error ? err.message : String(err)
    }
    this.notify()
  }

  private async applyGithubAction(task: QueuedTask, output: string) {
    if (!this.owner || !this.repo) throw new Error('GitHub owner/repo is not configured')

    switch (task.stage) {
      case 'issue': {
        const issue = await this.github.createIssue(this.owner, this.repo, task.title, output)
        task.github.issueNumber = issue.number
        task.github.issueUrl = issue.html_url
        await this.github.addLabel(this.owner, this.repo, issue.number, WORKFLOW_ACTIVE_LABEL).catch(() => {})
        break
      }
      case 'pr': {
        const branch = `workflow/${task.github.issueNumber ?? task.id.slice(0, 8)}-${slugify(task.title)}`
        const { base } = await this.github.createBranch(this.owner, this.repo, branch)
        await this.github.commitFile(
          this.owner,
          this.repo,
          branch,
          `workflow-notes/${task.github.issueNumber ?? task.id}.md`,
          output,
          `Add implementation notes for: ${task.title}`,
        )
        const body = task.github.issueNumber ? `${output}\n\nCloses #${task.github.issueNumber}` : output
        const pr = await this.github.createPullRequest(this.owner, this.repo, branch, base, task.title, body)
        task.github.branch = branch
        task.github.prNumber = pr.number
        task.github.prUrl = pr.html_url
        break
      }
      case 'review': {
        if (!task.github.prNumber) throw new Error('No pull request to review')
        await this.github.reviewPullRequest(this.owner, this.repo, task.github.prNumber, output)
        break
      }
      case 'merge': {
        if (!task.github.prNumber) throw new Error('No pull request to merge')
        await this.github.commentOnIssue(this.owner, this.repo, task.github.prNumber, output)
        await this.github.mergePullRequest(this.owner, this.repo, task.github.prNumber, `Merge: ${task.title}`)
        break
      }
    }
  }
}
