import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMaoApp, describeQueueWriteConflict } from './app.ts'
import {
  FileStore,
  STORE_RESTART_REQUIRED,
  createGuardedStore,
  type MaoStoreSchema,
} from './store.ts'
import { hasPersistenceBrokenMarker, writePersistenceBrokenMarker } from './persistence-guard.ts'
import type { AiProviderConfig } from './ai/types.ts'
import { QUEUE_PERSISTENCE_BROKEN, QueuePersistenceError, type QueuedTask } from './workflow-engine.ts'
import { createStoreWriteLock } from './store-file.ts'

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

const claudeProvider: AiProviderConfig = {
  id: 'claude',
  name: 'Claude',
  kind: 'cli',
  command: 'claude',
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
    //
    // The data write goes to a temporary file beside config.json and is renamed over it (issue #73), so
    // the failure is injected there, the way a full disk fails: the file is created, then the write of its
    // bytes runs out of space — which leaves a partial temporary file for the cleanup to remove.
    const realWriteFileSync = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      const name = String(file)
      if (name.includes('config.json')) {
        realWriteFileSync(file, '', ...(rest.slice(1) as [never]))
        throw new Error('ENOSPC: no space left on device')
      }
      return realWriteFileSync(file, ...(rest as [never]))
    })

    expect(() => store.set('workflowTasks', [])).toThrow(/ENOSPC/)
    expect(() => workflowEngine.emit('persistence-broken', new Error('disk full'))).not.toThrow()
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
    // The failed write leaves neither its lock nor its temporary file behind.
    expect(fs.readdirSync(dataDir).filter((name) => name.includes('config.json'))).toEqual([])
  })

  it('an also-broken marker write does not crash the persistence-broken handler', () => {
    const { dataDir, store } = makeRealDataDir()
    const { workflowEngine } = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })

    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk is completely gone')
    })

    expect(() => workflowEngine.emit('persistence-broken', new Error('disk full'))).not.toThrow()
  })

  it('marks an unknown queue-write outcome without leaking the backend error or rolling memory back', () => {
    const { dataDir } = makeRealDataDir()
    const data: Partial<MaoStoreSchema> = { workflowTasks: [] }
    const secret = 'ghp_backend_error_must_not_escape'
    const store = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => data[key],
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          data[key] = value
          if (key === 'workflowTasks') throw new Error(`write completed then failed: ${secret}`)
        },
      },
      '/tmp/config.json',
    )
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })

    let message = ''
    try {
      app.workflowEngine.enqueue('new', { owner: 'acme', repo: 'widgets' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('could not be persisted')
    expect(message).not.toContain(secret)
    expect(app.workflowEngine.getTasks()).toHaveLength(1)
    expect(data.workflowTasks).toHaveLength(1)
    expect(app.workflowEngine.isPersistenceBroken()).toBe(true)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
  })

  it('does not let an in-flight stage write the queue again after another mutation breaks persistence', async () => {
    const { dataDir } = makeRealDataDir()
    const data: Partial<MaoStoreSchema> = { workflowTasks: [] }
    let workflowTaskWrites = 0
    let failWorkflowTaskWrites = false
    const store = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => data[key],
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          // A copy, as both real backends store one (they serialize). Holding the engine's live array
          // instead would make the stage's in-place status change look like another writer's edit to the
          // conditional queue write (issue #73), which then refuses it.
          data[key] = structuredClone(value)
          if (key !== 'workflowTasks') return
          workflowTaskWrites += 1
          if (failWorkflowTaskWrites) {
            throw new Error('write may already have landed: ghp_must_not_escape')
          }
        },
      },
      '/tmp/config.json',
    )
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    let releasePreflight!: () => void
    vi.spyOn(app.githubService, 'assertRepoWorkflowWritable').mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePreflight = () => resolve(undefined as never)
        }),
    )

    const task = app.workflowEngine.enqueue('already in flight', { owner: 'acme', repo: 'widgets' })
    await vi.waitFor(() => expect(app.githubService.assertRepoWorkflowWritable).toHaveBeenCalledTimes(1))
    expect(workflowTaskWrites).toBe(2) // pending enqueue, then the stage's running entry

    failWorkflowTaskWrites = true
    expect(() => app.workflowEngine.setAutoAdvance(task.id, false)).toThrow(/could not be persisted/)
    expect(app.workflowEngine.isPersistenceBroken()).toBe(true)
    expect(workflowTaskWrites).toBe(3)

    // The backend is writable again only to make a forbidden second attempt observable. The in-flight
    // stage must see the latched persistence failure when its preflight settles; neither exit notify may
    // call the backend, because memory/disk/GitHub already have an unknown relationship.
    failWorkflowTaskWrites = false
    releasePreflight()
    await vi.waitFor(() =>
      expect(app.workflowEngine.getTasks().find((candidate) => candidate.id === task.id)?.status).toBe('error'),
    )

    expect(workflowTaskWrites).toBe(3)
    expect(app.workflowEngine.getTasks().find((candidate) => candidate.id === task.id)?.error).toBe(
      QUEUE_PERSISTENCE_BROKEN,
    )
    expect(app.workflowEngine.getPersistenceError()?.message).toBe(QUEUE_PERSISTENCE_BROKEN)
    expect(app.workflowEngine.getPersistenceError()?.message).not.toContain('ghp_must_not_escape')
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
  })

  it('marks persistence broken when an in-flight stage crosses a whole-file halt', async () => {
    const { dataDir, store } = makeRealDataDir()
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    let releasePreflight!: () => void
    vi.spyOn(app.githubService, 'assertRepoWorkflowWritable').mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePreflight = () => resolve(undefined as never)
        }),
    )

    const task = app.workflowEngine.enqueue('in flight', { owner: 'acme', repo: 'widgets' })
    await vi.waitFor(() => expect(app.githubService.assertRepoWorkflowWritable).toHaveBeenCalledTimes(1))
    const durableTasks = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'),
    ).workflowTasks as QueuedTask[]
    expect(durableTasks.find((candidate) => candidate.id === task.id)?.status).toBe('running')

    app.workflowEngine.requireQueueRecovery(STORE_RESTART_REQUIRED, { restartRequired: true })
    releasePreflight()
    await vi.waitFor(() => expect(app.workflowEngine.isPersistenceBroken()).toBe(true))

    expect(app.workflowEngine.getTasks().find((candidate) => candidate.id === task.id)?.status).toBe('error')
    // The exit state could not be written. Keeping durable `running` is acceptable only because the
    // independent marker now blocks restart from normalizing and auto-resuming it as pending.
    const tasksOnDisk = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'),
    ).workflowTasks as QueuedTask[]
    expect(tasksOnDisk.find((candidate) => candidate.id === task.id)?.status).toBe('running')
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
  })

  it('refuses to auto-resume — even when the caller asks for resume: true — once the marker file is present', async () => {
    const { dataDir, store } = makeRealDataDir()
    store.set('workflowTasks', [makePendingTask('leftover-task')])
    writePersistenceBrokenMarker(dataDir, new Error('disk full'))

    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })
    const { workflowEngine } = app

    // Give any (incorrectly) auto-started processing a chance to run — with no AI providers
    // registered, a resumed task would immediately flip to 'error'. It must stay untouched instead.
    await new Promise((r) => setTimeout(r, 20))

    const task = workflowEngine.getTasks().find((t) => t.id === 'leftover-task')!
    expect(task.status).toBe('pending')
    expect(workflowEngine.isPersistenceBroken()).toBe(true)
    expect(() =>
      workflowEngine.enqueue('must not wake the stale queue', { owner: 'acme', repo: 'widgets' }),
    ).toThrow(QUEUE_PERSISTENCE_BROKEN)
    expect(workflowEngine.getTasks()).toHaveLength(1)
    expect(app.confirmQueueRecovery()).toEqual({
      kind: 'unverified',
      reason: QUEUE_PERSISTENCE_BROKEN,
    })
    expect(app.resaveStoredQueue()).toEqual({
      kind: 'unverified',
      reason: QUEUE_PERSISTENCE_BROKEN,
    })
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

  it('rejects an invalid prospective task before memory, disk or persistence state can diverge', () => {
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: [] })
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    const { workflowEngine } = app
    const preflight = vi.spyOn(app.githubService, 'assertRepoWorkflowWritable')

    expect(() =>
      workflowEngine.enqueue(
        'Invalid override',
        { owner: 'acme', repo: 'widgets' },
        false,
        { effort: 'not-an-effort' } as never,
      ),
    ).toThrow(/Refusing to write "workflowTasks".*1 invalid entry/s)

    expect(workflowEngine.getTasks()).toEqual([])
    expect(preflight).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([])
    expect(workflowEngine.isPersistenceBroken()).toBe(false)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('rejects a new task before adoption when the config becomes unreadable after boot', () => {
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: [] })
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    const persist = vi.spyOn(store, 'set')
    const secret = 'ghp_late_corruption_must_stay_in_the_file'
    fs.writeFileSync(filePath, secret)

    expect(() =>
      app.workflowEngine.enqueueFromIssue(
        7,
        'https://github.com/acme/widgets/issues/7',
        'Must not remain pending in memory',
        { owner: 'acme', repo: 'widgets' },
      ),
    ).toThrow(/could not (?:be )?read/)

    expect(app.workflowEngine.getTasks()).toEqual([])
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
    expect(persist).not.toHaveBeenCalled()
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(secret)
    expect(app.workflowEngine.isPersistenceBroken()).toBe(false)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('latches before an existing task mutation can change memory after a late whole-file failure', () => {
    const task = { ...makePendingTask('existing-task'), autoAdvance: false }
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: [task] })
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    const persist = vi.spyOn(store, 'set')
    const secret = 'ghp_existing_task_mutation_must_not_escape'
    fs.writeFileSync(filePath, secret)

    expect(() => app.workflowEngine.setAutoAdvance(task.id, true)).toThrow(/could not (?:be )?read/)

    expect(app.workflowEngine.getTasks()[0]?.autoAdvance).toBe(false)
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
    expect(persist).not.toHaveBeenCalled()
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(secret)
    expect(app.workflowEngine.isPersistenceBroken()).toBe(false)
  })

  it('persists a task from a full registry entry using repository identity only', async () => {
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: [] })
    const { workflowEngine } = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })

    const task = workflowEngine.enqueue(
      'Registry settings stay out of tasks',
      { owner: 'acme', repo: 'widgets', autoTrigger: true, pollIntervalMs: null } as never,
      false,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(task.repo).toEqual({ owner: 'acme', repo: 'widgets' })
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks as QueuedTask[]
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.repo).toEqual({ owner: 'acme', repo: 'widgets' })
    expect(workflowEngine.isPersistenceBroken()).toBe(false)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })
})

describe('MaoApp.saveProviders', () => {
  it('refuses to overwrite a filtered provider view and preserves hidden API keys', () => {
    const hiddenKey = 'must-remain-only-in-config'
    const invalidProvider = {
      id: 'future-provider',
      name: 'Future provider',
      kind: 'api',
      apiFormat: 'future-format',
      apiKey: hiddenKey,
    }
    const rawProviders = [claudeProvider, invalidProvider]
    captureWarnings()
    const { dataDir, store, filePath } = makeRealDataDirHolding({ aiProviders: rawProviders })
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    const conditionalWrite = vi.spyOn(store, 'setIfUnchanged')
    const updateEngine = vi.spyOn(app.workflowEngine, 'setProviders')

    expect(() => app.saveProviders([claudeProvider])).toThrow(/filtered provider list.*Nothing was written/s)

    expect(conditionalWrite).not.toHaveBeenCalled()
    expect(updateEngine).not.toHaveBeenCalled()
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual(rawProviders)
    expect(fs.readFileSync(filePath, 'utf-8')).toContain(hiddenKey)
  })

  it('conditionally persists a clean list before updating the live engine', () => {
    const { dataDir, store, filePath } = makeRealDataDirHolding({ aiProviders: [claudeProvider] })
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    const updated = [{ ...claudeProvider, name: 'Claude updated' }]
    const updateEngine = vi.spyOn(app.workflowEngine, 'setProviders')

    expect(app.saveProviders(updated)).toEqual(updated)

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual(updated)
    expect(updateEngine).toHaveBeenCalledWith(updated)
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

  it('keeps readable tasks from a mixed queue but latches before any can resume', async () => {
    const warn = captureWarnings()
    const running = {
      ...makePendingTask('kept-task'),
      status: 'running' as const,
      active: {
        agentId: 'agent-a',
        agentName: 'Agent A',
        prompt: 'durable prompt must not be reported',
      },
    }
    const rawQueue = [running, null, { ...makePendingTask('broken-task'), github: null }]
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: rawQueue })

    const { workflowEngine } = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(workflowEngine.isQueueRecoveryLatched()).toBe(true)
    expect(workflowEngine.getQueueRecoveryReason()).toContain('2 invalid queued tasks')
    expect(workflowEngine.getQueueRecoveryReason()).not.toContain(running.active.prompt)
    // The readable task gets the ordinary restart normalization, but the latch prevents processing.
    expect(workflowEngine.getTasks()).toEqual([
      expect.objectContaining({ id: 'kept-task', status: 'pending', active: undefined }),
    ])
    expect(() =>
      workflowEngine.enqueueFromIssue(7, 'https://github.com/acme/widgets/issues/7', 'Fix it', {
        owner: 'acme',
        repo: 'widgets',
      }),
    ).toThrow(/workflowTasks/)
    // Filtering is a read view, not a silent repair; confirmation is what may discard durable entries.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual(rawQueue)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('confirmation writes only the readable tasks, and the next boot resumes them normally', async () => {
    const warn = captureWarnings()
    const kept = makePendingTask('kept-after-recovery')
    const rawQueue = [kept, null]
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: rawQueue })

    const first = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })
    expect(first.workflowEngine.getTasks()).toEqual([kept])
    expect(first.confirmQueueRecovery()).toEqual({ kind: 'replaced' })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([kept])

    warn.mockClear()
    const second = createMaoApp({
      store: new FileStore(filePath),
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(second.workflowEngine.isQueueRecoveryLatched()).toBe(false)
    const resumed = second.workflowEngine.getTasks().find((task) => task.id === kept.id)!
    expect(resumed.status).toBe('error')
    expect(resumed.error).toMatch(/no GitHub token is configured/)
    expect(warn).not.toHaveBeenCalled()
  })

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

  it('latches before the change listener is subscribed, so an ungated emit is rejected', () => {
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
    // Force the listener directly — this is what a future ungated emitter would do. It must reject rather
    // than silently skip persistence. A real runStage catches that rejection at its guarded exit and sets
    // persistenceBroken; a raw EventEmitter call has no such stage context and simply propagates it.
    expect(() => workflowEngine.emit('change', [makePendingTask('sneaky')])).toThrow()

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
 * left the first read saying "healthy" — no latch — while the second was corrected and restored. The
 * host then ran UNLATCHED holding an incomplete queue, auto-trigger ticked immediately, and the
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
    // Recovery writes through `store.setIfUnchanged` and emits nothing. The listener therefore needs
    // only the monotone engine state; re-observing here would add a whole-config read to every emission.
    const listener = appSource.slice(appSource.indexOf("workflowEngine.on('change'"))
    const body = listener.slice(0, listener.indexOf('})') + 2)

    expect(body).toContain('getQueueRecoveryReason()')
    expect(body).not.toContain('describeUnreadableQueue(')
    expect(body).not.toContain('problems()')
  })

  it('carries the durable marker into the engine and ands both blocks into safeToResume', () => {
    // resume=false alone is not a persistence-marker gate: a later enqueue calls processQueue. The
    // marker must seed the engine before restore, while safeToResume remains a second line of defence.
    const normalized = appSource.replace(/\s+/g, ' ')

    expect(normalized).toContain(
      'const persistenceRecoveryRequired = hasPersistenceBrokenMarker(dataDir) ' +
        'if (persistenceRecoveryRequired) workflowEngine.requirePersistenceRecovery()',
    )
    expect(normalized).toContain(
      'const safeToResume = resume && !persistenceRecoveryRequired && ' +
        '!workflowEngine.isQueueRecoveryLatched()',
    )
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
    // The composition root's persistence listener throws a nominal QueuePersistenceError, which lets a
    // public mutation roll back and an in-flight stage record a real persistence break. A generic gate in
    // notify() would erase that distinction and make unrelated observers look like failed storage.
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
  function racingStore(initial: unknown = corrupt) {
    const data: Record<string, unknown> = { workflowTasks: initial }
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

  it('retains valid tasks added to a still-mixed queue after boot', () => {
    captureWarnings()
    const atBoot = makePendingTask('at-boot')
    const addedLater = makePendingTask('added-later')
    const racing = racingStore([atBoot, null])
    const app = bootWith(racing.store)
    expect(app.workflowEngine.getTasks()).toEqual([atBoot])

    // Another process changes the still-unusable value after this host booted. The raw witness must
    // protect the compare, while the replacement must come from this fresh observation — reusing the
    // boot-time engine queue would silently delete `addedLater`.
    racing.data.workflowTasks = [atBoot, addedLater, null]

    expect(app.confirmQueueRecovery()).toEqual({ kind: 'replaced' })
    expect(racing.writes).toEqual([[atBoot, addedLater]])
    expect(racing.data.workflowTasks).toEqual([atBoot, addedLater])
    expect(app.workflowEngine.getTasks()).toEqual([atBoot, addedLater])
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(false)
  })

  it('preserves the readable durable task while normalizing its in-memory restart state', () => {
    captureWarnings()
    const running = {
      ...makePendingTask('running-at-recovery'),
      status: 'running' as const,
      active: { agentId: 'agent-a', agentName: 'Agent A', prompt: 'work in progress' },
    }
    const racing = racingStore([running, null])
    const app = bootWith(racing.store)

    expect(app.confirmQueueRecovery()).toEqual({ kind: 'replaced' })

    expect(racing.data.workflowTasks).toEqual([running])
    expect(app.workflowEngine.getTasks()).toEqual([
      expect.objectContaining({ id: running.id, status: 'pending', active: undefined }),
    ])
  })

  it('reports an invalid replacement separately from an attempted backend write', () => {
    captureWarnings()
    const racing = racingStore()
    const app = bootWith(racing.store)
    vi.spyOn(racing.store, 'setIfUnchanged').mockReturnValue('invalid')

    expect(app.confirmQueueRecovery()).toEqual({ kind: 'invalid-replacement' })
    expect(racing.writes).toEqual([])
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
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

    expect(outcome).toEqual({ kind: 'restart-required' })
    expect(set).not.toHaveBeenCalled()
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
    expect(app.workflowEngine.isQueueRecoveryRestartRequired()).toBe(true)
  })

  it('never writes after a whole-file outage, even when repair leaves only a field problem', () => {
    // Exact stale-snapshot regression: FileStore boots with theme=light and a recoverable queue field,
    // then loses the whole file. An external repair changes theme to dark but leaves workflowTasks
    // malformed. Looking only at the current field problem made confirm write the empty boot queue and
    // serialize theme=light over that repair.
    captureWarnings()
    const { dataDir, store, filePath } = makeRealDataDirHolding({
      theme: 'light',
      workflowTasks: corrupt,
    })
    const app = createMaoApp({
      store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    expect(app.workflowEngine.isQueueRecoveryRestartRequired()).toBe(false)

    fs.writeFileSync(filePath, 'not-json ghp_must_not_escape')
    expect(app.confirmQueueRecovery()).toEqual({ kind: 'restart-required' })
    expect(app.workflowEngine.isQueueRecoveryRestartRequired()).toBe(true)

    const repaired = { theme: 'dark', workflowTasks: { still: 'invalid' } }
    fs.writeFileSync(filePath, JSON.stringify(repaired))
    expect(app.confirmQueueRecovery()).toEqual({ kind: 'restart-required' })
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual(repaired)
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
  })

  it('writes nothing, and stays halted, when the write throws', () => {
    captureWarnings()
    const racing = racingStore()
    const { dataDir } = makeRealDataDir()
    const app = createMaoApp({
      store: racing.store,
      workspaceRoot: path.join(dataDir, 'workspaces'),
      dataDir,
      resume: false,
    })
    vi.spyOn(racing.store, 'setIfUnchanged').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device')
    })

    const outcome = app.confirmQueueRecovery()

    // No `reason` field at all, so there is nowhere for the backend's text to be carried.
    expect(outcome).toEqual({ kind: 'write-failed' })
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
    expect(app.workflowEngine.isPersistenceBroken()).toBe(true)
    expect(app.workflowEngine.getPersistenceError()?.message).toBe(QUEUE_PERSISTENCE_BROKEN)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
    expect(() => app.workflowEngine.enqueue('blocked', { owner: 'acme', repo: 'widgets' })).toThrow(
      QUEUE_PERSISTENCE_BROKEN,
    )
  })

  it('writes nothing when the queue was already repaired before the observation', () => {
    captureWarnings()
    const racing = racingStore()
    const app = bootWith(racing.store)
    racing.data.workflowTasks = [makePendingTask('repaired')]

    const outcome = app.confirmQueueRecovery()

    expect(outcome).toEqual({ kind: 'already-readable' })
    expect(racing.writes).toEqual([])
    // Monotone: this process may still hold a filtered startup subset, so it must not release.
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
    return { ...external, app, dataDir }
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
    // A halted session's queue is only the guard's startup subset. Letting the repair path run there
    // would write it over the file with none of the confirmation the discard requires.
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

    expect(outcome).toEqual({ kind: 'restart-required' })
    expect(booted.writes).toEqual([])
    expect(booted.app.workflowEngine.isQueueRecoveryRestartRequired()).toBe(true)
  })

  it('records an independent persistence block when the conditional save throws', () => {
    captureWarnings()
    const booted = bootClean()
    booted.data.workflowTasks = corrupt
    vi.spyOn(booted.store, 'setIfUnchanged').mockImplementation(() => {
      throw new Error('write completed then failed: ghp_must_not_escape')
    })

    expect(booted.app.resaveStoredQueue()).toEqual({ kind: 'write-failed' })
    expect(booted.app.workflowEngine.isPersistenceBroken()).toBe(true)
    expect(booted.app.workflowEngine.getPersistenceError()?.message).toBe(QUEUE_PERSISTENCE_BROKEN)
    expect(hasPersistenceBrokenMarker(booted.dataDir)).toBe(true)
    expect(() =>
      booted.app.workflowEngine.enqueue('must reconcile first', { owner: 'acme', repo: 'widgets' }),
    ).toThrow(QUEUE_PERSISTENCE_BROKEN)
  })

  it('is a no-op on a healthy store', () => {
    const booted = bootClean()

    expect(booted.app.resaveStoredQueue()).toEqual({ kind: 'already-readable' })
    expect(booted.writes).toEqual([])
  })
})

/**
 * The real `mao run` queue-persistence path against a second process on the same `config.json` — issue
 * #73 end to end.
 *
 * `mao run` is `createMaoApp` over one `FileStore` kept for the life of the process, and its `'change'`
 * listener writes the queue on every transition. These drive that listener through a real engine
 * mutation (`setAutoAdvance`, which persists without starting a stage) while another `FileStore` — a
 * one-shot command in another terminal — changes the same file.
 */
describe('mao run queue persistence beside another process (issue #73)', () => {
  function pausedTask(id = 'task-1'): QueuedTask {
    return { ...makePendingTask(id), status: 'paused' }
  }

  /** A long-running host booted the way `mao run` boots, over `contents`. */
  function bootLongRunning(contents: Record<string, unknown>) {
    const { dataDir, store, filePath } = makeRealDataDirHolding(contents)
    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
    return { dataDir, filePath, app }
  }

  /** A one-shot command opened afterwards on the same file, as `loadApp()` opens one. */
  function oneShot(dataDir: string, filePath: string) {
    return createMaoApp({ store: new FileStore(filePath), workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
  }

  const onDisk = (filePath: string) => JSON.parse(fs.readFileSync(filePath, 'utf-8'))

  it("does not revert another process's settings when it persists its queue", () => {
    const { dataDir, filePath, app } = bootLongRunning({
      githubToken: 'ghp_original',
      githubRepos: [{ owner: 'acme', repo: 'gadgets' }],
      workflowTasks: [pausedTask()],
    })
    const other = new FileStore(filePath)

    other.set('githubToken', 'ghp_rotated')
    other.set('githubRepos', [])
    other.set('aiProviders', [claudeProvider])
    other.set('theme', 'dark')
    app.workflowEngine.setAutoAdvance('task-1', true)

    const stored = onDisk(filePath)
    expect(stored.githubToken).toBe('ghp_rotated')
    expect(stored.githubRepos).toEqual([])
    expect(stored.aiProviders).toEqual([claudeProvider])
    expect(stored.theme).toBe('dark')
    expect(stored.workflowTasks[0].autoAdvance).toBe(true)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('keeps a `mao repos remove` recovery of an unusable githubRepos (PR #66)', async () => {
    // The issue's second reproduction: the long-running host booted holding the object-shaped list; the
    // recovery its own report recommends runs in another terminal and says it worked; the host's next
    // queue change used to put the object straight back.
    captureWarnings()
    const { dataDir, filePath, app } = bootLongRunning({
      githubRepos: { 'acme/widgets': { owner: 'acme', repo: 'widgets' } },
      workflowTasks: [pausedTask()],
    })

    await oneShot(dataDir, filePath).updateRepos((previous) => previous.filter((r) => r.repo !== 'widgets'))
    expect(onDisk(filePath).githubRepos).toEqual([])

    app.workflowEngine.setAutoAdvance('task-1', true)

    expect(onDisk(filePath).githubRepos).toEqual([])
    expect(new FileStore(filePath).problems()).toEqual([])
  })

  it('chains its own writes without mistaking them for another process', () => {
    const { dataDir, filePath, app } = bootLongRunning({ workflowTasks: [pausedTask()] })

    app.workflowEngine.setAutoAdvance('task-1', true)
    app.workflowEngine.setAutoAdvance('task-1', false)
    app.workflowEngine.setAutoAdvance('task-1', true)

    expect(onDisk(filePath).workflowTasks[0].autoAdvance).toBe(true)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('refuses to overwrite a queue another process changed, and writes nothing', () => {
    // Same key, two writers: the one-shot advanced the queue after the host loaded it. Writing the host's
    // queue would silently drop that change — the lost update the issue asks to make explicit.
    const { filePath, app } = bootLongRunning({ githubToken: 'ghp_SENTINEL_SECRET', workflowTasks: [pausedTask()] })
    // Written straight through another store rather than via an enqueue, which would also start that
    // process's queue running in the background of the test.
    new FileStore(filePath).set('workflowTasks', [pausedTask(), pausedTask('added-elsewhere')])
    const theirs = onDisk(filePath).workflowTasks

    let message = ''
    try {
      app.workflowEngine.setAutoAdvance('task-1', true)
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toBe(describeQueueWriteConflict())
    expect(message).not.toContain('ghp_SENTINEL_SECRET')
    expect(onDisk(filePath).workflowTasks).toEqual(theirs)
  })

  it('stops running stages — via the existing persistence-broken safeguard — before any GitHub call', async () => {
    // What a refused write costs in practice: the stage's entry notify is the refused write, so the task
    // parks in 'error', the retry is refused too, and persistenceBroken plus its durable marker stop this
    // engine. A second engine on the same queue is two engines able to repeat the same GitHub work.
    const { dataDir, filePath, app } = bootLongRunning({ workflowTasks: [makePendingTask('task-1')] })
    const preflight = vi.spyOn(app.githubService, 'assertRepoWorkflowWritable')
    oneShot(dataDir, filePath).workflowEngine.setAutoAdvance('task-1', true)
    const theirs = onDisk(filePath).workflowTasks

    app.workflowEngine.resumeProcessing()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(app.workflowEngine.isPersistenceBroken()).toBe(true)
    expect(app.workflowEngine.getPersistenceError()?.message).toBe(describeQueueWriteConflict())
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
    expect(preflight).not.toHaveBeenCalled()
    expect(onDisk(filePath).workflowTasks).toEqual(theirs)
  })

  it('still restores a queue that went unusable after a clean boot, as the late-corruption card promises', () => {
    // An unusable value is not another writer's queue: this session holds the real one, and its next
    // write is documented to restore the file from it. Other keys survive that repair too.
    captureWarnings()
    const { dataDir, filePath, app } = bootLongRunning({ githubToken: 'ghp_original', workflowTasks: [pausedTask()] })
    fs.writeFileSync(filePath, JSON.stringify({ ...onDisk(filePath), workflowTasks: { broken: true } }))

    app.workflowEngine.setAutoAdvance('task-1', true)

    expect(onDisk(filePath).workflowTasks).toEqual([{ ...pausedTask(), autoAdvance: true }])
    expect(onDisk(filePath).githubToken).toBe('ghp_original')
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('still repairs a mixed value whose only readable tasks are its own', () => {
    captureWarnings()
    const { dataDir, filePath, app } = bootLongRunning({ workflowTasks: [pausedTask()] })
    fs.writeFileSync(filePath, JSON.stringify({ ...onDisk(filePath), workflowTasks: [pausedTask(), null] }))

    app.workflowEngine.setAutoAdvance('task-1', true)

    expect(onDisk(filePath).workflowTasks).toEqual([{ ...pausedTask(), autoAdvance: true }])
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it("refuses to 'repair' a mixed value that holds another process's readable task", () => {
    // Another host wrote [task-1, added-elsewhere] — which this host would refuse — and then the value went
    // mixed (a hand-edit, or a build whose task shape this one rejects). Treating that as a late
    // corruption of this session's own queue would delete added-elsewhere.
    captureWarnings()
    const { filePath, app } = bootLongRunning({ workflowTasks: [pausedTask()] })
    const theirs = [pausedTask(), pausedTask('added-elsewhere'), null]
    fs.writeFileSync(filePath, JSON.stringify({ ...onDisk(filePath), workflowTasks: theirs }))

    expect(() => app.workflowEngine.setAutoAdvance('task-1', true)).toThrow(describeQueueWriteConflict())
    expect(onDisk(filePath).workflowTasks).toEqual(theirs)
  })

  it('recognizes its own boot tasks in an older build\'s form, so a late corruption is still repaired', () => {
    // Stored before #77: the task's repo still carries registry settings. The guard normalizes it on read,
    // so it never matched its own raw boot serialization and the repair read it as another host's task.
    captureWarnings()
    const legacy = { ...pausedTask(), repo: { owner: 'acme', repo: 'widgets', autoTrigger: true } }
    const { dataDir, filePath, app } = bootLongRunning({ workflowTasks: [legacy] })
    fs.writeFileSync(filePath, JSON.stringify({ ...onDisk(filePath), workflowTasks: [legacy, null] }))

    app.workflowEngine.setAutoAdvance('task-1', true)

    expect(onDisk(filePath).workflowTasks).toEqual([{ ...pausedTask(), autoAdvance: true }])
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it("refuses to re-save this session's queue over another host's readable task", () => {
    // "Save this session's queue now" writes this session's queue over the unusable value — the same
    // deletion the automatic repair refuses, so it refuses too, and says why.
    captureWarnings()
    const { filePath, app } = bootLongRunning({ workflowTasks: [pausedTask()] })
    const theirs = [pausedTask(), pausedTask('added-elsewhere'), null]
    fs.writeFileSync(filePath, JSON.stringify({ ...onDisk(filePath), workflowTasks: theirs }))

    const outcome = app.resaveStoredQueue()

    expect(outcome.kind).toBe('unverified')
    expect(outcome.kind === 'unverified' && outcome.reason).toMatch(/readable tasks this session never loaded or wrote/)
    // And it does not send the operator to the discard while this session is still live.
    expect(outcome.kind === 'unverified' && outcome.reason).toMatch(/with no MAO host running/)
    expect(onDisk(filePath).workflowTasks).toEqual(theirs)
  })

  it("recognizes a stale copy of its own task — an editor buffer saved late — as its own", () => {
    // The third review's reproduction. The session wrote a change, then an editor holding the file from
    // before that write saved it with a typo: [task-1 in its boot form, null]. That is this session's own
    // past state, so the re-save repairs it and later writes go through — where recognising only the last
    // write refused it as "another MAO host's" and left the session unable to persist at all.
    captureWarnings()
    const { dataDir, filePath, app } = bootLongRunning({ workflowTasks: [pausedTask()] })
    app.workflowEngine.setAutoAdvance('task-1', true)
    fs.writeFileSync(filePath, JSON.stringify({ ...onDisk(filePath), workflowTasks: [pausedTask(), null] }))

    expect(app.resaveStoredQueue()).toEqual({ kind: 'replaced' })
    app.workflowEngine.setAutoAdvance('task-1', false)

    expect(onDisk(filePath).workflowTasks).toEqual([pausedTask()])
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('still recognizes a task it cleared itself, when a stale copy of it comes back', () => {
    // An editor read the file, then "Clear completed" ran, then the editor saved late with a typo. The done
    // task in that buffer is this session's own past state; forgetting it at removal refused the re-save
    // as another host's work and left the session unable to persist.
    captureWarnings()
    const done = { ...pausedTask('task-2'), status: 'done' as const }
    const { filePath, app } = bootLongRunning({ workflowTasks: [pausedTask(), done] })
    app.workflowEngine.clearCompleted()
    fs.writeFileSync(filePath, JSON.stringify({ ...onDisk(filePath), workflowTasks: [pausedTask(), done, null] }))

    expect(app.resaveStoredQueue()).toEqual({ kind: 'replaced' })
    expect(onDisk(filePath).workflowTasks).toEqual([pausedTask()])
  })

  it('never forgets a task still in the queue, however many there are', () => {
    // The fifth review's reproduction: a busy repo can queue more than the bound. Evicting live tasks made
    // this process's own late-corrupted queue read as another host's, refusing both the re-save and the
    // automatic repair.
    captureWarnings()
    const tasks = Array.from({ length: 1_001 }, (_, i) => pausedTask(`task-${i}`))
    const { filePath, app } = bootLongRunning({ workflowTasks: tasks })
    fs.writeFileSync(filePath, JSON.stringify({ workflowTasks: [...tasks, null] }))

    expect(app.resaveStoredQueue()).toEqual({ kind: 'replaced' })
  })

  it('forgets only the least-recently-removed tasks once past its bound', () => {
    // Bounded so a host that runs for months does not keep every form of every task it ever removed: with
    // one removed id past the bound, the earliest removed is forgotten and the rest still count as its own.
    captureWarnings()
    const done = Array.from({ length: 1_001 }, (_, i) => ({ ...pausedTask(`done-${i}`), status: 'done' as const }))
    const { filePath, app } = bootLongRunning({ workflowTasks: [pausedTask(), ...done] })
    app.workflowEngine.clearCompleted()

    fs.writeFileSync(filePath, JSON.stringify({ workflowTasks: [pausedTask(), done[0], null] }))
    expect(app.resaveStoredQueue().kind).toBe('unverified')
    fs.writeFileSync(filePath, JSON.stringify({ workflowTasks: [pausedTask(), done[1_000], null] }))
    expect(app.resaveStoredQueue()).toEqual({ kind: 'replaced' })
  })

  it('repairs the same stale own copy automatically on its next queue write', () => {
    captureWarnings()
    const { filePath, app } = bootLongRunning({ workflowTasks: [pausedTask()] })
    app.workflowEngine.setAutoAdvance('task-1', true)
    fs.writeFileSync(filePath, JSON.stringify({ ...onDisk(filePath), workflowTasks: [pausedTask(), null] }))

    app.workflowEngine.setAutoAdvance('task-1', false)

    expect(onDisk(filePath).workflowTasks).toEqual([pausedTask()])
  })

  it('rolls back a task whose enqueue write was refused, so it cannot be persisted twice later', () => {
    const { filePath, app } = bootLongRunning({ workflowTasks: [pausedTask()] })
    new FileStore(filePath).set('workflowTasks', [pausedTask(), pausedTask('added-elsewhere')])

    expect(() => app.workflowEngine.enqueue('Refused', { owner: 'acme', repo: 'widgets' }, false)).toThrow(
      describeQueueWriteConflict(),
    )
    expect(app.workflowEngine.getTasks().map((t) => t.id)).toEqual(['task-1'])
  })

  it('reports a queue write blocked by another writer\'s lock as nothing written, so the change rolls back', () => {
    // The lock was never taken, so nothing reached the file — a stronger statement than "unknown", which
    // would trip persistenceBroken and the durable marker over another process merely being slow.
    captureWarnings()
    const { dataDir, filePath } = makeRealDataDirHolding({ workflowTasks: [pausedTask()] })
    const store = new FileStore(filePath, { lock: { timeoutMs: 20 } })
    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })

    let refused: unknown
    createStoreWriteLock(filePath)(() => {
      try {
        app.workflowEngine.setAutoAdvance('task-1', true)
      } catch (err) {
        refused = err
      }
    })

    expect(refused).toBeInstanceOf(QueuePersistenceError)
    expect((refused as QueuePersistenceError).writeState).toBe('not-written')
    expect((refused as Error).message).toMatch(/Another MAO process is writing/)
    expect(app.workflowEngine.getTasks()[0]?.autoAdvance).toBe(false)
    expect(app.workflowEngine.isPersistenceBroken()).toBe(false)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
    // Once the other writer is done, the same change goes through on the same base.
    app.workflowEngine.setAutoAdvance('task-1', true)
    expect(onDisk(filePath).workflowTasks).toEqual([{ ...pausedTask(), autoAdvance: true }])
  })

  it('halts until restart when the queue write cannot read the stored queue to compare it', () => {
    // The readiness probe ran just before and saw a readable file, so this is the file failing in the
    // interval — the same whole-file outage the probe and `healStoredQueue()` treat as restart-required.
    captureWarnings()
    const { dataDir, filePath, app } = bootLongRunning({ workflowTasks: [pausedTask()] })
    vi.spyOn(app.store, 'setIfUnchanged').mockReturnValueOnce('unverifiable')

    let refused: unknown
    try {
      app.workflowEngine.setAutoAdvance('task-1', true)
    } catch (err) {
      refused = err
    }

    expect((refused as QueuePersistenceError).writeState).toBe('not-written')
    expect((refused as Error).message).toBe(STORE_RESTART_REQUIRED)
    expect(app.workflowEngine.isQueueRecoveryRestartRequired()).toBe(true)
    expect(app.workflowEngine.getTasks()[0]?.autoAdvance).toBe(false)
    expect(onDisk(filePath).workflowTasks).toEqual([pausedTask()])
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('reports a lockless replacement landing inside a recovery as restart-required, writing nothing', () => {
    // The compare passed, then a writer that takes no lock replaced the file before the write's own merge
    // read. FileStore refuses that read before writing anything, so this is a whole-file outage — not an
    // unknown outcome to record as persistence-broken.
    captureWarnings()
    const { dataDir, filePath, app } = bootLongRunning({ githubToken: 'ghp_keep', workflowTasks: [pausedTask(), null] })
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)
    let reads = 0
    const realReadFileSync = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      // 1: healStoredQueue's observation; 2: setIfUnchanged's compare; 3: FileStore.writeKey's merge read.
      if (String(file) === filePath && ++reads === 3) fs.writeFileSync(filePath, '{ truncated')
      return (realReadFileSync as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof fs.readFileSync)

    const outcome = app.confirmQueueRecovery()
    vi.restoreAllMocks()

    expect(reads).toBe(3)
    expect(outcome).toEqual({ kind: 'restart-required' })
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{ truncated')
    expect(app.workflowEngine.isQueueRecoveryRestartRequired()).toBe(true)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it("refuses to overwrite a healthy queue another process changed, even when it holds only this one's tasks", () => {
    // Another terminal ran `clear-completed` on this host's queue. Every task left in the file is one
    // this process wrote, but the value is healthy — the repair exception is for an unusable value only —
    // so writing over it would bring back the tasks the other process cleared.
    captureWarnings()
    const done: QueuedTask = { ...pausedTask('task-2'), status: 'done' }
    const { filePath, app } = bootLongRunning({ workflowTasks: [pausedTask(), done] })
    app.workflowEngine.setAutoAdvance('task-1', true)
    const cleared = [{ ...pausedTask(), autoAdvance: true }]
    new FileStore(filePath).set('workflowTasks', cleared)

    expect(() => app.workflowEngine.setAutoAdvance('task-1', false)).toThrow(describeQueueWriteConflict())
    expect(onDisk(filePath).workflowTasks).toEqual(cleared)
  })

  it('treats its own queue recovery as the base of its next write', () => {
    // Without recording the recovery's write as this process's own, the very next queue change would see
    // a queue it did not write and refuse — wedging the host the moment it was released.
    captureWarnings()
    const { dataDir, filePath, app } = bootLongRunning({ workflowTasks: [pausedTask(), null] })
    expect(app.workflowEngine.isQueueRecoveryLatched()).toBe(true)

    expect(app.confirmQueueRecovery()).toEqual({ kind: 'replaced' })
    app.workflowEngine.setAutoAdvance('task-1', true)

    expect(onDisk(filePath).workflowTasks).toEqual([{ ...pausedTask(), autoAdvance: true }])
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })
})

/**
 * `MaoApp.saveProviders` with the list Global settings loaded (issue #73). The save-time observation
 * only covers the instant of the save; what the editor's list was derived from is the load, so a
 * provider import from a terminal in between must not be deleted — API keys and all — by the next Save.
 */
describe('MaoApp.saveProviders against the list the editor loaded', () => {
  const imported: AiProviderConfig = { id: 'imported', name: 'Imported', kind: 'api', apiKey: 'sk-test-imported' }

  function bootWithProviders() {
    const { dataDir, store, filePath } = makeRealDataDirHolding({ aiProviders: [claudeProvider] })
    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
    return { app, filePath }
  }

  it('refuses a save over a list another process changed after the editor loaded it, writing nothing', () => {
    const { app, filePath } = bootWithProviders()
    const loaded = [claudeProvider]
    // `mao config import-providers` in a terminal while Global settings is open.
    new FileStore(filePath).set('aiProviders', [claudeProvider, imported])

    expect(() => app.saveProviders([{ ...claudeProvider, name: 'Renamed' }], loaded)).toThrow(
      /changed after Global settings loaded it/,
    )
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([claudeProvider, imported])
  })

  it('saves when the stored list is still the one the editor loaded', () => {
    const { app, filePath } = bootWithProviders()

    expect(app.saveProviders([{ ...claudeProvider, name: 'Renamed' }], [claudeProvider])).toEqual([
      { ...claudeProvider, name: 'Renamed' },
    ])
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([{ ...claudeProvider, name: 'Renamed' }])
  })

  it('keeps the save-time check alone for a caller with no editor load to compare against', () => {
    const { app, filePath } = bootWithProviders()
    new FileStore(filePath).set('aiProviders', [claudeProvider, imported])

    app.saveProviders([claudeProvider])

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([claudeProvider])
  })
})
