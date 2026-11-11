import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { finished } from 'node:stream/promises'
import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { SwarmRunOptions } from '../swarm-runner.ts'
import { SwarmPlatform, SwarmPreflightError, isTrustedComment } from './platform.ts'
import { buildAiArgv, parseRole, resolveRoleAssignment, validateDistinctRoles } from './models.ts'
import type { RoleAssignment } from './models.ts'
import { ProcessTracker, lifecycleItemKey } from './registry.ts'
import type { LifecycleRole, TrackedProcess } from './registry.ts'

export interface SwarmIssue { number: number, title: string, body: string, state?: string }
export interface SwarmPR extends SwarmIssue {
  headRefName: string
  headRefOid: string
  isCrossRepository?: boolean
  isDraft?: boolean
}
export interface SwarmComment {
  id?: string | number
  url?: string
  body: string
  author?: { login?: string }
  authorAssociation?: string
}
export type PrAction = 'review' | 'revise' | 'maintain' | 'review_after_maintainer_block'
export interface PrSignal { action: PrAction, comment?: SwarmComment, id: string }
const REVIEWER_REJECTED_PATTERN = new RegExp([
  '\\bnot\\s+(?:\\w+\\s+){0,3}(?:approve[ds]?|lgtm)\\b',
  '\\bno\\s+(?:\\w+\\s+){0,2}lgtm\\b', '\\bnon-lgtm\\b',
  '\\bnever\\s+(?:\\w+\\s+){0,3}(?:approve[ds]?|lgtm)\\b',
  '\\bcan(?:not|\'t)\\s+(?:\\w+\\s+){0,3}(?:approve[ds]?|lgtm)\\b',
  '\\bwon\'?t\\s+(?:\\w+\\s+){0,3}(?:approve[ds]?|lgtm)\\b',
  '\\b(?:does|did|is)(?:n\'t|\\s+not)\\s+(?:\\w+\\s+){0,3}(?:approve[ds]?|lgtm)\\b',
  '\\bunapproved\\b', '\\bdisapproved\\b', '\\bchanges?\\s+requested\\b',
  '\\bchanges?\\s+(?:are\\s+)?(?:still\\s+)?(?:required|needed)\\b',
  '\\b(?:still\\s+)?needs?\\s+(?:further\\s+)?(?:changes?|fixes?|revision)\\b',
  '\\brequires?\\s+(?:further\\s+)?changes?\\b', '\\brequesting\\s+changes?\\b',
  '\\brevision\\s+(?:is\\s+)?(?:still\\s+)?(?:required|needed)\\b',
  '\\bfixes?\\s+(?:are\\s+)?(?:still\\s+)?(?:required|needed)\\b',
  '\\bnot\\s+ready\\b', '\\b(?:lgtm|approve[ds]?)\\s+(?:after|once|when|if|provided)\\b',
  '\\bconditional(?:ly)?\\s+(?:approve[ds]?|lgtm)\\b',
  '\\b(?:approve[ds]?|lgtm)\\s+conditional(?:ly)?\\b',
  'conditional\\s+approval', '승인\\s*(?:불가|보류)', '수정\\s*(?:필요|요청)',
].join('|'), 'i')

/** Match the task title convention exactly; incidental issue references do not authorize dispatch. */
export function issueNumberFromPrTitle(title: string): number | undefined {
  if (typeof title !== 'string') return undefined
  const match = /^\s*\[PR\]\s*(\d+)/.exec(title)
  const number = match ? Number(match[1]) : 0
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/** Missing associations fail closed unless the comment author is the authenticated gh user. */
export function trustedComments(comments: SwarmComment[], currentUser: string): SwarmComment[] {
  if (!currentUser) return []
  return comments.filter((comment) => isTrustedComment(comment, currentUser))
}

/** Negative/conditional approvals always win over positive words in the same comment. */
export function determinePrAction(comments: SwarmComment[]): PrSignal {
  let result: PrSignal = { action: 'review', id: 'initial' }
  comments.forEach((comment, index) => {
    const body = comment.body ?? ''
    const reviewer = parseRole(body, 'reviewer')
    const maintainer = parseRole(body, 'maintainer')
    let action: PrAction | undefined
    if (maintainer && /\[Maintainer Blocked\]/i.test(body)) action = 'review_after_maintainer_block'
    else if (reviewer) {
      const rejected = REVIEWER_REJECTED_PATTERN.test(body)
      action = maintainer && !rejected ? 'maintain' : 'revise'
    } else if (body.includes('[Worker] Revision complete.')) action = 'review'
    if (action) {
      const id = String(comment.id || comment.url || `index-${index}`).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
      result = { action, comment, id }
    }
  })
  return result
}

const integrityNotice = 'Execution integrity: perform the requested operations for real, verify their results, '
  + 'and report failures honestly. Never invent a commit, push, review, CI, merge, or issue result.'
const tag = (role: string, assignment: RoleAssignment) =>
  `[${role}: ${assignment.ai} | Model: ${assignment.model} | Reasoning: ${assignment.reasoning}]`
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

/** Stream arbitrary-size Unicode input after ownership is durable, with supervised EPIPE handling. */
async function sendPrompt(child: ChildProcess, prompt: string, signal: AbortSignal): Promise<void> {
  if (!child.stdin) throw new Error('AI process has no stdin pipe')
  const input = child.stdin
  // Keep a listener after completion too: a late stream error must never crash the scheduler.
  input.on('error', () => {})
  const completion = finished(input, { cleanup: true, signal })
  input.end(prompt, 'utf8')
  try { await completion } catch {
    input.destroy()
    throw new Error('Could not deliver AI prompt through stdin before its deadline')
  }
}

/** Keep the optional prompt material bounded without cutting off the execution instructions. */
export function reviewerContext(pr: SwarmPR, diff: string): string {
  const cut = diff.length > 50_000
  return `PR description:\n${pr.body}\n\nPR diff:\n${diff.slice(0, 50_000)}`
    + (cut ? '\n[Diff truncated after 50,000 characters; inspect remaining changes if needed.]' : '')
}

/** Structural dependencies permit lifecycle tests without real GitHub or AI calls. */
export interface EnginePlatform {
  bindOrigin(verifyTransport?: boolean): Promise<unknown>
  gh(args: string[]): Promise<string>
  json<T>(args: string[]): Promise<T>
  assertRepoWritable(): Promise<unknown>
  prepareDispatch(checkout: string, expectedBranch?: string): Promise<NodeJS.ProcessEnv>
  createWorktree(issue: number, branch: string, verifiedHead?: string): Promise<string>
  fetchPrHead(pr: number, sha: string): Promise<string>
  cleanupWorktree(issue: number, branch: string): Promise<void>
  syncMain(dryRun?: boolean): Promise<void>
}

/**
 * One autonomous scheduler, independent of the app's persisted workflow queue. The gh credential
 * owns this boundary; every real cycle and every dispatch is re-preflighted before side effects.
 */
export class SwarmEngine {
  readonly tracker: ProcessTracker
  readonly platform: EnginePlatform
  private shutdownSignal: NodeJS.Signals | undefined
  private sleepAbort: AbortController | undefined
  private runtimeWrites = false
  private readonly blockers = new Set<string>()
  private readonly dispatchBlockers = new Map<string, string>()
  private cycles = 0

  constructor(
    readonly repoRoot: string,
    readonly options: SwarmRunOptions,
    platform?: EnginePlatform,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {
    this.platform = platform ?? new SwarmPlatform(repoRoot)
    this.tracker = new ProcessTracker(path.join(repoRoot, '.agents', '.process_registry.json'))
  }

  private log(message: string): void {
    console.log(message)
    if (!this.runtimeWrites) return
    const file = path.join(this.repoRoot, '.agents', 'logs', 'orchestrator.log')
    try {
      if (fs.statSync(file, { throwIfNoEntry: false })?.size && fs.statSync(file).size >= 20 * 1024 * 1024) {
        for (let i = 5; i >= 1; i--) {
          const old = i === 1 ? file : `${file}.${i - 1}`
          if (fs.statSync(old, { throwIfNoEntry: false })) fs.renameSync(old, `${file}.${i}`)
        }
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
    } catch { console.error('Could not persist Swarm diagnostic log') }
  }

  private checkShutdown(): void {
    if (this.shutdownSignal) throw new ShutdownRequested()
  }

  private clearBlockers(item: string): void {
    for (const key of this.blockers) if (key.startsWith(`${item}:`)) this.blockers.delete(key)
  }

  private reportDispatchBlocker(ref: string, role: LifecycleRole, reason: string): void {
    const key = `${lifecycleItemKey(ref)}:${role}`
    // Cooldown deadlines are data; one fixed reason code owns each lifecycle's diagnostic slot.
    const code = reason.startsWith('provider cooldown') ? 'provider-cooldown'
      : reason.startsWith('exhausted') ? 'attempts-exhausted' : reason
    const value = `${ref}:${code}`
    if (this.dispatchBlockers.get(key) === value) return
    if (this.dispatchBlockers.size >= 4500) this.dispatchBlockers.delete(this.dispatchBlockers.keys().next().value!)
    this.dispatchBlockers.set(key, value)
    this.log(`${ref}: ${reason}`)
  }

  private clearDispatchBlockers(ref: string): void {
    this.clearDispatchItem(lifecycleItemKey(ref))
  }

  private clearDispatchItem(item: string): void {
    for (const key of this.dispatchBlockers.keys()) if (key.startsWith(`${item}:`)) this.dispatchBlockers.delete(key)
  }

  private reportFailure(item: string, version: string, error: unknown): void {
    const type = error instanceof Error ? error.constructor.name : 'UnknownError'
    // Finite category keys, never remote-derived error strings or credential-bearing subprocess output.
    const cause = error instanceof SwarmPreflightError ? (error as unknown as { causeCode?: string }).causeCode ?? type : type
    const key = `${item}:${version}:${type}:${cause}`
    if (this.blockers.has(key)) return
    if (this.blockers.size >= 4500) this.blockers.delete(this.blockers.values().next().value!)
    this.blockers.add(key)
    const detail = error instanceof SwarmPreflightError ? error.message
      : 'repair the configuration or inspect the local task log before retrying'
    this.log(`${item} blocked (${type}): ${detail}`)
  }

  private async enableRuntimeWrites(): Promise<void> {
    // Local excludes belong to this checkout, never to its shared committed .gitignore.
    const { execFile } = await import('node:child_process')
    const exclude = await new Promise<string>((resolve, reject) => {
      execFile('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: this.repoRoot, timeout: 60_000 },
        (error, stdout) => error ? reject(new Error('Could not locate local Git excludes')) : resolve(stdout.trim()))
    })
    if (!exclude) throw new Error('Git returned no local exclude path')
    const file = path.resolve(this.repoRoot, exclude)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let current = ''
    try { current = fs.readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const entries = ['/.worktrees/', '/.agents/logs/', '/.agents/.prompts/', '/.agents/.process_registry.json']
    const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry))
    if (missing.length) fs.appendFileSync(file, `${current.endsWith('\n') || !current ? '' : '\n'}${missing.join('\n')}\n`)
    for (const dir of ['logs', '.prompts']) {
      const directory = path.join(this.repoRoot, '.agents', dir)
      fs.mkdirSync(directory, { recursive: true })
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const candidate = path.join(directory, entry.name)
        if (fs.statSync(candidate).mtimeMs < Date.now() - 14 * 86400_000 && entry.name !== 'orchestrator.log') {
          fs.unlinkSync(candidate)
        }
      }
    }
    this.runtimeWrites = true
  }

  async run(): Promise<number> {
    if (this.options.status) { console.log(this.tracker.summary()); return 0 }
    if (this.options.reset && !this.options.dryRun) this.tracker.reset()
    const onSignal = (signal: NodeJS.Signals) => {
      this.shutdownSignal ??= signal
      this.sleepAbort?.abort()
    }
    const interrupt = () => onSignal('SIGINT')
    const terminate = () => onSignal('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    let exitCode = 0
    try {
      if (!this.options.dryRun && process.platform === 'win32') {
        throw new Error('Swarm dispatch requires isolated POSIX process groups')
      }
      await this.platform.bindOrigin(!this.options.dryRun)
      this.checkShutdown()
      if (!this.options.dryRun) {
        await this.platform.assertRepoWritable()
        this.checkShutdown()
        await this.enableRuntimeWrites()
      }
      let startupPreflightCompleted = !this.options.dryRun
      do {
        this.checkShutdown()
        try {
          const preflightCompleted = startupPreflightCompleted
          startupPreflightCompleted = false
          const failed = await this.cycle(preflightCompleted)
          if (failed) exitCode = 1
        } catch (error) {
          if (error instanceof ShutdownRequested) throw error
          this.reportFailure('Swarm', 'cycle', error)
          exitCode = 1
        }
        if (this.options.once) break
        this.sleepAbort = new AbortController()
        try { await delay((this.options.interval ?? 30) * 1000, undefined, { signal: this.sleepAbort.signal }) }
        catch (error) { if (!this.shutdownSignal) throw error }
        this.sleepAbort = undefined
      } while (!this.shutdownSignal)
    } catch (error) {
      if (!(error instanceof ShutdownRequested)) {
        this.reportFailure('Swarm', 'startup', error)
        exitCode = 1
      }
    } finally {
      // Successful --once runs drain owned children before reaching this final safety net.
      if (!this.options.dryRun && (this.runtimeWrites || this.tracker.active.size)) {
        try { if (!await this.tracker.killAll()) exitCode = 1 } catch { exitCode = 1 }
      }
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', terminate)
    }
    if (exitCode) return exitCode
    return this.shutdownSignal ? (this.shutdownSignal === 'SIGTERM' ? 143 : 130) : 0
  }

  async cycle(preflightCompleted = false): Promise<number> {
    this.checkShutdown()
    if (!this.options.dryRun) {
      await this.tracker.poll()
      if (!preflightCompleted) await this.platform.assertRepoWritable()
    }
    this.checkShutdown()
    this.cycles += 1
    if (this.cycles === 1 || this.cycles % 5 === 0) {
      try { await this.platform.syncMain(Boolean(this.options.dryRun)) } catch (error) { this.reportFailure('Swarm', 'sync', error) }
    }
    this.checkShutdown()
    // Both complete snapshots are required before any dispatch or closed-item pruning.
    const issues = await this.platform.json<SwarmIssue[]>(['issue', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,body'])
    const prs = await this.platform.json<SwarmPR[]>(['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,body,headRefName,headRefOid,isCrossRepository,isDraft'])
    if (!Array.isArray(issues) || !Array.isArray(prs)) throw new Error('Incomplete open item snapshot')
    this.checkShutdown()
    if (!this.options.dryRun) this.tracker.reconcileOpenItems(issues, prs)
    let failures = 0
    for (const issue of issues) {
      this.checkShutdown()
      try {
        const clear = await this.processIssue(issue, prs)
        if (clear) this.clearBlockers(`Issue#${issue?.number}`)
      } catch (error) {
        if (error instanceof ShutdownRequested) throw error
        failures += 1
        this.reportFailure(`Issue#${issue?.number ?? '?'}`, 'initial', error)
      }
    }
    let currentUser = ''
    if (prs.length) {
      try {
        const user = await this.platform.json<{ login?: string }>(['api', 'user'])
        if (typeof user.login !== 'string' || !user.login) throw new Error('No authenticated gh user')
        currentUser = user.login
      } catch (error) { failures += prs.length; this.reportFailure('PR batch', 'identity', error) }
    }
    if (currentUser) for (const pr of prs) {
      this.checkShutdown()
      try {
        const clear = await this.processPr(pr, currentUser)
        if (clear) this.clearBlockers(`PR#${pr?.number}`)
      } catch (error) {
        if (error instanceof ShutdownRequested) throw error
        failures += 1
        this.reportFailure(`PR#${pr?.number ?? '?'}`, pr?.headRefOid || 'initial', error)
      }
    }
    this.checkShutdown()
    if (this.options.once && !this.options.dryRun) {
      // Harvest children that finished during GitHub reads before normal one-shot shutdown. A
      // completed Maintainer must retain success even when its registry write fails; cleanup still
      // gets one independent pass, while any pending shutdown skips that pass below.
      try { failures += await this.drainChildren() } catch (error) {
        if (error instanceof ShutdownRequested) throw error
        failures += 1
        this.reportFailure('Swarm', 'post-cycle-harvest', error)
      }
    }
    this.checkShutdown()
    try { failures += await this.cleanupMerged() } catch (error) {
      if (error instanceof ShutdownRequested) throw error
      failures += 1
      this.reportFailure('Swarm', 'cleanup', error)
    }
    return failures
  }

  /** --once stops polling GitHub after one snapshot, but retains ownership until launched agents finish. */
  private async drainChildren(): Promise<number> {
    const owned = [...this.tracker.active.values()].map(({ record }) => record)
    do {
      this.checkShutdown()
      await this.tracker.poll()
      this.checkShutdown()
      if ([...this.tracker.active.values()].some(({ record }) => record.status === 'stuck')) return 1
      if (!this.tracker.active.size) break
      this.sleepAbort = new AbortController()
      try { await delay(50, undefined, { signal: this.sleepAbort.signal }) }
      catch (error) { if (!this.shutdownSignal) throw error }
      finally { this.sleepAbort = undefined }
    } while (this.tracker.active.size)
    return owned.some((record) => record.status !== 'completed') ? 1 : 0
  }

  async processIssue(issue: SwarmIssue, prs: SwarmPR[]): Promise<boolean> {
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number <= 0
      || typeof issue.title !== 'string' || typeof issue.body !== 'string') throw new Error('Malformed Issue snapshot item')
    if (!issue.title.startsWith('[Task]') || prs.some((pr) => issueNumberFromPrTitle(pr?.title) === issue.number)) {
      this.clearDispatchItem(`issue#${issue.number}`)
      return true
    }
    const worker = parseRole(issue.body, 'worker')
    if (!worker) { this.clearDispatchItem(`issue#${issue.number}`); return true }
    const ref = `issue#${issue.number}:initial`
    const [allowed, reason] = this.tracker.shouldDispatch(ref, 'worker', worker.ai)
    if (!allowed) { this.reportDispatchBlocker(ref, 'worker', reason); return !reason.startsWith('provider cooldown') }
    this.clearDispatchBlockers(ref)
    const slug = issue.title.split('-').at(-1)!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || `task-${issue.number}`
    const aiSlug = worker.ai.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'worker'
    const branch = `worker/${issue.number}-${aiSlug}-${slug}`
    const prompt = `You are the Worker for Issue #${issue.number}: ${issue.title}.\n`
      + `Read AGENTS.md, SKILL.md and .agents/rules/. Implement the Issue body:\n\n${issue.body}\n\n`
      + `Work in this directory. Commit changes with conventional commits referencing #${issue.number}.\n`
      + `Push using git push --set-upstream origin ${shellQuote(branch)}. Verify the remote push.\n`
      + `Create a PR titled '[PR] ${issue.number} - <summary>' containing a full [Reviewer: <ai> | Model: <model> | Reasoning: <level>] tag.\n`
      + `Reviewer MUST differ from Worker '${worker.ai}'. Include decisions and verification evidence.\n${integrityNotice}`
    await this.dispatch('worker', worker, ref, branch, prompt, issue.number)
    return true
  }

  async processPr(pr: SwarmPR, currentUser: string): Promise<boolean> {
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0
      || typeof pr.title !== 'string' || typeof pr.body !== 'string') throw new Error('Malformed PR snapshot item')
    const issueNumber = issueNumberFromPrTitle(pr.title)
    const reviewer = parseRole(pr.body, 'reviewer')
    if (!issueNumber || !reviewer) { this.clearDispatchItem(`pr#${pr.number}`); return true }
    const issue = await this.platform.json<SwarmIssue>(['issue', 'view', String(issueNumber), '--json', 'number,title,body'])
    const worker = parseRole(issue.body, 'worker')
    const terminal = () => { this.clearDispatchItem(`pr#${pr.number}`); return true }
    if (!worker) return terminal()
    const comments = await this.fetchPrComments(pr.number)
    const signal = determinePrAction(trustedComments(comments, currentUser))
    const maintainer = signal.comment ? parseRole(signal.comment.body, 'maintainer') : undefined
    validateDistinctRoles(worker, reviewer)
    let role: LifecycleRole
    let assignment: RoleAssignment
    let ref: string
    let prompt: string
    const common = `Read AGENTS.md, SKILL.md and .agents/rules/. PR #${pr.number}: ${pr.title}; Issue #${issue.number}.\n`
    if (signal.action === 'maintain') {
      const approvingReviewer = parseRole(signal.comment!.body, 'reviewer')
      if (!maintainer || approvingReviewer?.ai !== reviewer.ai) return terminal()
      validateDistinctRoles(worker, reviewer, maintainer)
      role = 'maintainer'; assignment = maintainer; ref = `maintain#${pr.number}-${signal.id}`
      prompt = `You are the Maintainer and post-merge Analyst. ${common}`
        + `Verify independent review and passing CI. Check gh pr view ${pr.number} --json isDraft; if Draft, execute gh pr ready ${pr.number}, then recheck merge state and CI.\n`
        + `Merge PR #${pr.number}, verify success, then close Issue #${issue.number}.\n`
        + `Post your metadata ${tag('Maintainer', maintainer)} with merge rationale and verification.\n`
        + `If blocked, post that metadata and an exact '[Maintainer Blocked]' line with classification and reproducible evidence. Do not retry, close the Issue, or create a follow-up.\n`
        + `Only after verified merge, inspect open Issues and create exactly ONE non-duplicate '[Task] <Tool Name> - <Summary>' Issue with acceptance criteria and a full Worker tag. Do not implement it. The orchestrator owns worktree cleanup.\n`
    } else if (signal.action === 'review' || signal.action === 'review_after_maintainer_block') {
      if (signal.action === 'review_after_maintainer_block') {
        if (!maintainer) return terminal()
        validateDistinctRoles(worker, reviewer, maintainer)
      }
      role = 'reviewer'; assignment = reviewer
      ref = `review#${pr.number}-${signal.action === 'review_after_maintainer_block' ? `maintainer-block-${signal.id}` : pr.headRefOid || signal.id}`
      // Avoid spending diff API calls on an event already dispatched.
      const [allowed, reason] = this.tracker.shouldDispatch(ref, role, assignment.ai)
      if (!allowed) { this.reportDispatchBlocker(ref, role, reason); return !reason.startsWith('provider cooldown') }
      this.clearDispatchBlockers(ref)
      const diff = await this.platform.gh(['pr', 'diff', String(pr.number)])
      prompt = `You are the Reviewer. ${common}`
        + (signal.action === 'review_after_maintainer_block' ? `A Maintainer blocked the PR. Re-evaluate the block evidence:\n${signal.comment!.body}\n` : '')
        + `Review the changed code and verification evidence. Post exactly ONE final summary comment with ${tag('Reviewer', reviewer)}.\n`
        + `If approved and ready to merge, explicitly say approved and include [Maintainer: <ai> | Model: <model> | Reasoning: <level>]. Maintainer MUST differ from Worker '${worker.ai}' and Reviewer '${reviewer.ai}'.\n`
        + `If changes are required, describe them clearly and omit the Maintainer tag.\n\n${reviewerContext(pr, diff)}\n`
    } else {
      if (parseRole(signal.comment!.body, 'reviewer')?.ai !== reviewer.ai) return terminal()
      // Fork ownership is never inferred from an absent/unknown boolean.
      if (pr.isCrossRepository !== false || !pr.headRefName || !pr.headRefOid) return terminal()
      role = 'worker_revise'; assignment = worker; ref = `revise#${pr.number}-${signal.id}`
      prompt = `You are the original Worker revising the PR. ${common}`
        + `Address this trusted Reviewer feedback:\n\n${signal.comment!.body}\n\n`
        + `Verify the current branch and latest origin/main. Preserve existing work. Make required changes, commit and push using git push --set-upstream origin ${shellQuote(pr.headRefName)}.\n`
        + `Verify the remote SHA before posting exactly '[Worker] Revision complete.' to PR #${pr.number}. A rejected push is a failure, never a completed revision.\n`
    }
    const [allowed, reason] = this.tracker.shouldDispatch(ref, role, assignment.ai)
    if (!allowed) { this.reportDispatchBlocker(ref, role, reason); return !reason.startsWith('provider cooldown') }
    this.clearDispatchBlockers(ref)
    await this.dispatch(role, assignment, ref, pr.headRefName, `${prompt}\n${integrityNotice}`,
      role === 'worker_revise' ? issue.number : undefined, role === 'worker_revise' ? pr : undefined)
    return true
  }

  /**
   * The CLI's `pr view --json comments` omits authorAssociation. Read the full paginated REST
   * comments instead, retaining the association GitHub supplied and preserving chronological order.
   * A failed or malformed page is incomplete observation, never evidence that no review exists.
   */
  async fetchPrComments(prNumber: number): Promise<SwarmComment[]> {
    const pages = await this.platform.json<unknown>(['api', '--paginate', '--slurp',
      `repos/{owner}/{repo}/issues/${prNumber}/comments?per_page=100`])
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new SwarmPreflightError('Incomplete paginated PR comment observation')
    }
    const comments: SwarmComment[] = []
    for (const page of pages) for (const value of page) {
      if (!value || typeof value !== 'object' || typeof value.body !== 'string'
        || !['string', 'number'].includes(typeof value.id)) {
        throw new SwarmPreflightError('Malformed PR comment observation')
      }
      comments.push({ id: value.id, body: value.body,
        url: typeof value.html_url === 'string' ? value.html_url : undefined,
        author: typeof value.user?.login === 'string' ? { login: value.user.login } : undefined,
        authorAssociation: typeof value.author_association === 'string' ? value.author_association : undefined,
      })
    }
    return comments
  }

  private async dispatch(
    role: LifecycleRole, raw: RoleAssignment, ref: string, branch: string, prompt: string,
    issueNumber?: number, pr?: SwarmPR,
  ): Promise<void> {
    this.checkShutdown()
    let assignment = raw
    let cwd = this.repoRoot
    let logFile = ''
    const record: TrackedProcess = {
      pid: null, role, ai_name: assignment.ai, model: assignment.model, reasoning: assignment.reasoning,
      task_ref: ref, branch, command: '', cwd, log_file: '', started_at: new Date().toISOString(), status: 'running',
    }
    let adopted = false
    try {
      assignment = resolveRoleAssignment(raw, role)
      record.ai_name = assignment.ai
      record.model = assignment.model
      record.reasoning = assignment.reasoning
      if (issueNumber !== undefined) {
        if (!this.options.dryRun) {
          await this.platform.assertRepoWritable()
          const verifiedHead = pr ? await this.platform.fetchPrHead(pr.number, pr.headRefOid) : undefined
          this.checkShutdown()
          cwd = await this.platform.createWorktree(issueNumber, branch, verifiedHead)
        } else cwd = path.join(this.repoRoot, '.worktrees', String(issueNumber))
      }
      record.cwd = cwd
      const argv = buildAiArgv(assignment, prompt, role === 'worker' || role === 'worker_revise', cwd)
      record.command = argv[0] ?? ''
      if (this.options.dryRun) { this.log(`[DRY RUN] Would dispatch ${role} ${ref} using ${assignment.ai} (${assignment.model}, ${assignment.reasoning}) in ${cwd}`); return }
      await this.platform.assertRepoWritable()
      const env = await this.platform.prepareDispatch(cwd, issueNumber !== undefined ? branch : undefined)
      this.checkShutdown()
      const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`
      const safeRef = ref.replace(/[^a-zA-Z0-9._-]+/g, '-')
      logFile = path.join(this.repoRoot, '.agents', 'logs', `${role}-${safeRef}-${suffix}.log`)
      record.log_file = logFile
      const promptFile = path.join(this.repoRoot, '.agents', '.prompts', `${role}-${safeRef}-${suffix}.md`)
      fs.writeFileSync(promptFile, prompt, { flag: 'wx', mode: 0o600 })
      const fd = fs.openSync(logFile, 'wx', 0o600)
      let child: ChildProcess
      try {
        // There is intentionally no await between spawn and adopt. JS signal callbacks cannot
        // interrupt this synchronous ownership window, including failures in adoption itself.
        child = this.spawnProcess(argv[0], argv.slice(1), { cwd, env, shell: false, detached: true, stdio: ['pipe', fd, fd] })
        child.on('error', () => { /* Spawn failure is recorded by the synchronous pid guard below. */ })
        child.stdin?.on('error', () => {})
        try { this.tracker.adopt(child, record); adopted = true } catch (error) {
          // A rare adoption failure still leaves the child supervised before any asynchronous cleanup.
          if (child.pid) {
            record.pid = child.pid
            this.tracker.active.set(child.pid, { child, record })
            adopted = true
          }
          throw error
        }
      } finally { fs.closeSync(fd) }
      this.tracker.save()
      this.sleepAbort = new AbortController()
      const promptDeadline = setTimeout(() => this.sleepAbort?.abort(), 60_000)
      try { await sendPrompt(child, prompt, this.sleepAbort.signal) }
      catch (error) { this.checkShutdown(); throw error }
      finally { clearTimeout(promptDeadline); this.sleepAbort = undefined }
      this.checkShutdown()
      this.log(`Dispatched ${role} ${ref}: ${assignment.ai}, ${assignment.model}, ${assignment.reasoning}; log ${path.basename(logFile)}`)
    } catch (error) {
      if (adopted) {
        // Persist temporary running ownership before bounded termination, then removal/stuck state.
        try { this.tracker.save() } catch { /* Retry after cleanup below. */ }
        await this.tracker.killAll(record.pid ? [record.pid] : [])
      } else if (!this.options.dryRun && !(error instanceof SwarmPreflightError) && !(error instanceof ShutdownRequested)) {
        this.tracker.recordFailure(record)
      }
      throw error
    }
  }

  private async cleanupMerged(): Promise<number> {
    const merged = await this.platform.json<SwarmPR[]>(['pr', 'list', '--state', 'merged', '--limit', '20', '--json', 'number,title,headRefName'])
    if (!Array.isArray(merged)) throw new Error('Invalid merged PR snapshot')
    let failures = 0
    for (const pr of merged) {
      this.checkShutdown()
      const issue = issueNumberFromPrTitle(pr.title)
      if (!issue) continue
      // A just-merged PR may still have an owned child or residual process tree. Never remove its
      // checkout while that tree can resume writing, even if the directory is clean at this instant.
      if ([...this.tracker.states.values()].some(({ record }) =>
        (record.status === 'running' || record.status === 'stuck') && record.branch === pr.headRefName)) continue
      try {
        const state = await this.platform.json<{ state: string }>(['issue', 'view', String(issue), '--json', 'state'])
        this.checkShutdown()
        if (state.state === 'OPEN' && !this.options.dryRun) {
          await this.platform.assertRepoWritable()
          this.checkShutdown()
          await this.platform.gh(['issue', 'close', String(issue)])
        }
      } catch (error) {
        if (error instanceof ShutdownRequested) throw error
        failures += 1
        this.reportFailure(`Issue#${issue}`, 'close', error)
      }
      this.checkShutdown()
      if (pr.headRefName && !this.options.dryRun) {
        try { await this.platform.cleanupWorktree(issue, pr.headRefName) }
        catch (error) { failures += 1; this.reportFailure(`Issue#${issue}`, 'cleanup-worktree', error) }
      }
    }
    return failures
  }
}

class ShutdownRequested extends Error {}

/** Native entry point bundled directly into the standalone CLI; requires no Python asset. */
export async function runSwarmEngine(repoRoot: string, options: SwarmRunOptions): Promise<number> {
  return new SwarmEngine(repoRoot, options).run()
}
