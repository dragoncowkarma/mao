import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createAiProvider } from './ai/index.ts'
import type { AgentStage, AiEffort, AiProviderConfig } from './ai/types.ts'
import type { GithubService } from './github-service.ts'
import { ensureClone, checkoutBranch, hasChanges, commitAndPush } from './git-workspace.ts'

/**
 * Re-export of AgentStage for backward compatibility. The canonical definition lives in
 * core/ai/types.ts alongside AiProviderConfig (to avoid circular imports).
 */
export type WorkflowStageName = AgentStage

const STAGE_ORDER: WorkflowStageName[] = ['issue', 'pr', 'review', 'merge']

/** Which lifecycle "role" (à la swarm_orchestrator.py's Worker/Reviewer/Maintainer tags) owns each stage. */
export type WorkflowRole = 'worker' | 'reviewer' | 'maintainer'

const STAGE_ROLE: Record<WorkflowStageName, WorkflowRole> = {
  issue: 'worker',
  pr: 'worker',
  review: 'reviewer',
  merge: 'maintainer',
}

/** Cap on finished (done/error) tasks kept around, so the persisted queue doesn't grow forever. */
const MAX_FINISHED_TASKS = 50

/** Applied to every issue that enters the workflow, so the auto-trigger poller never processes it twice. */
export const WORKFLOW_ACTIVE_LABEL = 'workflow-active'

export interface RepoRef {
  owner: string
  repo: string
  /** Whether auto-trigger should poll this repo for new issues. Defaults to true when unset. */
  autoTrigger?: boolean
  /** Auto-trigger poll interval for this repo, in milliseconds. Defaults to the global auto-trigger interval. */
  pollIntervalMs?: number
}

/**
 * Per-role explicit provider assignment, e.g. parsed from a GitHub issue/PR body via
 * `parseAssignmentTags()` (see core/assignment.ts) — `[Worker: agent-cli]`, `[Reviewer: agent-cli2]`,
 * `[Maintainer: agent-cli2]` — or set directly via CLI flags. `worker` covers both the `issue` and
 * `pr` stages (drafting the issue and implementing the PR that resolves it — both the "making" side
 * of the work); `reviewer` covers `review`; `maintainer` covers `merge`.
 */
export interface WorkflowRoleAssignment {
  worker?: string
  reviewer?: string
  maintainer?: string
}

export interface ProviderOverride {
  /**
   * Preferred provider id for this task's stages. Only ever influences *which* provider is picked —
   * maker-checker still wins: a preferred provider that handled the immediately preceding stage is
   * skipped in favor of another registered provider, same as with no preference at all.
   */
  providerId?: string
  /** Applied to whichever provider ends up selected, without mutating that provider's saved config. */
  model?: string
  /** Applied to whichever provider ends up selected, without mutating that provider's saved config. */
  effort?: AiEffort
  /**
   * Per-role provider pins that take priority over `providerId` for the stage(s) they name. A Worker
   * pin is exempt from the maker-checker guard when it re-selects itself across the `issue -> pr`
   * boundary (same role, not a check on its own work) — that is the *only* exemption. A Reviewer or
   * Maintainer pin that would hand a stage back to the agent that ran the immediately preceding stage
   * is guarded exactly like a plain `providerId` override: passed over for another registered
   * provider, or the stage fails clearly if none exists — never silently weakened.
   */
  roles?: WorkflowRoleAssignment
}

export interface WorkflowStepResult {
  stage: WorkflowStageName
  agentId: string
  agentName: string
  model?: string
  effort?: AiEffort
  prompt: string
  output: string
}

export interface QueuedTask {
  id: string
  title: string
  repo: RepoRef
  stage: WorkflowStageName
  history: WorkflowStepResult[]
  status: 'pending' | 'running' | 'done' | 'error' | 'paused'
  error?: string
  /** When false, a finished stage parks the task in 'paused' instead of auto-continuing to the next stage. */
  autoAdvance: boolean
  /** Optional task-level provider/model/effort preference — always subordinate to maker-checker. */
  providerOverride?: ProviderOverride
  /** Set while status === 'running' so the UI can show which agent/prompt is currently in flight. */
  active?: {
    agentId: string
    agentName: string
    model?: string
    effort?: AiEffort
    prompt: string
  }
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

/**
 * Emits a `'change'` event (with the current task list) after every queue mutation. Both the
 * Electron main process and the headless CLI subscribe independently — one to persist state via a
 * MaoStore, the other to stream stage transitions to stdout — without either needing to know the
 * other exists.
 */
export class WorkflowEngine extends EventEmitter {
  private queue: QueuedTask[] = []
  private providers: AiProviderConfig[] = []
  private processing = false
  private github: GithubService
  private githubToken = ''
  private workspaceRoot = ''
  /**
   * Set when a `'change'` listener (e.g. createMaoApp's synchronous store.set) throws on every
   * attempt to persist a task's new status, including the guarded retry in `runStage()`. At that
   * point the in-memory queue and the on-disk store have diverged with no way to reconcile them
   * from here, and continuing to process more tasks would only widen the gap — most dangerously,
   * a restart with `resume: true` could reload the last *durably persisted* (stale) state and
   * re-run GitHub work that already happened. `processQueue()` refuses to run any further stages
   * once this is set; callers should surface `isPersistenceBroken()` / `getPersistenceError()` to
   * an operator rather than silently retrying.
   */
  private persistenceBroken: Error | undefined

  constructor(github: GithubService) {
    super()
    this.github = github
  }

  setProviders(providers: AiProviderConfig[]) {
    this.providers = providers
  }

  /** Needed (alongside setWorkspaceRoot) to clone/push over authenticated HTTPS for real code-edit PRs. */
  setGithubToken(token: string) {
    this.githubToken = token
  }

  /** Local directory where repos get cloned so CLI agents can make real file edits. Unset = notes-only PRs. */
  setWorkspaceRoot(root: string) {
    this.workspaceRoot = root
  }

  private notify() {
    this.emit('change', this.queue)
  }

  getTasks(): QueuedTask[] {
    return this.queue
  }

  /** True once a `'change'` listener has failed to persist a task even after the guarded retry (see `persistenceBroken`). */
  isPersistenceBroken(): boolean {
    return this.persistenceBroken !== undefined
  }

  /** The error from the persistence failure that tripped `isPersistenceBroken()`, if any. */
  getPersistenceError(): Error | undefined {
    return this.persistenceBroken
  }

  /** Removes all finished (done/error) tasks immediately. */
  clearCompleted() {
    this.queue = this.queue.filter((t) => t.status !== 'done' && t.status !== 'error')
    this.notify()
  }

  /** Keeps only the most recent MAX_FINISHED_TASKS done/error tasks, dropping older ones. */
  private pruneFinishedTasks() {
    const finishedIds = this.queue
      .filter((t) => t.status === 'done' || t.status === 'error')
      .map((t) => t.id)
    const excess = finishedIds.length - MAX_FINISHED_TASKS
    if (excess <= 0) return
    const toDrop = new Set(finishedIds.slice(0, excess))
    this.queue = this.queue.filter((t) => !toDrop.has(t.id))
  }

  /**
   * Loads previously-persisted tasks (e.g. after an app restart). Does NOT resume processing on its
   * own — callers that are only inspecting or reconfiguring state (e.g. a one-shot CLI command like
   * `mao config show`) must not have that trigger real GitHub/AI-provider calls as a side effect.
   * Pass resume: true (or call resumeProcessing() once ready) for long-lived processes that should
   * pick back up where they left off, such as the Electron main process or `mao run`.
   */
  restore(tasks: QueuedTask[], options: { resume?: boolean } = {}) {
    this.queue = tasks.map((task) => ({
      ...task,
      autoAdvance: task.autoAdvance ?? true,
      active: undefined,
      status: task.status === 'running' ? 'pending' : task.status,
    }))
    this.pruneFinishedTasks()
    if (options.resume) this.resumeProcessing()
  }

  /** Kicks off processing of any 'pending' tasks currently in the queue. Safe to call when already processing. */
  resumeProcessing() {
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

  /** Manually runs the current stage of a task that is parked in 'paused' (autoAdvance === false). */
  advance(taskId: string): QueuedTask {
    const task = this.queue.find((t) => t.id === taskId)
    if (!task) throw new Error(`Unknown task: ${taskId}`)
    if (task.status !== 'paused') throw new Error(`Task is not paused: ${task.status}`)

    task.status = 'pending'
    this.notify()
    void this.processQueue()
    return task
  }

  /** Toggles whether a task auto-continues to the next stage on its own, or waits for a manual advance(). */
  setAutoAdvance(taskId: string, autoAdvance: boolean): QueuedTask {
    const task = this.queue.find((t) => t.id === taskId)
    if (!task) throw new Error(`Unknown task: ${taskId}`)
    task.autoAdvance = autoAdvance
    this.notify()
    return task
  }

  enqueue(title: string, repo: RepoRef, autoAdvance = true, providerOverride?: ProviderOverride): QueuedTask {
    const task: QueuedTask = {
      id: randomUUID(),
      title,
      repo,
      stage: STAGE_ORDER[0],
      history: [],
      status: 'pending',
      autoAdvance,
      providerOverride,
      github: {},
    }
    this.queue.push(task)
    this.notify()
    void this.processQueue()
    return task
  }

  /**
   * Starts the pipeline at the 'pr' stage for an issue that already exists on GitHub (e.g. human-filed).
   * `autoAdvance` defaults to true to preserve auto-trigger's existing unattended behavior — pass false
   * to pause after each stage (see `advance()`/`setAutoAdvance()`) instead of running straight through
   * to an unattended merge.
   */
  enqueueFromIssue(
    issueNumber: number,
    issueUrl: string,
    title: string,
    repo: RepoRef,
    autoAdvance = true,
    providerOverride?: ProviderOverride,
  ): QueuedTask {
    const task: QueuedTask = {
      id: randomUUID(),
      title,
      repo,
      stage: 'pr',
      history: [],
      status: 'pending',
      autoAdvance,
      providerOverride,
      github: { issueNumber, issueUrl },
    }
    this.queue.push(task)
    this.notify()
    void this.processQueue()
    return task
  }

  /**
   * Prevents the AI that handled the previous stage from being assigned the next one (Maker-Checker).
   * A task-level provider preference (`providerOverride.providerId`, or a per-role pin in
   * `providerOverride.roles` — the role pin wins when both apply to the current stage) may steer which
   * provider gets picked, but never at the expense of that guarantee: if the preferred provider is the
   * one that just ran, it is passed over for another registered provider exactly as if no preference
   * had been set. The one deliberate exception is a Worker role pin re-selecting itself across the
   * `issue -> pr` boundary — both stages are the same "making" role, not a check on its own work, so
   * that specific case is not a maker-checker violation. It is only an error if honoring maker-checker
   * would require a distinct provider that doesn't exist. `model`/`effort` overrides are applied on top
   * of whichever provider is selected, on a copy — the caller's stored provider config is never mutated.
   *
   * Per-provider `allowedStages` restrictions narrow the candidate pool before maker-checker runs.
   * A provider whose `allowedStages` is absent or empty is eligible for every stage. When no
   * stage-eligible provider exists at all, a clear error is thrown so the task lands in `error`
   * (retryable after the operator adds or reconfigures a provider).
   */
  private selectAgent(task: QueuedTask): AiProviderConfig {
    if (this.providers.length === 0) throw new Error('No AI providers registered')
    const previousEntry = task.history[task.history.length - 1]
    const previousAgentId = previousEntry?.agentId
    const override = task.providerOverride

    // Filter to providers whose allowedStages permit the current stage.
    const stageEligible = this.providers.filter(
      (p) => !p.allowedStages || p.allowedStages.length === 0 || p.allowedStages.includes(task.stage),
    )
    if (stageEligible.length === 0) {
      throw new Error(
        `No AI provider is configured to handle the "${task.stage}" stage — ` +
          `add a provider without stage restrictions, or enable this stage for an existing provider.`,
      )
    }

    const role = STAGE_ROLE[task.stage]
    const rolePreferredId = override?.roles?.[role]
    const preferredId = rolePreferredId ?? override?.providerId
    // A Worker pin doing both 'issue' and 'pr' is the same role reusing itself, not maker-checker at
    // all — only guard when the preference came from `roles` AND the previous stage shares that role.
    const skipGuard = rolePreferredId !== undefined && previousEntry !== undefined && STAGE_ROLE[previousEntry.stage] === role

    let base: AiProviderConfig
    if (preferredId) {
      const allRegistered = this.providers.find((p) => p.id === preferredId)
      if (!allRegistered) throw new Error(`Provider override references unknown provider: ${preferredId}`)

      const preferred = stageEligible.find((p) => p.id === preferredId)
      if (!preferred) {
        throw new Error(
          `Provider override "${preferredId}" is not configured to handle the "${task.stage}" ` +
            `stage — update its allowed-stages setting or choose a different provider.`,
        )
      }

      if (skipGuard || preferred.id !== previousAgentId) {
        base = preferred
      } else {
        const alternative = stageEligible.find((p) => p.id !== previousAgentId)
        if (!alternative) {
          if (rolePreferredId !== undefined) {
            throw new Error(
              `Provider override "${preferredId}" handled the immediately preceding stage and no other ` +
                `provider is registered to check its own work — maker-checker requires a distinct provider here.`,
            )
          }
          // No other stage-eligible provider is available — relax maker-checker and use the only
          // eligible provider. Consistent with the no-override path's `candidates[0] ?? stageEligible[0]`
          // fallback: when stage restrictions (or a single-provider setup) leave only one option,
          // stage eligibility takes priority over the consecutive-agent constraint.
          base = preferred
        } else {
          base = alternative
        }
      }
    } else {
      // Prefer a provider that didn't just run (maker-checker), from the stage-eligible pool.
      const candidates = stageEligible.filter((p) => p.id !== previousAgentId)
      // Fall back to the first stage-eligible provider when only one is available — preserves the
      // existing single-provider behaviour where maker-checker relaxes rather than hard-errors.
      base = candidates[0] ?? stageEligible[0]
    }

    const activePreset = base.presets?.find((p) => p.id === base.selectedPresetId) ?? base.presets?.[0]
    const effectiveModel = override?.model !== undefined ? override.model : (base.model || activePreset?.model)
    const effectiveEffort = override?.effort !== undefined ? override.effort : (base.effort || activePreset?.effort)

    return {
      ...base,
      model: effectiveModel,
      effort: effectiveEffort,
    }
  }

  private async processQueue() {
    if (this.processing) return
    // Persistence is confirmed broken (see `persistenceBroken`) — refuse to run more stages until
    // the process restarts. Continuing would only produce more in-memory state the store can't
    // durably reflect.
    if (this.persistenceBroken) return
    this.processing = true
    try {
      let advanced = true
      while (advanced) {
        advanced = false
        for (const task of this.queue) {
          if (this.persistenceBroken) return
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
    try {
      // Entry notify lives inside the try: a throwing 'change' listener (e.g. createMaoApp's
      // synchronous store.set) must land the task in 'error' via the catch below instead of
      // leaving it stuck at 'running' forever with no path back to retry().
      this.notify()

      const agentConfig = this.selectAgent(task)
      const usesCodeEdits = task.stage === 'pr' && agentConfig.kind === 'cli' && !!this.workspaceRoot
      task.active = {
        agentId: agentConfig.id,
        agentName: agentConfig.name,
        model: agentConfig.model,
        effort: agentConfig.effort,
        prompt: usesCodeEdits ? 'Preparing local checkout…' : buildPromptForStage(task),
      }
      this.notify()

      let output: string
      let prompt = task.active.prompt

      if (usesCodeEdits) {
        const result = await this.runPrWithCodeEdits(task, agentConfig)
        output = result.output
        prompt = result.prompt
      } else {
        prompt = buildPromptForStage(task)
        const provider = createAiProvider(agentConfig)
        output = await provider.run(prompt, { model: agentConfig.model, effort: agentConfig.effort })
        await this.applyGithubAction(task, output)
      }

      task.history.push({
        stage: task.stage,
        agentId: agentConfig.id,
        agentName: agentConfig.name,
        model: agentConfig.model,
        effort: agentConfig.effort,
        prompt,
        output,
      })

      const nextStage = STAGE_ORDER[STAGE_ORDER.indexOf(task.stage) + 1]
      if (nextStage) {
        task.stage = nextStage
        task.status = task.autoAdvance ? 'pending' : 'paused'
      } else {
        task.status = 'done'
      }
    } catch (err) {
      task.status = 'error'
      task.error = err instanceof Error ? err.message : String(err)
    }
    task.active = undefined
    this.pruneFinishedTasks()
    this.notifyAfterStage(task)
  }

  /**
   * Persists the just-finished stage's outcome, guarding against a throwing `'change'` listener.
   * A single failure (whether from the entry notify inside `runStage`'s try, or this exit notify)
   * degrades the task to `'error'` and retries once — `task.active` is already cleared by this
   * point, so a failure caused by transiently-unserializable in-flight data (e.g. a large prompt)
   * won't repeat. If the retry *also* throws, persistence is confirmed broken: the on-disk store
   * can no longer be trusted to reflect this task's real status, and pretending otherwise risks a
   * restart-with-resume replaying GitHub work that already happened. Record it via
   * `persistenceBroken` (surfaced through `isPersistenceBroken()`/`getPersistenceError()`) so
   * `processQueue()` stops running further stages instead of silently continuing — and emit
   * `'persistence-broken'` so a host with independent durable storage (createMaoApp writes
   * `workflowPersistenceBroken` to the MaoStore) can record that fact even though the *normal*
   * queue-persisting write path is the one that just failed twice.
   */
  private notifyAfterStage(task: QueuedTask) {
    try {
      this.notify()
      return
    } catch (err) {
      task.status = 'error'
      task.error = err instanceof Error ? err.message : String(err)
    }
    try {
      this.notify()
    } catch (err) {
      const persistErr = err instanceof Error ? err : new Error(String(err))
      this.persistenceBroken = persistErr
      try {
        this.emit('persistence-broken', persistErr)
      } catch {
        // A throwing 'persistence-broken' listener must not escape notifyAfterStage — the
        // in-memory persistenceBroken flag above is already set regardless of whether any
        // listener could act on the event.
      }
    }
  }

  /** Lets a CLI agent make real file edits in a local clone, then pushes them as the PR branch. */
  private async runPrWithCodeEdits(
    task: QueuedTask,
    agentConfig: AiProviderConfig,
  ): Promise<{ output: string; prompt: string }> {
    if (!this.githubToken) throw new Error('GitHub token is not configured')
    const { owner, repo } = task.repo

    const branch = `workflow/${task.github.issueNumber ?? task.id.slice(0, 8)}-${slugify(task.title)}`
    const dir = await ensureClone(this.workspaceRoot, owner, repo, this.githubToken)
    const base = await this.github.getDefaultBranch(owner, repo)
    await checkoutBranch(dir, base, branch)

    const prompt =
      `You are working inside a real local git checkout of ${owner}/${repo}, currently on a ` +
      `fresh branch off ${base}. Implement the following issue by editing the actual project files in ` +
      `this directory. Do not commit or push — that is handled separately.\n\nIssue: ${task.title}` +
      (task.github.issueUrl ? `\n${task.github.issueUrl}` : '')
    if (task.active) task.active.prompt = prompt
    this.notify()

    const output = await createAiProvider(agentConfig).run(prompt, {
      cwd: dir,
      allowToolUse: true,
      model: agentConfig.model,
      effort: agentConfig.effort,
    })

    if (await hasChanges(dir)) {
      await commitAndPush(dir, branch, `feat(workflow): ${task.title}`)
      const body = task.github.issueNumber ? `${output}\n\nCloses #${task.github.issueNumber}` : output
      const pr = await this.github.createPullRequest(owner, repo, branch, base, task.title, body)
      task.github.branch = branch
      task.github.prNumber = pr.number
      task.github.prUrl = pr.html_url
    } else {
      // Agent made no real edits (declined, or nothing to change) — fall back to a notes-only PR.
      await this.applyGithubAction(task, output)
    }

    return { output, prompt }
  }

  private async applyGithubAction(task: QueuedTask, output: string) {
    const { owner, repo } = task.repo

    switch (task.stage) {
      case 'issue': {
        const issue = await this.github.createIssue(owner, repo, task.title, output)
        task.github.issueNumber = issue.number
        task.github.issueUrl = issue.html_url
        await this.github.addLabel(owner, repo, issue.number, WORKFLOW_ACTIVE_LABEL).catch(() => {})
        break
      }
      case 'pr': {
        const branch = `workflow/${task.github.issueNumber ?? task.id.slice(0, 8)}-${slugify(task.title)}`
        const { base } = await this.github.createBranch(owner, repo, branch)
        await this.github.commitFile(
          owner,
          repo,
          branch,
          `workflow-notes/${task.github.issueNumber ?? task.id}.md`,
          output,
          `docs(workflow): Add implementation notes for ${task.title}`,
        )
        const body = task.github.issueNumber ? `${output}\n\nCloses #${task.github.issueNumber}` : output
        const pr = await this.github.createPullRequest(owner, repo, branch, base, task.title, body)
        task.github.branch = branch
        task.github.prNumber = pr.number
        task.github.prUrl = pr.html_url
        break
      }
      case 'review': {
        if (!task.github.prNumber) throw new Error('No pull request to review')
        await this.github.reviewPullRequest(owner, repo, task.github.prNumber, output)
        break
      }
      case 'merge': {
        if (!task.github.prNumber) throw new Error('No pull request to merge')

        const checksStatus = await this.github.getChecksStatus(owner, repo, task.github.prNumber)
        if (checksStatus === 'pending') throw new Error('CI checks are still running — retry once they complete')
        if (checksStatus === 'failure') throw new Error('CI checks failed — merge blocked')

        await this.github.mergePullRequest(owner, repo, task.github.prNumber, `Merge: ${task.title}`)
        await this.github.commentOnIssue(owner, repo, task.github.prNumber, output)
        break
      }
    }
  }
}
