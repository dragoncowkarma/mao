import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { spawn as nativeSpawn } from 'node:child_process'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  determinePrAction, issueNumberFromPrTitle, reviewerContext, SwarmEngine, trustedComments,
  ONCE_DRAIN_TIMEOUT_MS, PROJECT_RULES_INSTRUCTION, SWARM_REFERENCE_DOC,
} from './engine.ts'
import type { EnginePlatform, SwarmComment, SwarmIssue, SwarmPR } from './engine.ts'
import { SwarmPreflightConfigError } from './platform.ts'
import { processGroupExists, terminateProcessGroups } from './registry.ts'

const WORKER = '[Worker: claude | Model: claude-sonnet-5 | Reasoning: high]'
const REVIEWER = '[Reviewer: codex | Model: gpt-5.6-sol | Reasoning: high]'
const MAINTAINER = '[Maintainer: antigravity | Model: gemini-3.8-flash | Reasoning: high]'
const issue: SwarmIssue = { number: 7, title: '[Task] Test - lifecycle', body: WORKER }
const pr: SwarmPR = { number: 42, title: '[PR] 7 - lifecycle', body: REVIEWER,
  headRefName: 'worker/7-test', headRefOid: 'a'.repeat(40), isCrossRepository: false }
const comment = (body: string, changes: Partial<SwarmComment> = {}): SwarmComment =>
  ({ id: 'IC_123', body, author: { login: 'outsider' }, authorAssociation: 'OWNER', ...changes })
const restPages = (...comments: SwarmComment[]) => [comments.map((entry) => ({
  id: entry.id, body: entry.body, user: entry.author, author_association: entry.authorAssociation,
  html_url: entry.url,
}))]
const dirs: string[] = []
function fixture(dryRun = true): { engine: SwarmEngine, platform: EnginePlatform, root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-swarm-engine-'))
  dirs.push(root)
  const platform: EnginePlatform = {
    bindOrigin: vi.fn(async () => ({})), assertRepoWritable: vi.fn(async () => ({})),
    prepareDispatch: vi.fn(async () => ({})), createWorktree: vi.fn(async () => root),
    fetchPrHead: vi.fn(async (_number, sha) => sha), cleanupWorktree: vi.fn(async () => {}),
    syncMain: vi.fn(async () => {}), gh: vi.fn(async () => 'diff content'),
    json: vi.fn(async (args: string[]) => {
      if (args[0] === 'issue' && args[1] === 'list') return []
      if (args[0] === 'pr' && args[1] === 'list') return []
      if (args[0] === 'api') return args.includes('user') ? { login: 'operator' } : [[]]
      if (args[0] === 'issue') return issue
      if (args[0] === 'pr') return [[]]
      throw new Error('Unhandled fake API call')
    }) as EnginePlatform['json'],
  }
  return { engine: new SwarmEngine(root, { dryRun, once: true }, platform), platform, root }
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('lifecycle signal and trust boundaries', () => {
  it.each([
    ['[PR] 7 - title', 7], [' [PR] 42 task', 42], ['fix #7', undefined], ['[Task] 7', undefined],
    ['[PR] 0 title', undefined], ['[PR] 99999999999999999999 title', undefined],
  ])('recognizes only an explicit valid PR task title: %s', (title, expected) => expect(issueNumberFromPrTitle(title)).toBe(expected))

  it.each(['OWNER', 'COLLABORATOR', 'MEMBER'])('trusts %s associations', (authorAssociation) => {
    expect(trustedComments([comment('feedback', { authorAssociation })], 'operator')).toHaveLength(1)
  })
  it.each([undefined, 'NONE', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR'])('fails closed for %s author association', (authorAssociation) => {
    expect(trustedComments([comment('feedback', { authorAssociation })], 'operator')).toHaveLength(0)
  })
  it('trusts the authenticated gh user but rejects every comment if identity is unavailable', () => {
    const own = comment('feedback', { author: { login: 'operator' }, authorAssociation: undefined })
    expect(trustedComments([own], 'operator')).toEqual([own])
    expect(trustedComments([own], '')).toEqual([])
  })
  it('rejects trusted-looking associations without an author login', () => {
    expect(trustedComments([comment('feedback', { author: undefined })], 'operator')).toEqual([])
    expect(trustedComments([comment('feedback', { author: { login: '' } })], 'operator')).toEqual([])
  })

  it.each(['not approved', 'changes requested', 'needs further changes', 'conditionally approved', 'conditional approval', '수정 필요',
    'Approved once CI passes', 'not yet approved', 'needs fixes', 'not ready', 'LGTM if tests pass',
    'unapproved', 'disapproved', 'cannot approve', "won't approve", "doesn't approve", "didn't approve",
    'is not approved', 'non-lgtm', 'no LGTM', 'never approve', 'changes are still required',
    'fixes are needed', 'revision is required', 'requesting changes', 'requires further changes',
    'approved conditionally'])('never treats %s as approval despite Maintainer metadata', (negative) => {
    expect(determinePrAction([comment(`${REVIEWER}\n${MAINTAINER}\n${negative}`)]).action).toBe('revise')
  })
  it('requires both role tags before assigning a Maintainer and uses the newest recognized signal', () => {
    expect(determinePrAction([comment(MAINTAINER)]).action).toBe('review')
    expect(determinePrAction([comment(`${REVIEWER}\nApproved\n${MAINTAINER}`)]).action).toBe('maintain')
    const revision = comment('[Worker] Revision complete.', { id: 'next' })
    expect(determinePrAction([comment(REVIEWER), revision, comment('unrelated note')])).toMatchObject({ action: 'review', id: 'next' })
  })
  it('returns Maintainer blocks to the reviewer using a distinct event version', () => {
    expect(determinePrAction([comment(`${MAINTAINER}\n[Maintainer Blocked] CI failed`)])).toMatchObject({ action: 'review_after_maintainer_block', id: 'IC_123' })
  })
  it('bounds injected reviewer diff and explicitly marks truncation', () => {
    const context = reviewerContext(pr, 'a'.repeat(50_001))
    expect(context).toContain('Diff truncated after 50,000')
    expect(context).not.toContain('a'.repeat(50_001))
    expect(reviewerContext(pr, 'small diff')).not.toContain('truncated')
  })
})

describe('native scheduler', () => {
  it('fetches all REST comment pages and preserves author associations and event ids', async () => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockResolvedValue([
      [{ id: 17, body: REVIEWER, user: { login: 'collaborator' }, author_association: 'COLLABORATOR' }],
      [{ id: 18, body: '[Worker] Revision complete.', user: { login: 'operator' }, author_association: 'NONE' }],
    ] as never)
    const comments = await engine.fetchPrComments(42)
    expect(platform.json).toHaveBeenCalledWith(['api', '--paginate', '--slurp',
      'repos/{owner}/{repo}/issues/42/comments?per_page=100'])
    expect(comments.map((entry) => entry.id)).toEqual([17, 18])
    expect(comments[0].authorAssociation).toBe('COLLABORATOR')
    expect(trustedComments(comments, 'operator')).toHaveLength(2)
    expect(determinePrAction(comments)).toMatchObject({ action: 'review', id: '18' })
  })
  it.each([{}, [null], [[{ id: 1 }]], [[{ body: REVIEWER }]]])('refuses malformed paginated comment observations', async (pages) => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockResolvedValue(pages as never)
    await expect(engine.fetchPrComments(42)).rejects.toThrow()
  })
  function dispatchFixture() {
    const base = fixture(false)
    fs.mkdirSync(path.join(base.root, '.agents', 'logs'), { recursive: true })
    fs.mkdirSync(path.join(base.root, '.agents', '.prompts'), { recursive: true })
    let prompt = ''
    const stdin = new Writable({ write(chunk, _encoding, done) { prompt += chunk.toString(); done() } })
    const child = Object.assign(new EventEmitter(), { pid: 888001, exitCode: null, signalCode: null, stdin }) as ChildProcess
    const spawnProcess = vi.fn(() => child)
    const engine = new SwarmEngine(base.root, { once: true }, base.platform, spawnProcess as unknown as typeof spawn)
    return { ...base, engine, child, spawnProcess, prompt: () => prompt }
  }
  it.each(['worker', 'reviewer', 'maintainer', 'worker_revise'] as const)(
    'routes the actual %s dispatch through AGENTS.md and conditionally names the review reference',
    async (role) => {
      const { engine, platform, spawnProcess, prompt } = dispatchFixture()
      vi.mocked(platform.json).mockImplementation(async (args) => {
        if (args[0] === 'issue') return issue as never
        const comments = role === 'maintainer' ? [comment(`${REVIEWER}\nApproved\n${MAINTAINER}`)]
          : role === 'worker_revise' ? [comment(`${REVIEWER}\nChanges requested`)] : []
        return restPages(...comments) as never
      })
      try {
        if (role === 'worker') await engine.processIssue(issue, [])
        else await engine.processPr(pr, 'operator')
        expect(spawnProcess).toHaveBeenCalledTimes(1)
        const [command, args] = spawnProcess.mock.calls[0] as unknown as [string, string[]]
        const actual = command === 'agy' ? args.at(-1)! : prompt()
        expect(actual).toContain(PROJECT_RULES_INSTRUCTION)
        expect(actual).toContain('follow its routing to any further rule or reference files this task touches')
        expect(actual).not.toContain('.agents/rules')
        expect(actual).not.toContain('SKILL.md')
        if (role === 'reviewer') {
          expect(actual).toContain(`If this checkout has ${SWARM_REFERENCE_DOC}`)
          expect(actual).toContain("'Review checklist'")
          expect(actual).toContain("'Role assignment'")
        } else expect(actual).not.toContain(SWARM_REFERENCE_DOC)
      } finally { await engine.tracker.killAll() }
    },
  )
  it('registers the isolated child with writer permission only for a Worker', async () => {
    const { engine, spawnProcess } = dispatchFixture()
    await engine.processIssue(issue, [])
    expect(spawnProcess).toHaveBeenCalledWith('claude', expect.arrayContaining(['--dangerously-skip-permissions']),
      expect.objectContaining({ shell: false, detached: true }))
    expect(engine.tracker.active.size).toBe(1)
    expect(new SwarmEngine(engine.repoRoot, {}).tracker.shouldDispatch('issue#7:initial', 'worker')[0]).toBe(false)
    await engine.tracker.killAll()
  })
  it('binds the actual revision worktree and verifies the PR head before granting writer tools', async () => {
    const { engine, platform, spawnProcess } = dispatchFixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue') return issue as never
      return restPages(comment(REVIEWER)) as never
    })
    await engine.processPr(pr, 'operator')
    expect(platform.fetchPrHead).toHaveBeenCalledWith(42, pr.headRefOid)
    expect(platform.createWorktree).toHaveBeenCalledWith(7, pr.headRefName, pr.headRefOid)
    expect(platform.prepareDispatch).toHaveBeenCalledWith(engine.repoRoot, pr.headRefName)
    expect(spawnProcess).toHaveBeenCalledWith('claude', expect.arrayContaining(['--effort', 'medium']), expect.anything())
    await engine.tracker.killAll()
  })
  it('keeps the Reviewer read-only and injects the PR diff and description', async () => {
    const { engine, platform, spawnProcess, prompt } = dispatchFixture()
    await engine.processPr(pr, 'operator')
    expect(spawnProcess).toHaveBeenCalledWith('codex', expect.arrayContaining(['-s', 'read-only']), expect.anything())
    const args = spawnProcess.mock.calls[0] as unknown as [string, string[]]
    expect(prompt()).toContain('diff content')
    expect(prompt()).toContain(pr.body)
    expect(args[1].join(' ')).not.toContain('diff content')
    expect(platform.prepareDispatch).toHaveBeenCalledWith(engine.repoRoot, undefined)
    await engine.tracker.killAll()
  })
  it('keeps Maintainer sandboxed and includes Draft-ready and merge verification instructions', async () => {
    const { engine, platform, spawnProcess, prompt } = dispatchFixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue') return issue as never
      return restPages(comment(`${REVIEWER}\nApproved\n${MAINTAINER}`)) as never
    })
    await engine.processPr(pr, 'operator')
    const args = spawnProcess.mock.calls[0] as unknown as [string, string[]]
    expect(args[0]).toBe('agy')
    expect(args[1]).toContain('--sandbox')
    expect(args[1].at(-1)).toContain('gh pr ready 42')
    expect(args[1].at(-1)).toContain('passing CI')
    expect(prompt()).toBe('')
    expect(spawnProcess.mock.calls[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ stdio: ['ignore', expect.any(Number), expect.any(Number)] }),
    ]))
    await engine.tracker.killAll()
  })
  it('rejects approval from a different Reviewer even when actual Worker/Reviewer/Maintainer roles are distinct', async () => {
    const { engine, platform, spawnProcess } = dispatchFixture()
    const wrongReviewer = REVIEWER.replace('codex', 'antigravity')
    vi.mocked(platform.json).mockImplementation(async (args) => args[0] === 'issue'
      ? issue as never : restPages(comment(`${wrongReviewer}\nApproved\n${MAINTAINER}`)) as never)
    await engine.processPr(pr, 'operator')
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(platform.prepareDispatch).not.toHaveBeenCalled()
  })
  it('rejects mismatched Reviewer feedback on a same-repository PR before fetching or revising its head', async () => {
    const { engine, platform, spawnProcess } = dispatchFixture()
    const wrongReviewer = REVIEWER.replace('codex', 'antigravity')
    vi.mocked(platform.json).mockImplementation(async (args) => args[0] === 'issue'
      ? issue as never : restPages(comment(`${wrongReviewer}\nChanges requested`)) as never)
    await engine.processPr({ ...pr, isCrossRepository: false }, 'operator')
    expect(platform.fetchPrHead).not.toHaveBeenCalled()
    expect(platform.createWorktree).not.toHaveBeenCalled()
    expect(spawnProcess).not.toHaveBeenCalled()
  })
  it('uses the trusted approval body after a later untrusted approval names a different Maintainer', async () => {
    const { engine, platform, spawnProcess } = dispatchFixture()
    vi.mocked(platform.json).mockImplementation(async (args) => args[0] === 'issue' ? issue as never
      : restPages(comment(`${REVIEWER}\nApproved\n${MAINTAINER}`, { id: 'trusted' }),
        comment(`${REVIEWER}\nApproved\n${MAINTAINER.replace('antigravity', 'claude')}`,
          { id: 'untrusted', authorAssociation: 'NONE' })) as never)
    await engine.processPr(pr, 'operator')
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    const args = spawnProcess.mock.calls[0] as unknown as [string, string[]]
    expect(args[0]).toBe('agy')
    expect(engine.tracker.active.get(888001)?.record.task_ref).toBe('maintain#42-trusted')
    await engine.tracker.killAll()
  })
  it('does not index back into unfiltered comments when selecting Maintainer metadata', async () => {
    const { engine, platform, spawnProcess } = dispatchFixture()
    vi.mocked(platform.json).mockImplementation(async (args) => args[0] === 'issue' ? issue as never
      : restPages(comment(`${REVIEWER}\nApproved\n${MAINTAINER.replace('antigravity', 'claude')}`,
          { id: 'untrusted', authorAssociation: 'NONE' }),
        comment(`${REVIEWER}\nApproved\n${MAINTAINER}`, { id: 'trusted' })) as never)
    await engine.processPr(pr, 'operator')
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect((spawnProcess.mock.calls[0] as unknown as [string])[0]).toBe('agy')
    expect(engine.tracker.active.get(888001)?.record.task_ref).toBe('maintain#42-trusted')
    await engine.tracker.killAll()
  })
  it('consumes selected setup failures but leaves typed preflight blockers retryable', async () => {
    const { engine, platform, spawnProcess } = dispatchFixture()
    vi.mocked(platform.createWorktree).mockRejectedValue(new SwarmPreflightConfigError('configuration blocker'))
    await expect(engine.processIssue(issue, [])).rejects.toThrow('configuration blocker')
    expect(engine.tracker.states.size).toBe(0)
    expect(spawnProcess).not.toHaveBeenCalled()
    vi.mocked(platform.createWorktree).mockRejectedValue(new Error('setup failed'))
    for (let i = 0; i < 3; i++) await expect(engine.processIssue(issue, [])).rejects.toThrow('setup failed')
    expect(engine.tracker.shouldDispatch('issue#7:initial', 'worker')[1]).toContain('exhausted 3')
  })
  it('records a failed spawn without leaving a running authority record', async () => {
    const { engine, spawnProcess, child } = dispatchFixture()
    Object.assign(child, { pid: undefined })
    await expect(engine.processIssue(issue, [])).rejects.toThrow('isolated process group')
    expect(engine.tracker.active.size).toBe(0)
    expect(engine.tracker.history.at(-1)?.status).toBe('failed')
    expect(spawnProcess).toHaveBeenCalledTimes(1)
  })
  it('bounds unsupported-provider setup failures instead of retrying them forever', async () => {
    const { engine, spawnProcess } = dispatchFixture()
    const unsupported = { ...issue, body: WORKER.replace('claude', 'unsupported') }
    for (let i = 0; i < 3; i++) await expect(engine.processIssue(unsupported, [])).rejects.toThrow()
    expect(engine.tracker.shouldDispatch('issue#7:initial', 'worker')[1]).toContain('exhausted 3')
    expect(spawnProcess).not.toHaveBeenCalled()
  })
  it('harvests one-shot children before merged cleanup, even when harvest persistence fails', async () => {
    const { engine, platform } = dispatchFixture()
    const sequence: string[] = []
    const poll = vi.spyOn(engine.tracker, 'poll').mockResolvedValueOnce().mockImplementationOnce(async () => {
      sequence.push('harvest')
      throw new Error('save failed')
    })
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args.includes('merged')) sequence.push('merged cleanup')
      return [] as never
    })
    expect(await engine.cycle()).toBe(1)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(sequence).toEqual(['harvest', 'merged cleanup'])
  })
  it('supervises the child when registration persistence fails after adoption', async () => {
    const { engine } = dispatchFixture()
    const save = vi.spyOn(engine.tracker, 'save').mockImplementationOnce(() => { throw new Error('I/O failure') })
    await expect(engine.processIssue(issue, [])).rejects.toThrow('I/O failure')
    expect(engine.tracker.active.size).toBe(0)
    expect(engine.tracker.history.at(-1)?.status).toBe('failed')
    expect(save.mock.calls.length).toBeLessThanOrEqual(3)
  })
  it('streams a large Unicode prompt to a real child and drains --once to genuine completion', async () => {
    const { root, platform } = dispatchFixture()
    const body = `${WORKER}\n${'한글🦊'.repeat(100_000)}`
    const output = path.join(root, 'received.txt')
    const spawnProcess: typeof nativeSpawn = ((_command: string, args: string[], options: object) => {
      expect(args.join(' ')).not.toContain('한글')
      return nativeSpawn(process.execPath, ['-e',
        'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>setTimeout(()=>require("fs").writeFileSync(process.argv[1],s),80))', output],
      { ...options, env: process.env })
    }) as typeof nativeSpawn
    vi.mocked(platform.json).mockImplementation(async (args) => args[0] === 'issue' && args[1] === 'list'
      ? [{ ...issue, body }] as never : [] as never)
    const engine = new SwarmEngine(root, { once: true }, platform, spawnProcess)
    expect(await engine.cycle()).toBe(0)
    expect(fs.readFileSync(output, 'utf8')).toContain(body)
    expect(engine.tracker.active.size).toBe(0)
    expect(engine.tracker.history.at(-1)?.status).toBe('completed')
    expect([...engine.tracker.states.values()][0].failure_count).toBe(0)
  })
  it('bounds the total once wait and returns nonzero after terminating owned groups', async () => {
    const { engine, platform, child } = dispatchFixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue' && args[1] === 'list') return [issue] as never
      return [] as never
    })
    vi.spyOn(engine as unknown as { enableRuntimeWrites(): Promise<void> }, 'enableRuntimeWrites').mockResolvedValue()
    let clock = 0
    vi.spyOn(engine.tracker, 'poll').mockImplementation(async () => {
      if (engine.tracker.active.size) {
        if (clock === ONCE_DRAIN_TIMEOUT_MS) throw new Error('poll continued beyond the child wait limit')
        clock = ONCE_DRAIN_TIMEOUT_MS
      }
    })
    const kill = vi.spyOn(engine.tracker, 'killAll').mockImplementation(async () => {
      Object.assign(child, { exitCode: 1 })
      engine.tracker.active.clear()
      return true
    })
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(engine.run()).resolves.toBe(1)
    expect(kill).toHaveBeenCalled()
    expect(engine.tracker.active.size).toBe(0)
    expect(log.mock.calls.flat().join(' ')).toContain('wait exceeded 45 minutes')
  })

  it('terminates a real non-finishing child at the once wait limit', async () => {
    const { root, platform } = dispatchFixture()
    let child: ChildProcess | undefined
    const spawnProcess = ((_command: string, _args: string[], options: object) => {
      child = nativeSpawn(process.execPath, ['-e',
        'process.stdin.resume();process.stdin.on("end",()=>setInterval(()=>{},1000))'], options)
      return child
    }) as typeof nativeSpawn
    const engine = new SwarmEngine(root, { once: true }, platform, spawnProcess)
    vi.spyOn(engine as unknown as { enableRuntimeWrites(): Promise<void> }, 'enableRuntimeWrites').mockResolvedValue()
    vi.mocked(platform.json).mockImplementation(async (args) => args[0] === 'issue' && args[1] === 'list'
      ? [issue] as never : [] as never)
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const poll = engine.tracker.poll.bind(engine.tracker)
    vi.spyOn(engine.tracker, 'poll').mockImplementation(async () => {
      await poll()
      if (engine.tracker.active.size) clock = ONCE_DRAIN_TIMEOUT_MS
    })
    try {
      expect(await engine.run()).toBe(1)
      expect(child?.pid).toBeDefined()
      expect(processGroupExists(child!.pid!)).toBe(false)
      expect(engine.tracker.active.size).toBe(0)
      expect(engine.tracker.history.at(-1)?.status).toBe('failed')
    } finally {
      if (child?.pid) await terminateProcessGroups([child.pid], 0)
    }
  })

  it('handles prompt-pipe errors under supervision without leaving a live child or unhandled error', async () => {
    const { engine, child } = dispatchFixture()
    Object.assign(child, { stdin: new Writable({ write(_chunk, _encoding, done) {
      done(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    } }) })
    await expect(engine.processIssue(issue, [])).rejects.toThrow('Could not deliver AI prompt')
    expect(engine.tracker.active.size).toBe(0)
    expect(engine.tracker.history.at(-1)?.status).toBe('failed')
  })
  it.each([0, 500_000])('shuts down a supervised real child while draining or delivering %i Unicode repetitions', async (repetitions) => {
    const { root, platform } = dispatchFixture()
    const body = `${WORKER}\n${'한글'.repeat(repetitions)}`
    let child: ChildProcess | undefined
    const spawnProcess = ((_command: string, _args: string[], options: object) => {
      child = nativeSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, env: process.env })
      setTimeout(() => process.emit('SIGINT'), 100)
      return child
    }) as typeof nativeSpawn
    vi.mocked(platform.json).mockImplementation(async (args) => args[0] === 'issue' && args[1] === 'list'
      ? [{ ...issue, body }] as never : [] as never)
    const engine = new SwarmEngine(root, { once: true }, platform, spawnProcess)
    vi.spyOn(engine as unknown as { enableRuntimeWrites(): Promise<void> }, 'enableRuntimeWrites').mockResolvedValue()
    const started = Date.now()
    expect(await engine.run()).toBe(130)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(child?.pid).toBeTruthy()
    expect(engine.tracker.active.size).toBe(0)
    expect(platform.json).not.toHaveBeenCalledWith(expect.arrayContaining(['merged']))
  })
  it('bounds a prompt delivery when the child never reads stdin', async () => {
    const { engine, child } = dispatchFixture()
    Object.assign(child, { stdin: new Writable({ write() { /* Deliberately never acknowledge input. */ } }) })
    vi.useFakeTimers()
    try {
      const failure = engine.processIssue(issue, []).then(() => undefined, (error: unknown) => error)
      await vi.waitFor(() => expect(engine.tracker.active.size).toBe(1))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await failure).toEqual(expect.objectContaining({ message: expect.stringContaining('deadline') }))
      expect(engine.tracker.active.size).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('keeps a completed startup preflight for the first cycle only', async () => {
    const { engine, platform } = fixture(false)
    vi.spyOn(engine as unknown as { enableRuntimeWrites(): Promise<void> }, 'enableRuntimeWrites').mockResolvedValue()
    expect(await engine.run()).toBe(0)
    expect(platform.assertRepoWritable).toHaveBeenCalledTimes(1)
    await engine.cycle()
    expect(platform.assertRepoWritable).toHaveBeenCalledTimes(2)
  })
  it('prints safe actionable preflight messages while scrubbing arbitrary failure text', async () => {
    const { engine, platform } = fixture()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(platform.bindOrigin).mockRejectedValue(new SwarmPreflightConfigError('Unset GIT_CONFIG_PARAMETERS before dispatch'))
    expect(await engine.run()).toBe(1)
    expect(log.mock.calls.flat().join('\n')).toContain('Unset GIT_CONFIG_PARAMETERS')
    log.mockClear()
    vi.mocked(platform.bindOrigin).mockRejectedValue(new Error('https://token-secret@example.invalid/repo'))
    expect(await engine.run()).toBe(1)
    expect(log.mock.calls.flat().join('\n')).not.toContain('token-secret')
  })
  it('deduplicates unchanged dispatch blockers and resets after a clean no-dispatch transition', async () => {
    const { engine } = fixture()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(engine.tracker, 'shouldDispatch').mockReturnValue([false, 'already running'])
    await engine.processIssue(issue, [])
    await engine.processIssue(issue, [])
    expect(log).toHaveBeenCalledTimes(1)
    await engine.processIssue(issue, [pr])
    await engine.processIssue(issue, [])
    expect(log).toHaveBeenCalledTimes(2)
  })
  it('retains the preflight before setup and rechecks after setup before spawning', async () => {
    const { engine, platform } = dispatchFixture()
    const calls: string[] = []
    vi.mocked(platform.assertRepoWritable).mockImplementation(async () => { calls.push('preflight') })
    vi.mocked(platform.createWorktree).mockImplementation(async () => { calls.push('worktree'); return engine.repoRoot })
    vi.mocked(platform.prepareDispatch).mockImplementation(async () => { calls.push('spawn-boundary'); return {} })
    await engine.processIssue(issue, [])
    expect(calls).toEqual(['preflight', 'worktree', 'preflight', 'spawn-boundary'])
    await engine.tracker.killAll()
  })
  it('reads offline status without invoking GitHub, modifying the registry, or creating runtime directories', async () => {
    const { root, platform } = fixture()
    const engine = new SwarmEngine(root, { status: true }, platform)
    const print = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await engine.run()).toBe(0)
    expect(platform.bindOrigin).not.toHaveBeenCalled()
    expect(platform.gh).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
    expect(print).toHaveBeenCalledWith(expect.stringContaining('SWARM PROCESS STATUS'))
  })
  it('keeps dry-run reset read-only and skips capability checks and dispatch filesystem writes', async () => {
    const { engine, platform, root } = fixture()
    engine.options.reset = true
    expect(await engine.run()).toBe(0)
    expect(platform.bindOrigin).toHaveBeenCalledWith(false)
    expect(platform.assertRepoWritable).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
  })
  it('resets history locally even when startup authentication fails', async () => {
    const { engine, platform } = fixture(false)
    engine.tracker.recordFailure({ pid: null, role: 'worker', ai_name: 'claude', model: 'x', reasoning: 'high',
      task_ref: 'issue#7:initial', branch: 'worker/7', command: '', cwd: '', log_file: '',
      started_at: new Date().toISOString(), status: 'failed' })
    engine.options.reset = true
    vi.mocked(platform.bindOrigin).mockRejectedValue(new SwarmPreflightConfigError('offline'))
    expect(await engine.run()).toBe(1)
    expect(engine.tracker.history).toEqual([])
    expect(fs.existsSync(engine.tracker.file)).toBe(false)
  })
  it('refuses dispatch if either critical open-item query fails', async () => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue') return [issue] as never
      throw new Error('PR snapshot unavailable')
    })
    const process = vi.spyOn(engine, 'processIssue')
    await expect(engine.cycle()).rejects.toThrow('snapshot unavailable')
    expect(process).not.toHaveBeenCalled()
  })
  it('inspects ordinary Issues without dispatching them', async () => {
    const { engine, platform, spawnProcess } = dispatchFixture()
    expect(await engine.processIssue({ ...issue, title: 'ordinary task' }, [])).toBe(true)
    expect(platform.createWorktree).not.toHaveBeenCalled()
    expect(spawnProcess).not.toHaveBeenCalled()
  })
  it('does not dispatch an initial Worker whose PR already exists', async () => {
    const { engine, platform } = fixture()
    await engine.processIssue(issue, [pr])
    expect(platform.createWorktree).not.toHaveBeenCalled()
  })
  it('previews Worker dispatch without running Git or creating runtime files', async () => {
    const { engine, platform, root } = fixture()
    expect(await engine.processIssue(issue, [])).toBe(true)
    expect(platform.createWorktree).not.toHaveBeenCalled()
    expect(platform.assertRepoWritable).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
  })
  it('fails an unavailable authenticated-user lookup closed for the entire PR batch', async () => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'api') throw new Error('unauthenticated')
      if (args[0] === 'pr' && args.includes('open')) return [pr] as never
      return [] as never
    })
    const process = vi.spyOn(engine, 'processPr')
    expect(await engine.cycle()).toBe(1)
    expect(process).not.toHaveBeenCalled()
  })
  it('isolates an Issue failure, still inspects later Issues and merged-task cleanup', async () => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue') return [issue, { ...issue, number: 8 }] as never
      return [] as never
    })
    const process = vi.spyOn(engine, 'processIssue').mockRejectedValueOnce(new Error('broken checkout')).mockResolvedValue(true)
    expect(await engine.cycle()).toBe(1)
    expect(process).toHaveBeenCalledTimes(2)
    expect(platform.json).toHaveBeenCalledWith(expect.arrayContaining(['merged']))
  })
  it('never uses untrusted feedback as revision instructions', async () => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue') return issue as never
      return restPages(comment(REVIEWER, { authorAssociation: 'NONE' })) as never
    })
    await engine.processPr(pr, 'operator')
    expect(platform.fetchPrHead).not.toHaveBeenCalled()
    expect(platform.gh).toHaveBeenCalledWith(['pr', 'diff', '42'])
  })
  it.each([true, undefined])('refuses fork/unknown-ownership Worker revisions (%s)', async (isCrossRepository) => {
    const { engine, platform } = fixture(false)
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue') return issue as never
      return restPages(comment(REVIEWER)) as never
    })
    await engine.processPr({ ...pr, isCrossRepository }, 'operator')
    expect(platform.fetchPrHead).not.toHaveBeenCalled()
    expect(platform.createWorktree).not.toHaveBeenCalled()
  })
  it('requires approval metadata to match the assigned reviewer', async () => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue') return issue as never
      return restPages(comment(`${REVIEWER.replace('codex', 'claude')}\nApproved\n${MAINTAINER}`)) as never
    })
    await engine.processPr(pr, 'operator')
    expect(platform.prepareDispatch).not.toHaveBeenCalled()
    expect(platform.gh).not.toHaveBeenCalled()
  })
  it('refuses duplicate provider roles before dispatch', async () => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockResolvedValue(issue as never)
    await expect(engine.processPr({ ...pr, body: REVIEWER.replace('codex', 'claude') }, 'operator')).rejects.toThrow()
    expect(platform.prepareDispatch).not.toHaveBeenCalled()
  })
  it('stops --once lifecycle work and skips merged cleanup immediately after SIGINT', async () => {
    const { engine, platform } = fixture()
    vi.mocked(platform.json).mockImplementation(async (args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        process.emit('SIGINT')
        return [] as never
      }
      return [] as never
    })
    expect(await engine.run()).toBe(130)
    expect(platform.json).not.toHaveBeenCalledWith(expect.arrayContaining(['merged']))
  })
})
