import type { AiProviderConfig } from '../electron/ai/types'
import type { GithubTask } from '../electron/github-service'
import type { QueuedTask, RepoRef } from '../electron/workflow-engine'

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
        setRepos: (repos: RepoRef[]) => Promise<void>
        getRepos: () => Promise<RepoRef[]>
      }
      workflow: {
        enqueue: (title: string, repo: RepoRef) => Promise<QueuedTask>
        list: () => Promise<QueuedTask[]>
        retry: (taskId: string) => Promise<QueuedTask>
      }
    }
  }
}

export {}
