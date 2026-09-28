import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMaoApp } from './app.ts'
import { FileStore } from './store.ts'
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
 * a hand-edited file, or one an older build wrote, can, and that is the whole subject of the boot
 * regressions below.
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
 * The boot path, against the corruption that used to close it entirely.
 *
 * A non-array `workflowTasks` reached `WorkflowEngine.restore()`'s `tasks.map(...)` from inside
 * `createMaoApp()` — the single composition root both shells call — so `loadApp()` threw and *every* `mao`
 * command failed, including the `mao repos remove` that issue #60's own recovery path depends on, and
 * `registerIpcHandlers()` threw before registering a single channel, leaving the GUI with a preload bridge
 * that had nothing behind it. There was no in-app recovery of any kind.
 *
 * These tests also pin the decision that `core/store.ts` documents at length: an unreadable queue does
 * **not** write the persistence-broken marker and does **not** block auto-resume, because the coerced
 * queue is empty and resuming nothing cannot duplicate work — while the marker is sticky, operator-gated
 * and describes a write failure that has not happened.
 */
describe('createMaoApp against a config.json whose workflowTasks is not a list', () => {
  it('boots, with an empty queue instead of a throw', () => {
    const warn = captureWarnings()
    const { dataDir, store } = makeRealDataDirHolding({ workflowTasks: { 'task-1': makePendingTask('t1') } })

    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })

    expect(app.workflowEngine.getTasks()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0] as string).toContain('"workflowTasks"')
  })

  it('boots with resume: true too, and resuming an empty queue touches nothing', async () => {
    // The reason blocking auto-resume would protect nothing: `resumeProcessing()` reaches a
    // `processQueue()` that iterates an empty queue and returns. No provider call, no GitHub write, no
    // task to mislabel. Contrast the existing "still auto-resumes normally" test above, where one
    // pending task is enough to reach the stage preflight within the same 20ms.
    captureWarnings()
    const { dataDir, store } = makeRealDataDirHolding({ workflowTasks: 'task-1' })

    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: true })
    await new Promise((r) => setTimeout(r, 20))

    expect(app.workflowEngine.getTasks()).toEqual([])
    expect(app.workflowEngine.isPersistenceBroken()).toBe(false)
  })

  it('does not write the persistence-broken marker', () => {
    // The decision, pinned. The marker records that a process could no longer *persist* — a write
    // failure whose hazard is a stale queue whose entries re-run work already done. This is a read-shape
    // problem with no entries and working writes, so claiming it would make `mao config show` answer
    // `workflowPersistenceBroken: true` about persistence that is fine.
    captureWarnings()
    const { dataDir, store } = makeRealDataDirHolding({ workflowTasks: { 'task-1': makePendingTask('t1') } })

    createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: true })

    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('leaves the unusable value on disk, because booting is not a repair', () => {
    // `restore()` deliberately does not emit `'change'`, so the `store.set` that createMaoApp subscribes
    // never fires on boot. That is what makes the report's "copy anything you still need out of <file>
    // first" advice truthful for a one-shot command like `mao config show`.
    captureWarnings()
    const corrupt = { 'task-1': makePendingTask('t1') }
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: corrupt })

    createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: true })

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual(corrupt)
  })

  it('reaches a healthy, persisted queue through the write the report names', () => {
    // `mao workflow clear-completed` end to end: `clearCompleted()` calls `notify()` unconditionally, so
    // it persists even having removed nothing, and it makes no GitHub call. The reopen matters — the
    // recovery has to survive the process that performed it.
    const warn = captureWarnings()
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: { 'task-1': makePendingTask('t1') } })

    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
    app.workflowEngine.clearCompleted()

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)

    warn.mockClear()
    expect(new FileStore(filePath).get('workflowTasks')).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves auto-resume working for the next real queue', async () => {
    // What writing the marker would have cost, and the reason it is the wrong mechanism: the marker is
    // sticky and only `mao config clear-persistence-broken` lifts it, so it would outlive the corruption
    // and keep blocking auto-resume of every later, legitimate queue. The read problem heals on the very
    // next queue write; the block would not have.
    const warn = captureWarnings()
    const { dataDir, store, filePath } = makeRealDataDirHolding({ workflowTasks: 'task-1' })

    createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })
    store.set('workflowTasks', [makePendingTask('leftover-after-recovery')])
    warn.mockClear()

    const healed = new FileStore(filePath)
    const app = createMaoApp({ store: healed, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: true })
    // No GitHub token configured, so runStage's repo-permission preflight rejects the resumed stage —
    // failing fast and predictably, which is what proves processing actually started.
    await new Promise((r) => setTimeout(r, 20))

    const task = app.workflowEngine.getTasks().find((t) => t.id === 'leftover-after-recovery')!
    expect(task.status).toBe('error')
    expect(task.error).toMatch(/no GitHub token is configured/)
    expect(warn).not.toHaveBeenCalled()
  })
})

/**
 * The same boot, with `aiProviders` corrupt instead. It never blocked boot — `setProviders()` only
 * assigns — but it killed `mao config show` on `.map` and white-screened the GUI's Global settings pane,
 * which renders `providers.map` with no error boundary above it.
 */
describe('createMaoApp against a config.json whose aiProviders is not a list', () => {
  it('boots with no providers registered, and says so once', () => {
    const warn = captureWarnings()
    const { dataDir, store } = makeRealDataDirHolding({ aiProviders: { claude: { id: 'claude' } } })

    const app = createMaoApp({ store, workspaceRoot: path.join(dataDir, 'workspaces'), dataDir, resume: false })

    expect(app.workflowEngine.getTasks()).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0] as string).toContain('"aiProviders"')
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })
})
