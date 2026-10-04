import type { AiProviderConfig } from '../core/ai/types'
import type { GithubTask, GithubTaskDetail } from '../core/github-service'
import type { RepoWorkflowCapability } from '../core/repo-capabilities'
import type { QueueRecoveryOutcome, QueueRecoveryState, QueuedTask, RepoRef, RunOverride } from '../core/workflow-engine'
import type { AutoTriggerStatus } from '../core/auto-trigger'
import type { StoredValueProblem, ThemePreference } from '../core/store'
import type { SelfUpdateCheck } from '../core/self-update'

export interface AppUpdateCheck extends SelfUpdateCheck {
  runningTaskCount: number
}

declare global {
  interface Window {
    electronAPI: {
      platform: string
      app: {
        checkUpdate: () => Promise<AppUpdateCheck>
        relaunch: (force?: boolean) => Promise<void>
        /** Stored values the main process could not use and answered with a schema default instead. */
        storeProblems: () => Promise<StoredValueProblem[]>
      }
      ai: {
        list: () => Promise<AiProviderConfig[]>
        save: (providers: AiProviderConfig[]) => Promise<AiProviderConfig[]>
        run: (providerId: string, prompt: string) => Promise<string>
      }
      github: {
        setToken: (token: string) => Promise<void>
        fetchTasks: (owner: string, repo: string) => Promise<GithubTask[]>
        fetchTaskDetail: (owner: string, repo: string, number: number) => Promise<GithubTaskDetail>
        /**
         * Rejects (leaving the stored list untouched) when a newly added repo fails the write-permission
         * preflight. Resolves with the verdict for each newly registered repo, whose `unverified` grants
         * the caller should surface — a pass is not proof of write access.
         */
        setRepos: (repos: RepoRef[]) => Promise<RepoWorkflowCapability[]>
        getRepos: () => Promise<RepoRef[]>
        autoTriggerStatus: (owner: string, repo: string) => Promise<AutoTriggerStatus>
        refreshRepo: (owner: string, repo: string) => Promise<GithubTask[]>
      }
      workflow: {
        enqueue: (title: string, repo: RepoRef, autoAdvance?: boolean) => Promise<QueuedTask>
        enqueueFromIssue: (
          owner: string,
          repo: string,
          issueNumber: number,
          autoAdvance?: boolean,
        ) => Promise<QueuedTask>
        list: () => Promise<QueuedTask[]>
        retry: (taskId: string, runOverride?: RunOverride) => Promise<QueuedTask>
        advance: (taskId: string, runOverride?: RunOverride) => Promise<QueuedTask>
        setAutoAdvance: (taskId: string, autoAdvance: boolean) => Promise<QueuedTask>
        clearCompleted: () => Promise<void>
        /** Whether unattended work is halted because the stored queue is unreadable, and why. */
        recoveryRequired: () => Promise<QueueRecoveryState>
        /** Discards an unreadable stored queue and releases the engine. Core decides the outcome. */
        confirmQueueRecovery: () => Promise<QueueRecoveryOutcome>
        /** Rewrites the stored queue from the one this process holds, conditionally. See MaoApp.resaveStoredQueue. */
        resaveQueue: () => Promise<QueueRecoveryOutcome>
      }
      ui: {
        getTheme: () => Promise<ThemePreference>
        setTheme: (theme: ThemePreference) => Promise<void>
      }
    }
  }
}

export {}
