import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMaoApp } from './app.ts'
import { FileStore, createGuardedStore, type MaoStoreSchema } from './store.ts'
import { hasPersistenceBrokenMarker, writePersistenceBrokenMarker } from './persistence-guard.ts'
import type { QueuedTask } from './workflow-engine.ts'

const tmpDirs: string[] = []

/** A fresh per-test data directory on the real filesystem, backing a real FileStore — per review feedback, a fake in-memory MaoStore doesn't exercise the actual (single-JSON-blob, rewrite-whole-file) persistence model these regressions are about. */
function makeRealDataDir(): { dataDir: string; store: FileStore } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-app-test-'))
  tmpDirs.push(dataDir)
  return { dataDir, store: new FileStore(path.join(dataDir, 'config.json')) }
}

/**
 * A data directory whose `config.json` already holds exactly `contents`, opened through a real
 * `FileStore`.
 *
 * Written as raw JSON rather than through `store.set`, which cannot produce a value the schema forbids —
 * a hand-edited file can, and that is the whole subject of the boot regressions below.
 */
function makeRealDataDirHolding(contents: unknown): { dataDir: string; store: FileStore; filePath: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-app-test-'))
  tmpDirs.push(dataDir)
  const filePath = path.join(dataDir, 'config.json')
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2))
  return { dataDir, store: new FileStore(filePath), filePath }
}

/** Keeps the read guard's report out of the test output without hiding whether it happened. */
function captureWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

/** The repository root, anchored to this file rather than to whatever directory vitest started in. */
const REPO_ROOT = path.join(
  (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'),
  '..',
)

/** Comments may legitimately name a symbol; only executable text should satisfy a source assertion. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function makePendingTask(id: string): QueuedTask {
  return {
    id,
    title: 'Pending task',
    repo: { owner: 'acme', repo: 'widgets' },
    stage: 'issue',
    history: [],
    status: 'pending',
    autoAdvance: false,
    github: {},
  }
}

describe('createMaoApp', () => {
  it('durably records a confirmed WorkflowEngine persistence failure as a real file on disk', () => {
    const { dataDir, store } = makeRealDataDir()
    const { workflowEngine } = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })

    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
    workflowEngine.emit('persistence-broken', new Error('disk full'))
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
  })

  it('the marker still lands even when FileStore.set() (the exact write that already failed for workflowTasks) is broken', () => {
    const { dataDir, store } = makeRealDataDir()
    const { workflowEngine } = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })

    // Simulate the real failure mode this regression is about: the store's config.json write is
    // broken (e.g. disk full, permissions), but the marker file — a separate, independent
    // writeFileSync call to a different path — is not, because the underlying disk can still take
    // a few bytes even when it can't take the full task-list blob.
    const realWriteFileSync = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      if (String(file).endsWith('config.json')) throw new Error('ENOSPC: no space left on device')
      return realWriteFileSync(file, ...(rest as [never]))
    })

    expect(() => store.set('workflowTasks', [])).toThrow(/ENOSPC/)
    expect(() => workflowEngine.emit('persistence-broken', new Error('disk full'))).not.toThrow()
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
  })

  it('an also-broken marker write does not crash the persistence-broken handler', () => {
    const { dataDir, store } = makeRealDataDir()
    const { workflowEngine } = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })

    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk is completely gone')
    })

    expect(() => workflowEngine.emit('persistence-broken', new Error('disk full'))).not.toThrow()
  })

  it('refuses to auto-resume — even when the caller asks for resume: true — once the marker file is present', async () => {
    const { dataDir, store } = makeRealDataDir()
    store.set('workflowTasks', [makePendingTask('leftover-task')])
    writePersistenceBrokenMarker(dataDir, new Error('disk full'))

    const { workflowEngine } = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: true })

    // Give any (incorrectly) auto-started processing a chance to run — with no AI providers
    // registered, a resumed task would immediately flip to 'error'. It must stay untouched instead.
    await new Promise((r) => setTimeout(r, 20))

    const task = workflowEngine.getTasks().find((t) => t.id === 'leftover-task')!
    expect(task.status).toBe('pending')
  })

  it('still auto-resumes normally when no marker file is present', async () => {
    const { dataDir, store } = makeRealDataDir()
    store.set('workflowTasks', [makePendingTask('leftover-task-2')])

    const { workflowEngine } = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: true })

    // No GitHub token configured, so runStage's repo-permission preflight rejects the resumed stage
    // before it reaches provider selection — failing fast and predictably, which is what proves
    // processing actually started (as opposed to the task sitting untouched at 'pending').
    await new Promise((r) => setTimeout(r, 20))

    const task = workflowEngine.getTasks().find((t) => t.id === 'leftover-task-2')!
    expect(task.status).toBe('error')
    expect(task.error).toMatch(/no GitHub token is configured/)
    // Still stalled at its own stage, so restoring the token and retrying re-runs it unchanged.
    expect(task.stage).toBe('issue')
  })
})

/**
 * Issue #68's fail-closed half, at the only boot path both shells call.
 *
 * Review of PR #69 reproduced the hole these pin: that PR coerced an unreadable `workflowTasks` to `[]`
 * and argued it was safe because resuming an empty queue is a no-op. But Electron's
 * `registerIpcHandlers` and `mao run` both call `startAutoTrigger()` straight after `createMaoApp()`, and
 * it ticks *immediately* rather than after its first interval — so the first poll's `enqueueFromIssue()`
 * would `notify()`, the `'change'` listener would `store.set('workflowTasks', …)`, and that single write
 * would destroy the only salvageable copy of the unreadable value **and** start an unattended pipeline on
 * a host that cannot know what was already in flight.
 */
describe('createMaoApp with an unreadable stored queue', () => {
  const corruptQueue = { 'task-1': { id: 'task-1' } }

  it('latches the engine, refuses to auto-resume, and does not claim persistence is broken', () => {
    const warn = captureWarnings()
    const { dataDir, store } = makeRealDataDirHolding({ workflowTasks: corruptQueue })

    const { workflowEngine } = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })

    expect(workflowEngine.isQueueRecoveryLatched()).toBe(true)
    expect(workflowEngine.getQueueRecoveryReason()).toContain('"workflowTasks"')
    expect(workflowEngine.getTasks()).toEqual([])
    // A read-shape halt must never be reported through the *write* marker: `mao config show` would then
    // answer workflowPersistenceBroken: true and send the operator to a command that cannot fix this.
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
    expect(workflowEngine.isPersistenceBroken()).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('the reproduced path: an immediate auto-trigger enqueue cannot overwrite the unreadable value', () => {
    // The end-to-end regression, driven through the engine the way auto-trigger's first tick does.
    captureWarnings()
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: corruptQueue })

    const { workflowEngine } = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })

    expect(() =>
      workflowEngine.enqueueFromIssue(7, 'https://github.com/acme/widgets/issues/7', 'Fix it', {
        owner: 'acme',
        repo: 'widgets',
      }),
    ).toThrow(/workflowTasks/)

    // The operator's only salvageable copy is still exactly where it was.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual(corruptQueue)
    expect(workflowEngine.getTasks()).toEqual([])
  })

  it('latches before the change listener is subscribed, so nothing can write in between', () => {
    // Ordering inside createMaoApp. If the latch were set after the subscription (or after restore()),
    // any emission in that window would persist an array over the unreadable value.
    captureWarnings()
    const { dataDir, store, filePath } = makeRealDataDirHolding({
      workflowTasks: corruptQueue,
      githubToken: 'ghp_x',
    })

    const { workflowEngine } = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })
    // Force the listener directly — this is what a future ungated emitter would do. The backstop must
    // swallow it silently rather than persist, and must not escalate to a persistence failure. (It is no
    // longer the recovery's own write path: that goes through `store.setIfUnchanged`, so there is no
    // healing emit here to protect.)
    workflowEngine.emit('change', [makePendingTask('sneaky')])

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual(corruptQueue)
    expect(workflowEngine.isPersistenceBroken()).toBe(false)
  })

  it('recovers through confirmQueueRecovery, and the next boot resumes normally', async () => {
    // The end-to-end way out, and non-stickiness: the latch is derived from the stored value, so once the
    // value is replaced nothing survives to block a later legitimate queue.
    // One spy for the whole test: vi.spyOn on an already-spied method hands back the SAME mock, so a
    // second captureWarnings() would still be carrying the first boot's report.
    const warn = captureWarnings()
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: corruptQueue })

    const first = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
    expect(first.confirmQueueRecovery()).toEqual({ kind: 'replaced' })

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([])

    const reopened = new FileStore(filePath)
    reopened.set('workflowTasks', [makePendingTask('after-recovery')])

    warn.mockClear()
    const second = createMaoApp({
      store: new FileStore(filePath),
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })
    await new Promise((r) => setTimeout(r, 30))

    expect(second.workflowEngine.isQueueRecoveryLatched()).toBe(false)
    const task = second.workflowEngine.getTasks().find((t) => t.id === 'after-recovery')!
    // No GitHub token configured, so the stage preflight rejects — which is what proves processing
    // actually started rather than the task sitting untouched at 'pending'.
    expect(task.status).toBe('error')
    expect(task.error).toMatch(/no GitHub token is configured/)
    expect(warn).not.toHaveBeenCalled()
  })

  it('fails closed on a store it cannot inspect at all, without a value in the message', () => {
    const { dataDir, store } = makeRealDataDir()
    // `inspect`, not `problems`: the boot takes ONE observation now, which is the point of finding 2's
    // fix. A store that cannot be read at all must halt rather than crash boot or read as healthy.
    vi.spyOn(store, 'inspect').mockImplementation(() => {
      throw new Error('EACCES: permission denied, open \'/tmp/ghp_secretish/config.json\'')
    })

    const { workflowEngine } = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })

    expect(workflowEngine.isQueueRecoveryLatched()).toBe(true)
    // A parse or I/O error is free to quote the file's own text, and config.json holds githubToken in
    // plaintext — so the fabricated reason interpolates nothing from the error.
    expect(workflowEngine.getQueueRecoveryReason()).not.toContain('ghp_secretish')
    expect(workflowEngine.getQueueRecoveryReason()).not.toContain('EACCES')
  })

  it('an unreadable aiProviders is reported but halts nothing', () => {
    // The deliberate asymmetry: an empty provider list stops every stage at selectAgent() before any
    // GitHub write, so latching for it would be a larger outage than the fault.
    const warn = captureWarnings()
    const { dataDir, store } = makeRealDataDirHolding({ aiProviders: { claude: { id: 'claude' } } })

    const { workflowEngine } = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })

    expect(workflowEngine.isQueueRecoveryLatched()).toBe(false)
    expect(() => workflowEngine.enqueue('t', { owner: 'acme', repo: 'widgets' })).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0] as string).toContain('"aiProviders"')
  })

  it('leaves a healthy store entirely unlatched', () => {
    const { dataDir, store } = makeRealDataDirHolding({ workflowTasks: [makePendingTask('ok')] })

    const { workflowEngine } = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })

    expect(workflowEngine.isQueueRecoveryLatched()).toBe(false)
    expect(workflowEngine.getTasks().map((t) => t.id)).toEqual(['ok'])
  })
})

/**
 * Two rules the other gates make *unobservable* at runtime, pinned as source order instead.
 *
 * Verified by mutation: moving `requireQueueRecovery` below the `'change'` subscription, and moving the
 * gate into `notify()`, both leave the whole suite green — because nothing emits between the
 * subscription and the latch (`restore()` emits nothing), and because every public mutator already
 * throws before `notify()` is reached. They are defence against a later refactor rather than behaviour
 * with a witness, and the repo's own answer to a hand-maintained coupling with no type to enforce it is
 * to read the source (see `core/store.test.ts` on `electron/store.ts`, `core/node-environment.test.ts`
 * on the vitest config).
 */
/**
 * Finding 2 from the re-review, end to end at the boot path.
 *
 * `createMaoApp` used to decide the latch from `store.problems()` and then restore from a SEPARATE
 * `store.get('workflowTasks')`. conf re-reads and re-parses the config file on every `get`, so a
 * hand-edit (or another CLI) turning the queue from an array into a non-array between those two reads
 * left the first read saying "healthy" — no latch — while the second was coerced to `[]` and restored.
 * The host then ran UNLATCHED holding an empty queue, auto-trigger ticked immediately, and the
 * unreadable original was overwritten while unattended work began.
 */
describe('createMaoApp when the stored queue changes between reads', () => {
  /** A store whose `workflowTasks` turns unusable on its Nth raw read, like conf re-reading the file. */
  function flippingStore(healthyReads: number) {
    let reads = 0
    const data: Record<string, unknown> = { workflowTasks: [makePendingTask('real')] }
    return createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => {
          if (key !== 'workflowTasks') return data[key] as MaoStoreSchema[K] | undefined
          reads += 1
          return (reads <= healthyReads
            ? [makePendingTask('real')]
            : { real: makePendingTask('real') }) as unknown as MaoStoreSchema[K]
        },
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          data[key] = value
        },
      },
      '/tmp/config.json',
    )
  }

  it('never ends up unlatched while holding a queue the guard had to replace', () => {
    // The invariant, stated so it holds whichever read the boot happens to get: an empty restored queue
    // and no latch is the one combination that let the reproduced failure through.
    captureWarnings()
    const { dataDir } = makeRealDataDir()

    for (const healthyReads of [0, 1, 2]) {
      const store = flippingStore(healthyReads)
      const { workflowEngine } = createMaoApp({
        store,
        workspaceRoot: path.join(dataDir, 'workspaces'),
        dataDir,
        resume: false,
      })

      const restoredIds = workflowEngine.getTasks().map((t) => t.id)
      const latched = workflowEngine.isQueueRecoveryLatched()
      expect(latched || restoredIds.length > 0, `healthyReads=${healthyReads}`).toBe(true)
      if (!latched) expect(restoredIds).toEqual(['real'])
    }
  })

  it('takes exactly one raw read of the queue at boot', () => {
    // Two reads is the bug, not an inefficiency: a second read is a second chance to disagree. Also the
    // reason the boot does not re-derive the latch per gate — on conf each raw read is a whole-config
    // read and parse.
    captureWarnings()
    const { dataDir } = makeRealDataDir()
    let reads = 0
    const store = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => {
          if (key === 'workflowTasks') reads += 1
          return undefined
        },
        set: () => {},
      },
      '/tmp/config.json',
    )

    createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })

    expect(reads).toBe(1)
  })
})

describe('core/app.ts and the engine, as source order', () => {
  const appSource = withoutComments(fs.readFileSync(path.join(REPO_ROOT, 'core', 'app.ts'), 'utf-8'))
  const engineSource = withoutComments(
    fs.readFileSync(path.join(REPO_ROOT, 'core', 'workflow-engine.ts'), 'utf-8'),
  )

  it('latches before it subscribes the change listener and before restore', () => {
    const latch = appSource.indexOf('requireQueueRecovery(')
    const subscribe = appSource.indexOf("workflowEngine.on('change'")
    const restore = appSource.indexOf('workflowEngine.restore(')

    expect(latch).toBeGreaterThan(-1)
    expect(subscribe).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(-1)
    expect(latch).toBeLessThan(subscribe)
    expect(latch).toBeLessThan(restore)
  })

  it('reads the field, not the store, in the change backstop', () => {
    // Two reasons, neither of them a healing emit — there is no longer one, because `healStoredQueue()`
    // writes through `store.setIfUnchanged` and clears the latch afterwards. What survives: each
    // observation is a whole-config read and parse on conf, and this sits on the queue-write path; and a
    // transient read failure here would latch a healthy host for the rest of its life.
    const listener = appSource.slice(appSource.indexOf("workflowEngine.on('change'"))
    const body = listener.slice(0, listener.indexOf('})') + 2)

    expect(body).toContain('isQueueRecoveryLatched()')
    expect(body).not.toContain('describeUnreadableQueue(')
    expect(body).not.toContain('problems()')
  })

  it('ands the latch into safeToResume', () => {
    // Also unobservable on its own — restore(resume: true) reaches processQueue, which is gated anyway —
    // so this is the second line of defence, not the first. Pinned so a refactor cannot quietly make the
    // boot path depend on processQueue's check alone.
    const safeToResume = appSource.slice(appSource.indexOf('const safeToResume ='))
    const line = safeToResume.slice(0, safeToResume.indexOf('\n'))

    expect(line).toContain('isQueueRecoveryLatched()')
    expect(line).toContain('hasPersistenceBrokenMarker(dataDir)')
  })

  it('keeps both of processQueue\'s latch checks', () => {
    // Removing either one alone changes nothing observable (the entry check short-circuits what the
    // in-loop check would catch anyway), so neither is independently load-bearing — but removing BOTH
    // lets a latched engine run stages. Mirrors how persistenceBroken is checked in the same two places.
    const processQueue = engineSource.slice(engineSource.indexOf('  private async processQueue() {'))
    const body = processQueue.slice(0, processQueue.indexOf('\n  private '))
    const checks = [...body.matchAll(/this\.queueRecoveryReason !== undefined\) return/g)]

    expect(checks).toHaveLength(2)
  })

  it('does not gate notify() itself', () => {
    // notifyAfterStage reads a throwing `'change'` listener as a persistence failure, so a gate here
    // would escalate this read-shape halt into a bogus persistenceBroken.
    const notify = engineSource.slice(engineSource.indexOf('  private notify() {'))
    const body = notify.slice(0, notify.indexOf('\n  }') + 4)

    expect(body).toContain("this.emit('change'")
    expect(body).not.toContain('assertQueueWritable')
  })
})

/**
 * `confirmQueueRecovery()` — the one way out of the halt, and the sequence review had to correct twice.
 *
 * It lives on `MaoApp` rather than the engine because its write has to be **conditional** on the stored
 * value not having moved since it was observed, and that needs the store the engine deliberately does not
 * hold. Observing immediately before an unconditional write is not enough: a repair landing in between is
 * destroyed and reported as success, which is exactly what review reproduced at the previous head.
 */
describe('MaoApp.confirmQueueRecovery', () => {
  const corrupt = { 'task-1': { id: 'task-1' } }

  /**
   * A store whose queue can be repaired by a hook that runs at a chosen moment, so a concurrent repair
   * can be placed either side of the observation.
   */
  function racingStore() {
    const data: Record<string, unknown> = { workflowTasks: corrupt }
    const writes: unknown[] = []
    // Armed explicitly rather than by a read counter, because the boot observation already consumes one
    // read — counting from zero would place the repair before the confirm even looked.
    let repairOnNextRead = false
    const store = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => data[key] as MaoStoreSchema[K] | undefined,
        getFresh: <K extends keyof MaoStoreSchema>(key: K) => {
          const value = data[key] as MaoStoreSchema[K] | undefined
          if (key === 'workflowTasks' && repairOnNextRead) {
            // Another process repairs the queue *after* this read answers — i.e. between the observation
            // and the conditional write's compare.
            repairOnNextRead = false
            data.workflowTasks = [makePendingTask('repaired')]
          }
          return value
        },
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          data[key] = value
          if (key === 'workflowTasks') writes.push(value)
        },
      },
      '/tmp/config.json',
    )
    return {
      store,
      data,
      writes,
      armRepairAfterNextRead: () => {
        repairOnNextRead = true
      },
    }
  }

  function bootWith(store: ReturnType<typeof racingStore>['store']) {
    const { dataDir } = makeRealDataDir()
    return createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
  }

  it('refuses to write when the queue was repaired between the observation and the write', () => {
    // The finding. An unconditional write here returned 'replaced' and left the repaired queue replaced
    // by this process's empty one.
    captureWarnings()
    const racing = racingStore()
    const app = bootWith(racing.store)
    racing.armRepairAfterNextRead()

    const outcome = app.confirmQueueRecovery()

    expect(outcome).toEqual({ kind: 'superseded' })
    expect(racing.writes).toEqual([])
    expect(racing.data.workflowTasks).toEqual([makePendingTask('repaired')])
    // Still halted: nothing was replaced, so releasing would leave the engine running the wrong queue.
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
  })

  it('replaces and releases when nothing moved', () => {
    captureWarnings()
    const racing = racingStore()
    const app = bootWith(racing.store)

    const outcome = app.confirmQueueRecovery()

    expect(outcome).toEqual({ kind: 'replaced' })
    expect(racing.writes).toEqual([[]])
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(false)
  })

  it('writes nothing when the store cannot be read, and quotes no error', () => {
    captureWarnings()
    const { dataDir, store } = makeRealDataDirHolding({ workflowTasks: corrupt })
    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
    vi.spyOn(store, 'inspect').mockImplementation(() => {
      throw new Error("EACCES: permission denied, open '/tmp/ghp_secretish/config.json'")
    })
    const set = vi.spyOn(store, 'set')

    const outcome = app.confirmQueueRecovery()

    expect(outcome.kind).toBe('unverified')
    expect(set).not.toHaveBeenCalled()
    expect(outcome.kind === 'unverified' && outcome.reason).not.toContain('EACCES')
    expect(outcome.kind === 'unverified' && outcome.reason).not.toContain('ghp_secretish')
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
  })

  it('writes nothing, and stays halted, when the write throws', () => {
    captureWarnings()
    const racing = racingStore()
    const app = bootWith(racing.store)
    vi.spyOn(racing.store, 'setIfUnchanged').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })

    const outcome = app.confirmQueueRecovery()

    // No `reason` field at all, so there is nowhere for the backend's text to be carried.
    expect(outcome).toEqual({ kind: 'write-failed' })
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
  })

  it('writes nothing when the queue was already repaired before the observation', () => {
    captureWarnings()
    const racing = racingStore()
    const app = bootWith(racing.store)
    racing.data.workflowTasks = [makePendingTask('repaired')]

    const outcome = app.confirmQueueRecovery()

    expect(outcome).toEqual({ kind: 'already-readable' })
    expect(racing.writes).toEqual([])
    // Monotone: this process is still holding the coerced empty queue, so it must not release.
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
  })

  it('is a no-op on a host that was never halted', () => {
    const racing = racingStore()
    racing.data.workflowTasks = [makePendingTask('fine')]
    const app = bootWith(racing.store)

    expect(app.confirmQueueRecovery()).toEqual({ kind: 'already-readable' })
    expect(racing.writes).toEqual([])
  })
})

/**
 * `MaoApp.resaveStoredQueue()` — the late-corruption repair, and the stale-observation bug it had.
 *
 * Built separately on `WorkflowEngine.persistQueue()`, it emitted the in-memory queue with no fresh
 * observation at all. So: boot clean holding Q, the file goes unusable, the 30s poll shows the card, an
 * external repair writes a good queue Q2, the operator clicks — and Q overwrote Q2. That window is wider
 * than the compare→write residue, because it opens even when the repair finishes entirely before the
 * handler starts. It now shares `confirmQueueRecovery()`'s conditional sequence.
 */
describe('MaoApp.resaveStoredQueue', () => {
  const corrupt = { 'task-1': { id: 'task-1' } }

  /** A store that boots with a readable queue and can then be changed from "outside". */
  function externalStore(initial: unknown) {
    const data: Record<string, unknown> = { workflowTasks: initial }
    const writes: unknown[] = []
    const store = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => data[key] as MaoStoreSchema[K] | undefined,
        getFresh: <K extends keyof MaoStoreSchema>(key: K) => data[key] as MaoStoreSchema[K] | undefined,
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          data[key] = value
          if (key === 'workflowTasks') writes.push(value)
        },
      },
      '/tmp/config.json',
    )
    return { store, data, writes }
  }

  function bootClean() {
    const external = externalStore([makePendingTask('real')])
    const { dataDir } = makeRealDataDir()
    const app = createMaoApp({
      store: external.store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    return { ...external, app }
  }

  it('writes nothing when something else repaired the file before the click', () => {
    // The finding. The session is holding Q, the card was raised by a stale poll, and the file now holds
    // a different, perfectly good queue. Writing Q over it is the loss this whole feature exists to stop.
    captureWarnings()
    const booted = bootClean()
    expect(booted.app.workflowEngine.getTasks().map((t) => t.id)).toEqual(['real'])

    // The file goes unusable, then an external repair lands before the operator clicks.
    booted.data.workflowTasks = corrupt
    booted.data.workflowTasks = [makePendingTask('repaired-elsewhere')]

    const outcome = booted.app.resaveStoredQueue()

    expect(outcome).toEqual({ kind: 'already-readable' })
    expect(booted.writes).toEqual([])
    expect(booted.data.workflowTasks).toEqual([makePendingTask('repaired-elsewhere')])
  })

  it('rewrites the file from this session\'s queue while the value is still unusable', () => {
    captureWarnings()
    const booted = bootClean()
    booted.data.workflowTasks = corrupt

    const outcome = booted.app.resaveStoredQueue()

    expect(outcome).toEqual({ kind: 'replaced' })
    // The REAL queue, not an empty list — that is the whole difference from the discard.
    expect(booted.data.workflowTasks).toEqual([makePendingTask('real')])
    expect(booted.writes).toHaveLength(1)
  })

  it('refuses while the session is halted, so it cannot become a silent discard', () => {
    // A halted session's queue is the guard's empty list. Letting the repair path run there would write
    // `[]` over the file with none of the confirmation the discard requires.
    captureWarnings()
    const { dataDir, store } = makeRealDataDirHolding({ workflowTasks: corrupt })
    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
    const set = vi.spyOn(store, 'setIfUnchanged')

    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
    expect(app.resaveStoredQueue().kind).toBe('unverified')
    expect(set).not.toHaveBeenCalled()
  })

  it('writes nothing when the store cannot be read', () => {
    captureWarnings()
    const booted = bootClean()
    booted.data.workflowTasks = corrupt
    vi.spyOn(booted.store, 'inspect').mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const outcome = booted.app.resaveStoredQueue()

    expect(outcome.kind).toBe('unverified')
    expect(booted.writes).toEqual([])
    expect(outcome.kind === 'unverified' && outcome.reason).not.toContain('EACCES')
  })

  it('is a no-op on a healthy store', () => {
    const booted = bootClean()

    expect(booted.app.resaveStoredQueue()).toEqual({ kind: 'already-readable' })
    expect(booted.writes).toEqual([])
  })
})
