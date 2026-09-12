import { app, ipcMain } from 'electron'
import path from 'node:path'
import { store } from './store.ts'
import { createMaoApp } from '../core/app.ts'
import { startAutoTrigger } from '../core/auto-trigger.ts'
import { sameRepoRef } from '../core/repo-registry.ts'
import { assertCanRelaunchForUpdate, checkForUpdates, countRunningWorkflowTasks } from '../core/self-update.ts'
import { createAiProvider, type AiProviderConfig } from '../core/ai/index.ts'
import type { RepoRef, RunOverride } from '../core/workflow-engine.ts'
import type { ThemePreference } from '../core/store.ts'

export function registerIpcHandlers() {
  const buildSha = process.env.MAO_BUILD_SHA ?? ''
  if (buildSha) store.set('buildSha', buildSha)

  const { githubService, workflowEngine, updateRepos } = createMaoApp({
    store,
    workspaceRoot: path.join(app.getPath('userData'), 'workspaces'),
    dataDir: app.getPath('userData'),
    resume: true,
  })
  const autoTrigger = startAutoTrigger(githubService, workflowEngine, () => store.get('githubRepos'))

  ipcMain.handle('app:checkUpdate', async () => {
    const update = await checkForUpdates(githubService, store.get('buildSha'))
    return {
      ...update,
      runningTaskCount: countRunningWorkflowTasks(workflowEngine.getTasks()),
    }
  })

  ipcMain.handle('app:relaunch', (_event, force = false) => {
    assertCanRelaunchForUpdate(workflowEngine.getTasks(), force)
    app.relaunch()
    app.quit()
  })

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

  ipcMain.handle('github:fetchTaskDetail', (_event, owner: string, repo: string, number: number) => {
    return githubService.fetchTaskDetail(owner, repo, number)
  })

  // Newly registered repos are preflighted in core before anything is persisted; updates, removals
  // and reordering are not, so a repo whose access was revoked can still be turned off or removed.
  // The rule itself lives in core/repo-registry.ts — shared verbatim with `mao repos add`.
  //
  // Returns the passing verdicts so the renderer can show the same "these grants are unverified"
  // caveat `mao repos add` prints. Dropping them would make a passing preflight look in the GUI like
  // proof of write access, which is exactly what core/repo-capabilities.ts exists to avoid.
  ipcMain.handle('github:setRepos', (_event, repos: RepoRef[]) => updateRepos(() => repos))

  ipcMain.handle('github:getRepos', () => store.get('githubRepos'))

  ipcMain.handle('github:autoTriggerStatus', (_event, owner: string, repo: string) =>
    autoTrigger.getStatus(owner, repo),
  )

  // Refresh drives a real poll, so its verdict has to reach the operator. pollNow() swallows every
  // failure into auto-trigger's lastError map, which nothing in the renderer reads — so without this
  // the GUI would report a clean sync for a repository MAO cannot write to, and on revoked access
  // would show fetchTasks' opaque 404 instead of the message the preflight just produced. Rejecting
  // here surfaces it in the board's existing error slot; the board's own 30s fetchTasks poll keeps
  // the card list populated meanwhile.
  ipcMain.handle('github:refreshRepo', async (_event, owner: string, repo: string) => {
    const repos = store.get('githubRepos')
    const repoRef = repos.find((r) => sameRepoRef(r, { owner, repo })) ?? { owner, repo }
    await githubService.assertRepoWorkflowWritable(owner, repo)
    await autoTrigger.pollNow(repoRef)
    return githubService.fetchTasks(owner, repo)
  })

  ipcMain.handle('workflow:enqueue', (_event, title: string, repo: RepoRef, autoAdvance?: boolean) =>
    workflowEngine.enqueue(title, repo, autoAdvance),
  )

  ipcMain.handle(
    'workflow:enqueueFromIssue',
    async (_event, owner: string, repo: string, issueNumber: number, autoAdvance?: boolean) => {
      const issue = await githubService.getIssue(owner, repo, issueNumber)
      return workflowEngine.enqueueFromIssue(issue.number, issue.url, issue.title, { owner, repo }, autoAdvance)
    },
  )

  ipcMain.handle('workflow:list', () => workflowEngine.getTasks())

  ipcMain.handle('workflow:retry', (_event, taskId: string, runOverride?: RunOverride) =>
    workflowEngine.retry(taskId, runOverride),
  )

  ipcMain.handle('workflow:advance', (_event, taskId: string, runOverride?: RunOverride) =>
    workflowEngine.advance(taskId, runOverride),
  )

  ipcMain.handle('workflow:setAutoAdvance', (_event, taskId: string, autoAdvance: boolean) =>
    workflowEngine.setAutoAdvance(taskId, autoAdvance),
  )

  ipcMain.handle('workflow:clearCompleted', () => workflowEngine.clearCompleted())

  ipcMain.handle('ui:getTheme', () => store.get('theme'))

  ipcMain.handle('ui:setTheme', (_event, theme: ThemePreference) => {
    store.set('theme', theme)
  })
}
