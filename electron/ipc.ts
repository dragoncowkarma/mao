import { app, ipcMain } from 'electron'
import path from 'node:path'
import { store } from './store.ts'
import { createAiProvider, type AiProviderConfig } from './ai/index.ts'
import { GithubService } from './github-service.ts'
import { WorkflowEngine, type RepoRef } from './workflow-engine.ts'
import { startAutoTrigger } from './auto-trigger.ts'

const githubService = new GithubService()
const workflowEngine = new WorkflowEngine(githubService)

export function registerIpcHandlers() {
  const token = store.get('githubToken')
  if (token) {
    githubService.setToken(token)
    workflowEngine.setGithubToken(token)
  }
  workflowEngine.setProviders(store.get('aiProviders'))
  workflowEngine.setWorkspaceRoot(path.join(app.getPath('userData'), 'workspaces'))
  workflowEngine.setOnChange(() => store.set('workflowTasks', workflowEngine.getTasks()))
  workflowEngine.restore(store.get('workflowTasks'))

  startAutoTrigger(githubService, workflowEngine, () => store.get('githubRepos'))

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

  ipcMain.handle('workflow:enqueue', (_event, title: string, repo: RepoRef) =>
    workflowEngine.enqueue(title, repo),
  )

  ipcMain.handle('workflow:list', () => workflowEngine.getTasks())

  ipcMain.handle('workflow:retry', (_event, taskId: string) => workflowEngine.retry(taskId))

  ipcMain.handle('workflow:clearCompleted', () => workflowEngine.clearCompleted())
}
