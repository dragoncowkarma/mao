import { vi } from 'vitest'
import { setElectronApi, type ElectronApi } from '../electron-api'
import type { AppUpdateCheck } from '../electron'
import type { AiProviderConfig } from '../../core/ai/types'
import type { GithubTask } from '../../core/github-service'
import type { RepoWorkflowCapability } from '../../core/repo-capabilities'
import type { StoredValueProblem, ThemePreference } from '../../core/store'
import type { QueuedTask, RepoRef } from '../../core/workflow-engine'

/**
 * A method the renderer should not reach in this test. Failing loudly beats returning an empty value:
 * a stub that quietly answers every channel turns "the component called the wrong thing" into a test
 * that still passes, which is the exact failure mode issue #58 was filed about.
 */
function notStubbed(channel: string) {
  return vi.fn(async (): Promise<never> => {
    throw new Error(`electronAPI.${channel} was called, but this test did not stub it`)
  })
}

/**
 * A fake preload bridge, bound in place of the real one.
 *
 * Only the channels App and its default children reach on mount are implemented; the rest throw by
 * name. `github.getRepos`/`setRepos` share one in-memory list so a test can exercise the actual
 * read-mutate-read shape of the renderer's pull model rather than asserting on call arguments alone.
 *
 * The returned mocks are handed back individually so a test can re-program one for a single call —
 * `setRepos.mockImplementationOnce()` is how the slow-write races are staged — without rebuilding the
 * whole bridge.
 */
export function createElectronApiStub(initialRepos: RepoRef[] = [], initialProblems: StoredValueProblem[] = []) {
  let stored: RepoRef[] = initialRepos.map((repo) => ({ ...repo }))
  // Answered live, like the real backend: `app:storeProblems` re-evaluates what the store holds now, so
  // a test that heals the store has to see the notice go away without re-programming the stub.
  let problems: StoredValueProblem[] = initialProblems

  // Copies on the way out as well as in: the renderer holds this list in state and spreads it into new
  // arrays, and a shared reference would let a component mutation silently rewrite the "store".
  const getRepos = vi.fn(async (): Promise<RepoRef[]> => stored.map((repo) => ({ ...repo })))
  const setRepos = vi.fn(async (next: RepoRef[]): Promise<RepoWorkflowCapability[]> => {
    stored = next.map((repo) => ({ ...repo }))
    // Any list write replaces the unusable value, which is the recovery the real store provides.
    problems = []
    return []
  })
  const storeProblems = vi.fn(async (): Promise<StoredValueProblem[]> => problems.map((p) => ({ ...p })))
  const getTheme = vi.fn(async (): Promise<ThemePreference> => 'system')
  const setTheme = vi.fn(async (): Promise<void> => {})
  const checkUpdate = vi.fn(
    async (): Promise<AppUpdateCheck> => ({
      currentSha: 'test-sha',
      latestSha: 'test-sha',
      updateAvailable: false,
      runningTaskCount: 0,
    }),
  )
  const fetchTasks = vi.fn(async (): Promise<GithubTask[]> => [])
  const listProviders = vi.fn(async (): Promise<AiProviderConfig[]> => [])
  const listWorkflowTasks = vi.fn(async (): Promise<QueuedTask[]> => [])

  const api = {
    platform: 'test',
    app: {
      checkUpdate,
      relaunch: notStubbed('app.relaunch'),
      storeProblems,
    },
    ai: {
      list: listProviders,
      save: notStubbed('ai.save'),
      run: notStubbed('ai.run'),
    },
    github: {
      setToken: notStubbed('github.setToken'),
      fetchTasks,
      fetchTaskDetail: notStubbed('github.fetchTaskDetail'),
      setRepos,
      getRepos,
      autoTriggerStatus: notStubbed('github.autoTriggerStatus'),
      refreshRepo: notStubbed('github.refreshRepo'),
    },
    workflow: {
      enqueue: notStubbed('workflow.enqueue'),
      enqueueFromIssue: notStubbed('workflow.enqueueFromIssue'),
      list: listWorkflowTasks,
      retry: notStubbed('workflow.retry'),
      advance: notStubbed('workflow.advance'),
      setAutoAdvance: notStubbed('workflow.setAutoAdvance'),
      clearCompleted: notStubbed('workflow.clearCompleted'),
    },
    ui: {
      getTheme,
      setTheme,
    },
  } satisfies ElectronApi

  setElectronApi(api)

  return {
    api,
    getRepos,
    setRepos,
    checkUpdate,
    storeProblems,
    fetchTasks,
    listProviders,
    listWorkflowTasks,
    /** What the fake store holds right now — the assertion target for "did the write land". */
    storedRepos: () => stored.map((repo) => ({ ...repo })),
    /** For a `setRepos` override that defers: apply the write the default implementation would have. */
    applyRepos: (next: RepoRef[]) => {
      stored = next.map((repo) => ({ ...repo }))
    },
  }
}
