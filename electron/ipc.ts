import { app, ipcMain } from 'electron'
import path from 'node:path'
import { store } from './store.ts'
import { createMaoApp } from '../core/app.ts'
import { startAutoTrigger } from '../core/auto-trigger.ts'
import { usableRepoList } from '../core/repo-registry.ts'
import { assertCanRelaunchForUpdate, checkForUpdates, countRunningWorkflowTasks } from '../core/self-update.ts'
import { createAiProvider, type AiProviderConfig } from '../core/ai/index.ts'
import { QUEUE_PERSISTENCE_BROKEN, type RepoRef, type RunOverride } from '../core/workflow-engine.ts'
import type { ThemePreference } from '../core/store.ts'
import {
  assertCanClearPersistenceBroken,
  clearPersistenceBrokenMarker,
} from '../core/persistence-guard.ts'

export function registerIpcHandlers() {
  const buildSha = process.env.MAO_BUILD_SHA ?? ''
  if (buildSha) store.set('buildSha', buildSha)

  const {
    githubService,
    workflowEngine,
    saveProviders,
    updateRepos,
    confirmQueueRecovery,
    resaveStoredQueue,
  } = createMaoApp({
    store,
    workspaceRoot: path.join(app.getPath('userData'), 'workspaces'),
    dataDir: app.getPath('userData'),
    resume: true,
  })
  const autoTrigger = startAutoTrigger(githubService, workflowEngine, () => store.inspect('githubRepos'))

  ipcMain.handle('app:checkUpdate', async () => {
    const update = await checkForUpdates(githubService, store.get('buildSha'))
    return {
      ...update,
      runningTaskCount: countRunningWorkflowTasks(workflowEngine.getTasks()),
    }
  })

  // The GUI's only way to learn that a stored value was unusable. The guard in core/store.ts reports
  // through `console.warn`, which in a packaged app goes to a main-process console the operator never
  // sees — and `github:getRepos` answers `[]` for a corrupt list exactly as it does for an empty one,
  // so the sidebar cannot tell the two apart. Pulled rather than pushed, per AGENTS.md rule 6: the
  // renderer re-reads it at mount and after each list write. A pure read of what the store holds now.
  ipcMain.handle('app:storeProblems', () => store.problems())

  ipcMain.handle('app:relaunch', (_event, force = false) => {
    assertCanRelaunchForUpdate(workflowEngine.getTasks(), force)
    app.relaunch()
    app.quit()
  })

  ipcMain.handle('ai:list', () => store.get('aiProviders'))

  ipcMain.handle('ai:save', (_event, providers: AiProviderConfig[]) => saveProviders(providers))

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

  // Filtered, not raw. `config.json` is unvalidated JSON, and the renderer draws each row as
  // `{r.owner}/{r.repo}` with no guard and no error boundary above it — so a single `null` element
  // throws during render and blanks the whole window, taking with it the Remove button that would have
  // healed the store. Dropping unusable entries here costs nothing (they can be neither polled nor
  // named) and the next list write persists the same list core would have canonicalised anyway.
  //
  // Through core's `usableRepoList` rather than a local `.filter(isRepoRef)`, so this channel and the
  // CLI's `config show` / `repos list` cannot disagree about which rows are safe to show an operator.
  // That the drop happened travels separately, over `app:storeProblems`.
  ipcMain.handle('github:getRepos', () => usableRepoList(store.get('githubRepos')))

  ipcMain.handle('github:autoTriggerStatus', (_event, owner: string, repo: string) =>
    autoTrigger.getStatus(owner, repo),
  )

  // Refresh drives a real poll, so its verdict has to reach the operator. pollNow() owns the fresh
  // tracked-list read, whole-file latch and permission preflight in that order, and propagates its
  // manual-poll error. Reading the store or preflighting here first would bypass that ordering: a late
  // whole-file failure could reject before restartRequired was remembered, and a removed repository
  // would spend a GitHub call before membership rejected it.
  ipcMain.handle('github:refreshRepo', async (_event, owner: string, repo: string) => {
    return autoTrigger.pollNow({ owner, repo })
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

  // The GUI's only way to learn that unattended work is halted, and its only way out. Pulled like
  // `app:storeProblems` (AGENTS.md rule 6) and driven by the ENGINE rather than by `storeProblems`,
  // because the latch is monotone: after an out-of-band repair the store reads clean while this process
  // stays halted, and the card has to stay up and keep working in exactly that window.
  ipcMain.handle('workflow:recoveryRequired', () => {
    const persistenceBroken = workflowEngine.isPersistenceBroken()
    return {
      // A prior marker is as much a workflow halt as an unreadable queue. Keep the stricter persistence
      // reason when both exist: recovery/resave cannot resolve an unknown durable write outcome.
      required: persistenceBroken || workflowEngine.isQueueRecoveryLatched(),
      reason: persistenceBroken ? QUEUE_PERSISTENCE_BROKEN : workflowEngine.getQueueRecoveryReason(),
      restartRequired: workflowEngine.isQueueRecoveryRestartRequired(),
      persistenceBroken,
    }
  })

  // Returns core's typed outcome rather than a boolean, so the renderer and `mao workflow
  // confirm-queue-recovery` cannot disagree about whether confirmation succeeded.
  ipcMain.handle('workflow:confirmQueueRecovery', () => confirmQueueRecovery())

  // For a field-only value that went unusable after a clean start: this process still holds the real
  // queue, so this rewrites the field from it. A whole-file failure instead returns restart-required.
  // Offered instead of the discard in the field-only case, because a discard run in another process
  // would replace the file with ITS corrected startup subset and lose this one. Delegated to core, which
  // observes the store fresh and writes conditionally — the renderer's card is up to 30s stale, so an
  // unconditional write from here would overwrite a repair that landed in between.
  ipcMain.handle('workflow:resaveQueue', () => resaveStoredQueue())

  // The packaged Electron app does not ship the headless CLI, and its userData directory is not the
  // CLI's default data directory. Give the GUI a recovery route that clears the exact marker this
  // process loaded. The engine remains blocked in memory; only a fresh process may resume after the
  // renderer's explicit verification/confirmation step.
  ipcMain.handle('workflow:clearPersistenceBroken', () => {
    assertCanClearPersistenceBroken(workflowEngine.getTasks())
    if (!clearPersistenceBrokenMarker(app.getPath('userData'))) {
      throw new Error(
        'Failed to clear the workflow persistence marker. Queue mutation, polling and resume remain ' +
          'blocked. Check the MAO data directory permissions and try again.',
      )
    }
  })

  ipcMain.handle('ui:getTheme', () => store.get('theme'))

  ipcMain.handle('ui:setTheme', (_event, theme: ThemePreference) => {
    store.set('theme', theme)
  })
}
