import { contextBridge, ipcRenderer } from 'electron'
import type { AiProviderConfig } from '../core/ai/types.ts'
import type { GithubTask, GithubTaskDetail } from '../core/github-service.ts'
import type { RepoWorkflowCapability } from '../core/repo-capabilities.ts'
import type {
  QueuedTask,
  QueueRecoveryOutcome,
  QueueRecoveryState,
  RepoRef,
  RunOverride,
} from '../core/workflow-engine.ts'
import type { AutoTriggerStatus } from '../core/auto-trigger.ts'
import type { StoredValueProblem, ThemePreference } from '../core/store.ts'
import type { SelfUpdateCheck } from '../core/self-update.ts'

export interface AppUpdateCheck extends SelfUpdateCheck {
  runningTaskCount: number
}

/**
 * The bridge, checked against the renderer's own declaration of it.
 *
 * `contextBridge.exposeInMainWorld` takes `any`, so for as long as this object was unannotated tsc
 * checked it only against `core/` types — never against `src/electron.d.ts`, the file whose whole job
 * is to describe it. The three-file IPC lockstep (AGENTS.md) was therefore maintained entirely by eye,
 * and SKILL.md said so: a channel added here and forgotten there, a renamed method, or a signature
 * that drifted all compiled cleanly and failed only when an operator clicked the thing.
 *
 * `satisfies` closes that, and in both directions — a method this object omits is TS2741, one it adds
 * that the declaration does not have is TS2353 (object-literal excess property check), and a
 * parameter or return type that disagrees is TS2322. It is `satisfies` rather than a type annotation
 * on purpose: an annotation would widen each function to the declared type and let the real
 * `ipcRenderer.invoke` return type stop being checked against it.
 *
 * Pointing at the ambient `Window['electronAPI']` introduces no import, so nothing here depends on a
 * module under `src/` and the `electron/* -> core/*` direction is untouched. The arrow is deliberate:
 * `src/` may not import `electron`, so the declaration cannot be derived from this file and has to be
 * hand-mirrored — which is exactly why it is worth pinning this object to it rather than the reverse.
 *
 * What this cannot see is the channel *strings*: `invoke('app:storeProblms')` is a perfectly valid
 * `string`. `src/electron-ipc-surface.test.ts` covers that half, and also pins that this annotation
 * is still here.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  app: {
    checkUpdate: (): Promise<AppUpdateCheck> => ipcRenderer.invoke('app:checkUpdate'),
    relaunch: (force?: boolean): Promise<void> => ipcRenderer.invoke('app:relaunch', force),
    /** Stored values the main process could not use and answered with a schema default instead. */
    storeProblems: (): Promise<StoredValueProblem[]> => ipcRenderer.invoke('app:storeProblems'),
  },
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
    fetchTaskDetail: (owner: string, repo: string, number: number): Promise<GithubTaskDetail> =>
      ipcRenderer.invoke('github:fetchTaskDetail', owner, repo, number),
    /**
     * Rejects (leaving the stored list untouched) when a newly added repo fails the write-permission
     * preflight. Resolves with the verdict for each newly registered repo, whose `unverified` grants
     * the caller should surface — a pass is not proof of write access.
     */
    setRepos: (repos: RepoRef[]): Promise<RepoWorkflowCapability[]> =>
      ipcRenderer.invoke('github:setRepos', repos),
    getRepos: (): Promise<RepoRef[]> => ipcRenderer.invoke('github:getRepos'),
    autoTriggerStatus: (owner: string, repo: string): Promise<AutoTriggerStatus> =>
      ipcRenderer.invoke('github:autoTriggerStatus', owner, repo),
    refreshRepo: (owner: string, repo: string): Promise<GithubTask[]> =>
      ipcRenderer.invoke('github:refreshRepo', owner, repo),
  },
  workflow: {
    enqueue: (title: string, repo: RepoRef, autoAdvance?: boolean): Promise<QueuedTask> =>
      ipcRenderer.invoke('workflow:enqueue', title, repo, autoAdvance),
    enqueueFromIssue: (
      owner: string,
      repo: string,
      issueNumber: number,
      autoAdvance?: boolean,
    ): Promise<QueuedTask> => ipcRenderer.invoke('workflow:enqueueFromIssue', owner, repo, issueNumber, autoAdvance),
    list: (): Promise<QueuedTask[]> => ipcRenderer.invoke('workflow:list'),
    retry: (taskId: string, runOverride?: RunOverride): Promise<QueuedTask> =>
      ipcRenderer.invoke('workflow:retry', taskId, runOverride),
    advance: (taskId: string, runOverride?: RunOverride): Promise<QueuedTask> =>
      ipcRenderer.invoke('workflow:advance', taskId, runOverride),
    setAutoAdvance: (taskId: string, autoAdvance: boolean): Promise<QueuedTask> =>
      ipcRenderer.invoke('workflow:setAutoAdvance', taskId, autoAdvance),
    clearCompleted: (): Promise<void> => ipcRenderer.invoke('workflow:clearCompleted'),
    recoveryRequired: (): Promise<QueueRecoveryState> => ipcRenderer.invoke('workflow:recoveryRequired'),
    confirmQueueRecovery: (): Promise<QueueRecoveryOutcome> =>
      ipcRenderer.invoke('workflow:confirmQueueRecovery'),
    resaveQueue: (): Promise<QueueRecoveryOutcome> => ipcRenderer.invoke('workflow:resaveQueue'),
  },
  ui: {
    getTheme: (): Promise<ThemePreference> => ipcRenderer.invoke('ui:getTheme'),
    setTheme: (theme: ThemePreference): Promise<void> => ipcRenderer.invoke('ui:setTheme', theme),
  },
} satisfies Window['electronAPI'])
