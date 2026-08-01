import Store from 'electron-store'
import type { AiProviderConfig } from './ai/types.ts'

interface StoreSchema {
  githubToken: string
  githubOwner: string
  githubRepo: string
  aiProviders: AiProviderConfig[]
}

export const store = new Store<StoreSchema>({
  defaults: {
    githubToken: '',
    githubOwner: '',
    githubRepo: '',
    aiProviders: [],
  },
})
