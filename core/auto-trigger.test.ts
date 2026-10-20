import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAutoTrigger } from './auto-trigger.ts'
import { createMaoApp } from './app.ts'
import { RepoCapabilityError, evaluateRepoCapability } from './repo-capabilities.ts'
import { FileStore, type StoredObservation } from './store.ts'
import type { GithubService } from './github-service.ts'
import type { GithubTask } from './github-service.ts'
import { QUEUE_PERSISTENCE_BROKEN, type RepoRef, type WorkflowEngine } from './workflow-engine.ts'

const repo: RepoRef = { owner: 'acme', repo: 'widgets' }

/** startAutoTrigger owns a setInterval that would otherwise outlive the test and keep vitest alive. */
const handles: Array<ReturnType<typeof setInterval>> = []
const tmpDirs: string[] = []

afterEach(() => {
  while (handles.length) clearInterval(handles.pop()!)
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function observedRepos(value: RepoRef[]): StoredObservation<'githubRepos'> {
  return { value, problem: undefined, readable: true, witness: JSON.stringify(value) }
}

function inspectRepos(value: RepoRef[]): () => StoredObservation<'githubRepos'> {
  return () => observedRepos(value)
}

function openIssue(number: number): GithubTask {
  return {
    id: number,
    number,
    title: `Issue ${number}`,
    type: 'issue',
    state: 'open',
    url: `https://github.com/acme/widgets/issues/${number}`,
    updatedAt: '2026-09-09T00:00:00Z',
    urgent: false,
    labels: [],
    body: '',
  }
}

/** The preflight verdict for this repo, writable or not. */
function verdict(push: boolean) {
  return evaluateRepoCapability({
    owner: 'acme',
    repo: 'widgets',
    repository: { has_issues: true, permissions: { push } },
  })
}

function makeGithub(overrides: Record<string, unknown> = {}) {
  return {
    assertRepoWorkflowWritable: vi.fn(async () => verdict(true)),
    fetchTasks: vi.fn(async () => [openIssue(7)]),
    addLabel: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GithubService
}

/**
 * `queueRecoveryReason` models a latched host (issue #68): the scheduler consults the engine before it
 * polls, so the fake has to answer. `undefined` is the healthy case every pre-existing test here uses.
 */
function makeEngine(
  queueRecoveryReason?: string,
  queueRestartRequired = false,
  persistenceBroken = false,
) {
  let reason = queueRecoveryReason
  let restartRequired = queueRestartRequired
  return {
    enqueueFromIssue: vi.fn(),
    isPersistenceBroken: vi.fn(() => persistenceBroken),
    getQueueRecoveryReason: vi.fn(() => reason),
    isQueueRecoveryRestartRequired: vi.fn(() => restartRequired),
    requireQueueRecovery: vi.fn((next: string, options?: { restartRequired?: boolean }) => {
      if (options?.restartRequired && !restartRequired) reason = next
      if (reason === undefined) reason = next
      if (options?.restartRequired) restartRequired = true
    }),
  } as unknown as WorkflowEngine
}

/**
 * Drives exactly one poll. `inspectRepos` returns nothing so `startAutoTrigger`'s own immediate tick (and
 * its interval) never fire — each test controls precisely how many polls happen.
 */
async function pollOnce(
  github: GithubService,
  engine: WorkflowEngine,
  { swallowFailure = false }: { swallowFailure?: boolean } = {},
) {
  // Tracked but scheduler-disabled: the immediate tick stays quiet while manual refresh still proves
  // current membership before it polls.
  const trigger = startAutoTrigger(github, engine, inspectRepos([{ ...repo, autoTrigger: false }]))
  handles.push(trigger.handle)
  const poll = trigger.pollNow(repo)
  if (swallowFailure) await poll.catch(() => {})
  else await poll
  return trigger
}

describe('auto-trigger repository preflight', () => {
  it('enqueues and labels an open issue when the repo passes the preflight', async () => {
    const github = makeGithub()
    const engine = makeEngine()

    await pollOnce(github, engine)

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledWith('acme', 'widgets')
    expect(engine.enqueueFromIssue).toHaveBeenCalledTimes(1)
    expect(github.addLabel).toHaveBeenCalledWith('acme', 'widgets', 7, 'workflow-active')
  })

  it('performs zero enqueues and zero label writes when the credential cannot write', async () => {
    const github = makeGithub({
      assertRepoWorkflowWritable: vi.fn(async () => {
        throw new RepoCapabilityError(verdict(false))
      }),
    })
    const engine = makeEngine()

    const trigger = startAutoTrigger(github, engine, inspectRepos([{ ...repo, autoTrigger: false }]))
    handles.push(trigger.handle)
    await expect(trigger.pollNow(repo)).rejects.toThrow(/acme\/widgets is missing permissions/)

    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
    expect(github.addLabel).not.toHaveBeenCalled()
    // Checked before the listing too, so an unauthorized repo reports the missing capability rather
    // than the opaque 404 that listForRepo would have raised first.
    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(trigger.getStatus('acme', 'widgets').lastError).toMatch(/acme\/widgets is missing permissions/)
  })

  it('surfaces a transient lookup failure as the repo status error, still writing nothing', async () => {
    const github = makeGithub({
      assertRepoWorkflowWritable: vi.fn(async () => {
        throw new Error('GitHub request timed out after 60s')
      }),
    })
    const engine = makeEngine()

    const trigger = await pollOnce(github, engine, { swallowFailure: true })

    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
    expect(github.addLabel).not.toHaveBeenCalled()
    expect(trigger.getStatus('acme', 'widgets').lastError).toMatch(/timed out after 60s/)
  })

  it('logs only the message, never the error object that carries the authenticated request', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const github = makeGithub({
      assertRepoWorkflowWritable: vi.fn(async () => {
        throw Object.assign(new Error('Bad credentials'), {
          request: { headers: { authorization: 'token ghp_supersecretvalue' } },
        })
      }),
    })

    await pollOnce(github, makeEngine(), { swallowFailure: true })

    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError.mock.calls[0]).toHaveLength(1)
    expect(String(consoleError.mock.calls[0][0])).not.toContain('ghp_supersecretvalue')
  })

  it('clears the recorded error once the permission is restored', async () => {
    const assertRepoWorkflowWritable = vi
      .fn()
      .mockRejectedValueOnce(new RepoCapabilityError(verdict(false)))
      .mockResolvedValue(verdict(true))
    const github = makeGithub({ assertRepoWorkflowWritable })
    const engine = makeEngine()

    const trigger = await pollOnce(github, engine, { swallowFailure: true })
    expect(trigger.getStatus('acme', 'widgets').lastError).toBeTruthy()

    await trigger.pollNow(repo)

    expect(trigger.getStatus('acme', 'widgets').lastError).toBeNull()
    expect(engine.enqueueFromIssue).toHaveBeenCalledTimes(1)
  })
})

describe('auto-trigger duplicate repositories', () => {
  /**
   * Runs the scheduler's own immediate tick against `repos` — not `pollNow`, because the tick is what
   * dedupes. Every collaborator is a resolved-promise mock, so draining the macrotask queue a few times
   * settles the whole chain; deliberately not `vi.waitFor` on a call count, which would pass a
   * "nothing was polled" assertion only by timing out.
   */
  async function tickOnce(github: GithubService, engine: WorkflowEngine, repos: RepoRef[]) {
    const trigger = startAutoTrigger(github, engine, inspectRepos(repos))
    handles.push(trigger.handle)
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    return trigger
  }

  it('polls a repository once when the store holds it under two spellings', async () => {
    // The exact harm that motivated case-insensitive identity. A store written by an earlier build can
    // still hold the duplicate, and only a list write heals it — an unattended `mao run` never performs
    // one, so the scheduler has to stop double-polling on its own. Polling twice means two
    // enqueueFromIssue calls for one issue (the workflow-active label is written after the enqueue and
    // is best-effort), i.e. two branches and two PRs.
    const github = makeGithub()
    const engine = makeEngine()

    await tickOnce(github, engine, [repo, { owner: 'ACME', repo: 'Widgets' }])

    expect(github.fetchTasks).toHaveBeenCalledTimes(1)
    expect(engine.enqueueFromIssue).toHaveBeenCalledTimes(1)
  })

  it('does not poll a duplicated repository that either entry switched off', async () => {
    // Healing merges the two rows, and an explicit "do not poll this" wins from either side — the
    // scheduler must agree, or the repo is polled for as long as the duplicate survives on disk.
    const github = makeGithub()
    const engine = makeEngine()

    await tickOnce(github, engine, [{ ...repo, autoTrigger: false }, { owner: 'ACME', repo: 'Widgets' }])

    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
  })
})

/**
 * The scheduler half of issue #68's fail-closed latch.
 *
 * `startAutoTrigger` ticks immediately rather than after its first interval, and that tick is how an
 * unreadable queue got overwritten and a pipeline started. The engine would refuse the enqueue anyway;
 * stopping here is what makes the poll cost zero GitHub calls and write no best-effort label.
 */
describe('startAutoTrigger with a latched queue', () => {
  const REASON = '[store] "workflowTasks" in /tmp/config.json is an object, not a JSON array…'

  it('spends no GitHub call and advances no poll timestamp', async () => {
    const github = makeGithub()
    const engine = makeEngine(REASON)

    const trigger = startAutoTrigger(github, engine, inspectRepos([repo]))
    handles.push(trigger.handle)
    await new Promise((r) => setTimeout(r, 20))

    expect(github.assertRepoWorkflowWritable).not.toHaveBeenCalled()
    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(github.addLabel).not.toHaveBeenCalled()
    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
    // Skipping the whole scheduler rather than each poll is what keeps this null: `lastPolledAt` is set
    // in pollRepo's `finally`, so a per-poll gate would leave the GUI's "last synced" claiming syncs
    // that never happened.
    expect(trigger.getStatus('acme', 'widgets').lastPolledAt).toBeNull()
  })

  it('pollNow rejects rather than reporting a clean sync', async () => {
    // `pollNow` must be a wrapper around the interval path: the latter records and continues, while a
    // board Refresh has to reject instead of reporting a clean sync.
    const github = makeGithub()
    const trigger = startAutoTrigger(github, makeEngine(REASON), inspectRepos([repo]))
    handles.push(trigger.handle)

    await expect(trigger.pollNow(repo)).rejects.toThrow(REASON)
    expect(github.fetchTasks).not.toHaveBeenCalled()
  })

  it('spends no GitHub call and rejects manual refresh after persistence becomes uncertain', async () => {
    const github = makeGithub()
    const engine = makeEngine(undefined, false, true)
    const trigger = startAutoTrigger(github, engine, inspectRepos([repo]))
    handles.push(trigger.handle)
    await new Promise((r) => setTimeout(r, 20))

    expect(github.assertRepoWorkflowWritable).not.toHaveBeenCalled()
    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
    expect(trigger.getStatus('acme', 'widgets').lastPolledAt).toBeNull()
    await expect(trigger.pollNow(repo)).rejects.toThrow(QUEUE_PERSISTENCE_BROKEN)
  })

  it('stops after an in-flight permission preflight when persistence becomes uncertain', async () => {
    let releasePreflight!: () => void
    let persistenceBroken = false
    const github = makeGithub({
      assertRepoWorkflowWritable: vi.fn(
        () =>
          new Promise((resolve) => {
            releasePreflight = () => resolve(verdict(true))
          }),
      ),
    })
    const engine = makeEngine()
    vi.mocked(engine.isPersistenceBroken).mockImplementation(() => persistenceBroken)
    const trigger = startAutoTrigger(
      github,
      engine,
      inspectRepos([{ ...repo, autoTrigger: false }]),
    )
    handles.push(trigger.handle)

    const poll = trigger.pollNow(repo)
    await vi.waitFor(() => expect(github.assertRepoWorkflowWritable).toHaveBeenCalledTimes(1))
    persistenceBroken = true
    const rejected = expect(poll).rejects.toThrow(QUEUE_PERSISTENCE_BROKEN)
    releasePreflight()
    await rejected

    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
    expect(github.addLabel).not.toHaveBeenCalled()
    expect(trigger.getStatus('acme', 'widgets').lastPolledAt).toBeNull()
  })

  it('stops after an in-flight issue read when queue recovery becomes required', async () => {
    let releaseFetch!: () => void
    const github = makeGithub({
      fetchTasks: vi.fn(
        () =>
          new Promise((resolve) => {
            releaseFetch = () => resolve([openIssue(7)])
          }),
      ),
    })
    const engine = makeEngine()
    const trigger = startAutoTrigger(
      github,
      engine,
      inspectRepos([{ ...repo, autoTrigger: false }]),
    )
    handles.push(trigger.handle)

    const poll = trigger.pollNow(repo)
    await vi.waitFor(() => expect(github.fetchTasks).toHaveBeenCalledTimes(1))
    engine.requireQueueRecovery('queue became unreadable', { restartRequired: true })
    const rejected = expect(poll).rejects.toThrow('queue became unreadable')
    releaseFetch()
    await rejected

    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
    expect(github.addLabel).not.toHaveBeenCalled()
    expect(trigger.getStatus('acme', 'widgets').lastPolledAt).toBeNull()
  })

  it('stops the current multi-repository tick as soon as one enqueue breaks persistence', async () => {
    let broken = false
    const github = makeGithub()
    const engine = makeEngine()
    vi.mocked(engine.isPersistenceBroken).mockImplementation(() => broken)
    vi.mocked(engine.enqueueFromIssue).mockImplementation(() => {
      broken = true
      // Mirrors the real engine's async stage-entry failure: enqueue itself can return even though the
      // process it starts synchronously latches persistenceBroken before control reaches addLabel.
      return undefined as never
    })
    const trigger = startAutoTrigger(
      github,
      engine,
      inspectRepos([repo, { owner: 'acme', repo: 'tools' }]),
    )
    handles.push(trigger.handle)
    await new Promise((r) => setTimeout(r, 20))

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledTimes(1)
    expect(github.fetchTasks).toHaveBeenCalledTimes(1)
    expect(engine.enqueueFromIssue).toHaveBeenCalledTimes(1)
    expect(github.addLabel).not.toHaveBeenCalled()
  })

  it('rejects when the repository disappeared from the fresh tracked list', async () => {
    const github = makeGithub()
    const engine = makeEngine()
    const trigger = startAutoTrigger(github, engine, inspectRepos([]))
    handles.push(trigger.handle)

    await expect(trigger.pollNow(repo)).rejects.toThrow(/no longer tracked/)
    expect(github.assertRepoWorkflowWritable).not.toHaveBeenCalled()
    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
  })

  it('rejects when polling itself discovers a queue halt instead of reporting a clean sync', async () => {
    const github = makeGithub()
    const engine = makeEngine()
    vi.mocked(engine.enqueueFromIssue).mockImplementation(() => {
      engine.requireQueueRecovery('restart after whole-file failure', { restartRequired: true })
      throw new Error('enqueue refused')
    })
    const trigger = startAutoTrigger(
      github,
      engine,
      inspectRepos([{ ...repo, autoTrigger: false }]),
    )
    handles.push(trigger.handle)

    await expect(trigger.pollNow(repo)).rejects.toThrow('restart after whole-file failure')
    expect(github.addLabel).not.toHaveBeenCalled()
  })

  it('reports the persistence block when a poll discovers both safety halts', async () => {
    let persistenceBroken = false
    const github = makeGithub()
    const engine = makeEngine()
    vi.mocked(engine.isPersistenceBroken).mockImplementation(() => persistenceBroken)
    vi.mocked(engine.enqueueFromIssue).mockImplementation(() => {
      engine.requireQueueRecovery('restart after whole-file failure', { restartRequired: true })
      persistenceBroken = true
      throw new Error('enqueue result is indeterminate')
    })
    const trigger = startAutoTrigger(
      github,
      engine,
      inspectRepos([{ ...repo, autoTrigger: false }]),
    )
    handles.push(trigger.handle)

    await expect(trigger.pollNow(repo)).rejects.toThrow(QUEUE_PERSISTENCE_BROKEN)
    expect(github.addLabel).not.toHaveBeenCalled()
  })

  it('upgrades a field-only halt when the complete settings file later becomes unreadable', async () => {
    const github = makeGithub()
    const engine = makeEngine(REASON)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const trigger = startAutoTrigger(github, engine, () => {
      throw new Error('parser text may contain ghp_secret')
    }, 1)
    handles.push(trigger.handle)
    await new Promise((r) => setTimeout(r, 20))

    expect(engine.isQueueRecoveryRestartRequired()).toBe(true)
    expect(engine.getQueueRecoveryReason()).toMatch(/cannot safely write its startup snapshot over a repair/)
    expect(engine.requireQueueRecovery).toHaveBeenCalledWith(expect.any(String), {
      restartRequired: true,
    })
    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain('ghp_secret')
  })

  it('a healthy host polls, enqueues and labels exactly as before', async () => {
    const github = makeGithub()
    const engine = makeEngine()

    const trigger = startAutoTrigger(github, engine, inspectRepos([repo]))
    handles.push(trigger.handle)
    await new Promise((r) => setTimeout(r, 20))

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalled()
    expect(engine.enqueueFromIssue).toHaveBeenCalled()
    expect(trigger.getStatus('acme', 'widgets').lastPolledAt).not.toBeNull()
    await expect(trigger.pollNow(repo)).resolves.toEqual([openIssue(7)])
  })
})

/**
 * A store read that fails must stop the scheduler, not escape it.
 *
 * `tick` is invoked bare and from `setInterval`, so a throw leaving it is an unhandled rejection no
 * caller can catch — the hazard `pollNow`'s own comment is written against. The fresh observation can
 * fail after a clean boot on either backend: Electron re-reads naturally, while the CLI must use
 * `FileStore.inspect()` because `get()` intentionally remains a constructor snapshot. Before the guard,
 * Electron measured one unhandled rejection per scheduler tick; the stale CLI path kept polling.
 */
describe('startAutoTrigger when the stored repository list cannot be read', () => {
  function unreadable(): never {
    throw new Error('[store] /tmp/config.json could not be read. It is valid JSON, but not a JSON object.')
  }

  it('skips the tick and lets nothing escape', async () => {
    // Asserted on a counted listener rather than left to vitest's unhandled-rejection reporter, which
    // SKILL.md warns reads as a passing suite with a non-zero exit — that would not discriminate.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)

    try {
      const github = makeGithub()
      const engine = makeEngine()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      const trigger = startAutoTrigger(github, engine, unreadable, 1)
      handles.push(trigger.handle)
      await new Promise((r) => setTimeout(r, 30))

      expect(rejections).toEqual([])
      expect(github.assertRepoWorkflowWritable).not.toHaveBeenCalled()
      expect(github.fetchTasks).not.toHaveBeenCalled()
      expect(github.addLabel).not.toHaveBeenCalled()
      expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(String(consoleError.mock.calls[0]?.[0])).not.toContain('/tmp/config.json')
      // Same reasoning as the latched-queue case: `lastPolledAt` is set in pollRepo's `finally`, so
      // stopping the whole scheduler is what keeps "last synced" from claiming a sync that never
      // happened.
      expect(trigger.getStatus('acme', 'widgets').lastPolledAt).toBeNull()
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('stays latched after repair and polls only from a restarted host', async () => {
    let broken = true
    const github = makeGithub()
    const engine = makeEngine()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const trigger = startAutoTrigger(github, engine, () =>
      broken ? unreadable() : observedRepos([repo]),
    )
    handles.push(trigger.handle)
    await new Promise((r) => setTimeout(r, 20))
    expect(github.fetchTasks).not.toHaveBeenCalled()

    broken = false
    await expect(trigger.pollNow(repo)).rejects.toThrow(/cannot safely write its startup snapshot over a repair/)
    expect(github.fetchTasks).not.toHaveBeenCalled()

    const restarted = startAutoTrigger(
      github,
      makeEngine(),
      inspectRepos([{ ...repo, autoTrigger: false }]),
    )
    handles.push(restarted.handle)
    await restarted.pollNow(repo)

    expect(github.fetchTasks).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('does not label an issue when the complete store becomes unreadable immediately after enqueue', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-auto-trigger-label-test-'))
    tmpDirs.push(dataDir)
    const filePath = path.join(dataDir, 'config.json')
    const tracked = { ...repo, autoTrigger: false }
    fs.writeFileSync(filePath, JSON.stringify({ githubRepos: [tracked], workflowTasks: [] }))
    const store = new FileStore(filePath)
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    let releaseStagePreflight!: () => void
    vi.spyOn(app.githubService, 'assertRepoWorkflowWritable')
      .mockResolvedValueOnce(verdict(true))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStagePreflight = () => resolve(verdict(true))
          }),
      )
    vi.spyOn(app.githubService, 'fetchTasks').mockResolvedValue([openIssue(7)])
    const addLabel = vi.spyOn(app.githubService, 'addLabel').mockResolvedValue()
    const enqueueFromIssue = app.workflowEngine.enqueueFromIssue.bind(app.workflowEngine)
    const secret = 'ghp_corrupted_after_enqueue_must_not_escape'
    vi.spyOn(app.workflowEngine, 'enqueueFromIssue').mockImplementation((...args) => {
      const task = enqueueFromIssue(...args)
      // The task reached the durable queue, then an external writer damaged the complete file before
      // auto-trigger's duplicate-protection label write. Existing engine latches are still clear here.
      fs.writeFileSync(filePath, secret)
      return task
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const trigger = startAutoTrigger(
      app.githubService,
      app.workflowEngine,
      () => store.inspect('githubRepos'),
      60_000,
    )
    handles.push(trigger.handle)

    await expect(trigger.pollNow(repo)).rejects.toThrow(/cannot safely write its startup snapshot over a repair/)
    releaseStagePreflight()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(addLabel).not.toHaveBeenCalled()
    expect(app.workflowEngine.isQueueRecoveryRestartRequired()).toBe(true)
    expect(trigger.getStatus('acme', 'widgets').lastError).not.toContain(secret)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(secret)
  })

  it('keeps a real FileStore halted so its startup snapshot cannot overwrite a repair', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-auto-trigger-test-'))
    tmpDirs.push(dataDir)
    const filePath = path.join(dataDir, 'config.json')
    const tracked = { ...repo, autoTrigger: false }
    fs.writeFileSync(
      filePath,
      JSON.stringify({ theme: 'light', githubRepos: [tracked], workflowTasks: [] }),
    )
    const store = new FileStore(filePath)
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    vi.spyOn(app.githubService, 'assertRepoWorkflowWritable').mockResolvedValue(verdict(true))
    vi.spyOn(app.githubService, 'fetchTasks').mockResolvedValue([openIssue(7)])
    vi.spyOn(app.githubService, 'addLabel').mockResolvedValue()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Prove the ordinary CLI read is stale while the observer supplied to the scheduler is not.
    const secret = 'ghp_late_corruption_must_not_escape'
    fs.writeFileSync(filePath, secret)
    expect(store.get('githubRepos')).toEqual([tracked])

    const trigger = startAutoTrigger(
      app.githubService,
      app.workflowEngine,
      () => store.inspect('githubRepos'),
      60_000,
    )
    handles.push(trigger.handle)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(app.githubService.fetchTasks).not.toHaveBeenCalled()
    expect(app.workflowEngine.getTasks()).toEqual([])
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret)

    // The repair intentionally changes another setting. The old process must not write its boot-time
    // `theme: light` snapshot over this complete file after it becomes readable again.
    fs.writeFileSync(
      filePath,
      JSON.stringify({ theme: 'dark', githubRepos: [tracked], workflowTasks: [] }),
    )
    await expect(trigger.pollNow(repo)).rejects.toThrow(/cannot safely write its startup snapshot over a repair/)
    expect(app.githubService.fetchTasks).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toMatchObject({
      theme: 'dark',
      workflowTasks: [],
    })

    // A new process loads the repaired snapshot and may safely persist a task without reverting it.
    const restartedStore = new FileStore(filePath)
    const restarted = createMaoApp({
      store: restartedStore,
      workspaceRoot: path.join(dataDir, 'restarted-workspaces'),
      dataDir,
      resume: false,
    })
    vi.spyOn(restarted.githubService, 'assertRepoWorkflowWritable').mockResolvedValue(verdict(true))
    vi.spyOn(restarted.githubService, 'fetchTasks').mockResolvedValue([openIssue(7)])
    vi.spyOn(restarted.githubService, 'addLabel').mockResolvedValue()
    const restartedTrigger = startAutoTrigger(
      restarted.githubService,
      restarted.workflowEngine,
      () => restartedStore.inspect('githubRepos'),
      60_000,
    )
    handles.push(restartedTrigger.handle)
    await restartedTrigger.pollNow(repo)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const repaired = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(repaired.theme).toBe('dark')
    expect(repaired.workflowTasks).toHaveLength(1)
  })
})
