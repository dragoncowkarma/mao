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

    // No AI providers registered, so the resumed stage fails fast and predictably — proving
    // processing actually started (as opposed to the task sitting untouched at 'pending').
    await new Promise((r) => setTimeout(r, 20))

    const task = workflowEngine.getTasks().find((t) => t.id === 'leftover-task-2')!
    expect(task.status).toBe('error')
    expect(task.error).toMatch(/No AI providers registered/)
  })
})
