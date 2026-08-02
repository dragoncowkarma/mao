import { contextBridge, ipcRenderer } from 'electron'
import type { AiProviderConfig } from './ai/types.ts'
import type { GithubTask } from './github-service.ts'
import type { QueuedTask, RepoRef } from './workflow-engine.ts'

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
  },
  workflow: {
    enqueue: (title: string, repo: RepoRef): Promise<QueuedTask> =>
      ipcRenderer.invoke('workflow:enqueue', title, repo),
    list: (): Promise<QueuedTask[]> => ipcRenderer.invoke('workflow:list'),
    retry: (taskId: string): Promise<QueuedTask> => ipcRenderer.invoke('workflow:retry', taskId),
    clearCompleted: (): Promise<void> => ipcRenderer.invoke('workflow:clearCompleted'),
  },
})
