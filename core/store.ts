import fs from 'node:fs'
import path from 'node:path'
import type { AiProviderConfig } from './ai/types.ts'
import type { QueuedTask, RepoRef } from './workflow-engine.ts'

/**
 * UI color scheme preference. 'system' follows the OS-level `prefers-color-scheme` media query and
 * is the default — it's the only option that doesn't require the user to make a choice up front.
 */
export type ThemePreference = 'light' | 'dark' | 'system'

export interface MaoStoreSchema {
  githubToken: string
  githubRepos: RepoRef[]
  aiProviders: AiProviderConfig[]
  workflowTasks: QueuedTask[]
  theme: ThemePreference
  /**
   * Set (best-effort, from createMaoApp's 'persistence-broken' handler) when the WorkflowEngine
   * confirms it can no longer durably persist queue state — see WorkflowEngine.isPersistenceBroken().
   * createMaoApp checks this on every boot and refuses to auto-resume the queue while it's true,
   * even when the caller asked for resume: true — the on-disk workflowTasks snapshot may predate a
   * GitHub side effect that already happened, and blindly resuming risks re-running (duplicating)
   * it. An operator must confirm the queue is safe and clear this explicitly (see
   * `mao config clear-persistence-broken`) before auto-resume runs again.
   */
  workflowPersistenceBroken: boolean
}

export const MAO_STORE_DEFAULTS: MaoStoreSchema = {
  githubToken: '',
  githubRepos: [],
  aiProviders: [],
  workflowTasks: [],
  theme: 'system',
  workflowPersistenceBroken: false,
}

/**
 * Minimal persistence contract the core app needs. The Electron GUI backs this with electron-store
 * (see electron/store.ts); the headless CLI backs it with FileStore below. Core code never imports
 * either implementation directly, so it stays runnable outside of Electron.
 */
export interface MaoStore {
  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K]
  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void
}

/** JSON-file-backed MaoStore for CLI/headless environments that don't have electron-store available. */
export class FileStore implements MaoStore {
  private data: MaoStoreSchema
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    this.data = { ...MAO_STORE_DEFAULTS, ...this.load() }
  }

  private load(): Partial<MaoStoreSchema> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
  }

  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    return this.data[key]
  }

  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
    this.data[key] = value
    this.persist()
  }
}
