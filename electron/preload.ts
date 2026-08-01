import { contextBridge, ipcRenderer } from 'electron'
import type { AiProviderConfig } from './ai/types.ts'
import type { GithubTask } from './github-service.ts'
import type { QueuedTask } from './workflow-engine.ts'

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
    setRepo: (owner: string, repo: string): Promise<void> => ipcRenderer.invoke('github:setRepo', owner, repo),
    getConfig: (): Promise<{ owner: string; repo: string }> => ipcRenderer.invoke('github:getConfig'),
  },
  workflow: {
    enqueue: (title: string): Promise<QueuedTask> => ipcRenderer.invoke('workflow:enqueue', title),
    list: (): Promise<QueuedTask[]> => ipcRenderer.invoke('workflow:list'),
  },
})
