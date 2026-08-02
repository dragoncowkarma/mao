import Store from 'electron-store'
import type { AiProviderConfig } from './ai/types.ts'
import type { QueuedTask, RepoRef } from './workflow-engine.ts'

interface StoreSchema {
  githubToken: string
  githubRepos: RepoRef[]
  aiProviders: AiProviderConfig[]
  workflowTasks: QueuedTask[]
}

export const store = new Store<StoreSchema>({
  defaults: {
    githubToken: '',
    githubRepos: [],
    aiProviders: [],
    workflowTasks: [],
  },
})
