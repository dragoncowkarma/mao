import { contextBridge, ipcRenderer } from 'electron'
import type { AiProviderConfig } from './ai/types.ts'
import type { GithubTask } from './github-service.ts'
import type { QueuedTask, RepoRef } from './workflow-engine.ts'
import type { AutoTriggerStatus } from './auto-trigger.ts'

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  ai: {
    list: (): Promise<AiProviderConfig[]> => ipcRenderer.invoke('ai:list'),
    save: (providers: AiProviderConfig[]): Promise<AiProviderConfig[]> =>
      ipcRenderer.invoke('ai:save', providers),
    run: (providerId: string, prompt: string): Promise<string> =>
      ipcRenderer.invoke('ai:run', providerId, prompt),
  },
  github: {
    setToken: (token: string): Promise<void> => ipcRenderer.invoke('github:setToken', token),
    fetchTasks: (owner: string, repo: string): Promise<GithubTask[]> =>
      ipcRenderer.invoke('github:fetchTasks', owner, repo),
    setRepos: (repos: RepoRef[]): Promise<void> => ipcRenderer.invoke('github:setRepos', repos),
    getRepos: (): Promise<RepoRef[]> => ipcRenderer.invoke('github:getRepos'),
    autoTriggerStatus: (owner: string, repo: string): Promise<AutoTriggerStatus> =>
      ipcRenderer.invoke('github:autoTriggerStatus', owner, repo),
    refreshRepo: (owner: string, repo: string): Promise<GithubTask[]> =>
      ipcRenderer.invoke('github:refreshRepo', owner, repo),
  },
  workflow: {
    enqueue: (title: string, repo: RepoRef, autoAdvance?: boolean): Promise<QueuedTask> =>
      ipcRenderer.invoke('workflow:enqueue', title, repo, autoAdvance),
    list: (): Promise<QueuedTask[]> => ipcRenderer.invoke('workflow:list'),
    retry: (taskId: string): Promise<QueuedTask> => ipcRenderer.invoke('workflow:retry', taskId),
    advance: (taskId: string): Promise<QueuedTask> => ipcRenderer.invoke('workflow:advance', taskId),
    setAutoAdvance: (taskId: string, autoAdvance: boolean): Promise<QueuedTask> =>
      ipcRenderer.invoke('workflow:setAutoAdvance', taskId, autoAdvance),
    clearCompleted: (): Promise<void> => ipcRenderer.invoke('workflow:clearCompleted'),
  },
})
