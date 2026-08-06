import { app, ipcMain } from 'electron'
import path from 'node:path'
import { store } from './store.ts'
import { createMaoApp } from '../core/app.ts'
import { startAutoTrigger } from '../core/auto-trigger.ts'
import { createAiProvider, type AiProviderConfig } from '../core/ai/index.ts'
import type { RepoRef } from '../core/workflow-engine.ts'
import type { ThemePreference } from '../core/store.ts'

export function registerIpcHandlers() {
  const { githubService, workflowEngine } = createMaoApp({
    store,
    workspaceRoot: path.join(app.getPath('userData'), 'workspaces'),
    resume: true,
  })
  const autoTrigger = startAutoTrigger(githubService, workflowEngine, () => store.get('githubRepos'))

  ipcMain.handle('ai:list', () => store.get('aiProviders'))

  ipcMain.handle('ai:save', (_event, providers: AiProviderConfig[]) => {
    store.set('aiProviders', providers)
    workflowEngine.setProviders(providers)
    return providers
  })

  ipcMain.handle('ai:run', async (_event, providerId: string, prompt: string) => {
    const providers = store.get('aiProviders')
    const config = providers.find((p) => p.id === providerId)
    if (!config) throw new Error(`Unknown AI provider: ${providerId}`)
    return createAiProvider(config).run(prompt)
  })

  ipcMain.handle('github:setToken', (_event, token: string) => {
    store.set('githubToken', token)
    githubService.setToken(token)
    workflowEngine.setGithubToken(token)
  })

  ipcMain.handle('github:fetchTasks', (_event, owner: string, repo: string) => {
    return githubService.fetchTasks(owner, repo)
  })

  ipcMain.handle('github:setRepos', (_event, repos: RepoRef[]) => {
    store.set('githubRepos', repos)
  })

  ipcMain.handle('github:getRepos', () => store.get('githubRepos'))

  ipcMain.handle('github:autoTriggerStatus', (_event, owner: string, repo: string) =>
    autoTrigger.getStatus(owner, repo),
  )

  ipcMain.handle('github:refreshRepo', async (_event, owner: string, repo: string) => {
    const repos = store.get('githubRepos')
    const repoRef = repos.find((r) => r.owner === owner && r.repo === repo) ?? { owner, repo }
    await autoTrigger.pollNow(repoRef)
    return githubService.fetchTasks(owner, repo)
  })

  ipcMain.handle('workflow:enqueue', (_event, title: string, repo: RepoRef, autoAdvance?: boolean) =>
    workflowEngine.enqueue(title, repo, autoAdvance),
  )

  ipcMain.handle('workflow:list', () => workflowEngine.getTasks())

  ipcMain.handle('workflow:retry', (_event, taskId: string) => workflowEngine.retry(taskId))

  ipcMain.handle('workflow:advance', (_event, taskId: string) => workflowEngine.advance(taskId))

  ipcMain.handle('workflow:setAutoAdvance', (_event, taskId: string, autoAdvance: boolean) =>
    workflowEngine.setAutoAdvance(taskId, autoAdvance),
  )

  ipcMain.handle('workflow:clearCompleted', () => workflowEngine.clearCompleted())

  ipcMain.handle('ui:getTheme', () => store.get('theme'))

  ipcMain.handle('ui:setTheme', (_event, theme: ThemePreference) => {
    store.set('theme', theme)
  })
}
