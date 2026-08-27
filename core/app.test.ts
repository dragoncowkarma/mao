import { describe, expect, it, vi } from 'vitest'
import { createMaoApp } from './app.ts'
import { MAO_STORE_DEFAULTS, type MaoStore, type MaoStoreSchema } from './store.ts'
import type { QueuedTask } from './workflow-engine.ts'

/** In-memory MaoStore for tests — tracks every set() call so we can assert what got persisted. */
function makeFakeStore(overrides: Partial<MaoStoreSchema> = {}): MaoStore & { data: MaoStoreSchema } {
  const data: MaoStoreSchema = { ...MAO_STORE_DEFAULTS, ...overrides }
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
  }
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
  it('durably records a confirmed WorkflowEngine persistence failure via a separate store write', () => {
    const store = makeFakeStore()
    const { workflowEngine } = createMaoApp({ store, workspaceRoot: '/tmp/mao-test', resume: false })

    expect(store.get('workflowPersistenceBroken')).toBe(false)
    workflowEngine.emit('persistence-broken', new Error('disk full'))
    expect(store.get('workflowPersistenceBroken')).toBe(true)
  })

  it('a store.set() that also throws for the durable flag does not crash the persistence-broken handler', () => {
    const store = makeFakeStore()
    const realSet = store.set.bind(store)
    store.set = vi.fn((key, value) => {
      if (key === 'workflowPersistenceBroken') throw new Error('store is completely gone')
      realSet(key, value)
    }) as MaoStore['set']
    const { workflowEngine } = createMaoApp({ store, workspaceRoot: '/tmp/mao-test', resume: false })

    expect(() => workflowEngine.emit('persistence-broken', new Error('disk full'))).not.toThrow()
  })

  it('refuses to auto-resume — even when the caller asks for resume: true — once workflowPersistenceBroken is set', async () => {
    const store = makeFakeStore({
      workflowPersistenceBroken: true,
      workflowTasks: [makePendingTask('leftover-task')],
    })
    const { workflowEngine } = createMaoApp({ store, workspaceRoot: '/tmp/mao-test', resume: true })

    // Give any (incorrectly) auto-started processing a chance to run — with no AI providers
    // registered, a resumed task would immediately flip to 'error'. It must stay untouched instead.
    await new Promise((r) => setTimeout(r, 20))

    const task = workflowEngine.getTasks().find((t) => t.id === 'leftover-task')!
    expect(task.status).toBe('pending')
  })

  it('still auto-resumes normally when workflowPersistenceBroken is false', async () => {
    const store = makeFakeStore({
      workflowPersistenceBroken: false,
      workflowTasks: [makePendingTask('leftover-task-2')],
    })
    const { workflowEngine } = createMaoApp({ store, workspaceRoot: '/tmp/mao-test', resume: true })

    // No AI providers registered, so the resumed stage fails fast and predictably — proving
    // processing actually started (as opposed to the task sitting untouched at 'pending').
    await new Promise((r) => setTimeout(r, 20))

    const task = workflowEngine.getTasks().find((t) => t.id === 'leftover-task-2')!
    expect(task.status).toBe('error')
    expect(task.error).toMatch(/No AI providers registered/)
  })
})
