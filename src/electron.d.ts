import type { AiProviderConfig } from '../core/ai/types'
import type { GithubTask, GithubTaskDetail } from '../core/github-service'
import type { QueuedTask, RepoRef } from '../core/workflow-engine'
import type { AutoTriggerStatus } from '../core/auto-trigger'

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
        fetchTaskDetail: (owner: string, repo: string, number: number) => Promise<GithubTaskDetail>
        setRepos: (repos: RepoRef[]) => Promise<void>
        getRepos: () => Promise<RepoRef[]>
        autoTriggerStatus: (owner: string, repo: string) => Promise<AutoTriggerStatus>
        refreshRepo: (owner: string, repo: string) => Promise<GithubTask[]>
      }
      workflow: {
        enqueue: (title: string, repo: RepoRef, autoAdvance?: boolean) => Promise<QueuedTask>
        list: () => Promise<QueuedTask[]>
        retry: (taskId: string) => Promise<QueuedTask>
        advance: (taskId: string) => Promise<QueuedTask>
        setAutoAdvance: (taskId: string, autoAdvance: boolean) => Promise<QueuedTask>
        clearCompleted: () => Promise<void>
      }
    }
  }
}

export {}
