import Store from 'electron-store'
import type { AiProviderConfig } from './ai/types.ts'
import type { QueuedTask } from './workflow-engine.ts'

interface StoreSchema {
  githubToken: string
  githubOwner: string
  githubRepo: string
  aiProviders: AiProviderConfig[]
  workflowTasks: QueuedTask[]
}

export const store = new Store<StoreSchema>({
  defaults: {
    githubToken: '',
    githubOwner: '',
    githubRepo: '',
    aiProviders: [],
    workflowTasks: [],
  },
})
