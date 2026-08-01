import type { AiProviderConfig } from '../electron/ai/types'
import type { GithubTask } from '../electron/github-service'
import type { QueuedTask } from '../electron/workflow-engine'

declare global {
  interface Window {
    electronAPI: {
      platform: string
      ai: {
        list: () => Promise<AiProviderConfig[]>
        save: (providers: AiProviderConfig[]) => Promise<AiProviderConfig[]>
        run: (providerId: string, prompt: string) => Promise<string>
      }
      github: {
        setToken: (token: string) => Promise<void>
        fetchTasks: (owner: string, repo: string) => Promise<GithubTask[]>
        setRepo: (owner: string, repo: string) => Promise<void>
        getConfig: () => Promise<{ owner: string; repo: string }>
      }
      workflow: {
        enqueue: (title: string) => Promise<QueuedTask>
        list: () => Promise<QueuedTask[]>
        retry: (taskId: string) => Promise<QueuedTask>
      }
    }
  }
}

export {}
