import type { AiProviderConfig } from '../core/ai/types'
import type { GithubTask, GithubTaskDetail } from '../core/github-service'
import type { RepoWorkflowCapability } from '../core/repo-capabilities'
import type { QueuedTask, RepoRef, RunOverride } from '../core/workflow-engine'
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
      }
      store: {
        /**
         * Stored values the main process had to discard, each naming the field, the value's *type* and
         * the config file — never the value (the GitHub token lives in that same file). Polled, not
         * pushed; re-derived per call, so it goes empty once a repository-list write heals the file.
         */
        problems: () => Promise<StoredValueProblem[]>
      }
      ui: {
        getTheme: () => Promise<ThemePreference>
        setTheme: (theme: ThemePreference) => Promise<void>
      }
    }
  }
}

export {}
