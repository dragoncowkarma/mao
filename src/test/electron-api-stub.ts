import { vi } from 'vitest'
import { setElectronApi, type ElectronApi } from '../electron-api'
import type { AppUpdateCheck } from '../electron'
import type { AiProviderConfig } from '../../core/ai/types'
import type { GithubTask } from '../../core/github-service'
import type { RepoWorkflowCapability } from '../../core/repo-capabilities'
import { applyRepoListEdit } from '../../core/repo-registry'
import type { StoredValueProblem, ThemePreference } from '../../core/store'
import type {
  QueuedTask,
  QueueRecoveryOutcome,
  QueueRecoveryState,
  RepoRef,
} from '../../core/workflow-engine'

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
  const setRepos = vi.fn(async (next: RepoRef[], base?: RepoRef[]): Promise<RepoWorkflowCapability[]> => {
    // Applied the way `github:setRepos` applies it — core's own edit rule against what is stored now — so
    // a test that changes the "store" behind the window's back sees what the real stack would keep. A
    // seeded `githubRepos` problem whose defect is `'value'` stands for a stored value that is not a list,
    // which the real store's read guard answers as an unusable `[]`; the stub models that rather than
    // diffing against `stored`. A mixed or all-invalid *array* is still the list as stored, exactly as the
    // registrar reads it (`observed.defect !== 'value'`), so it keeps the diff. A mirror of that rule, not a
    // test of it: no renderer test tells the two apart, and `core/repo-registry.test.ts` is what pins it.
    const usable = problems.find((problem) => problem.field === 'githubRepos')?.defect !== 'value'
    stored = applyRepoListEdit(usable ? stored : [], base, next, usable).map((repo) => ({ ...repo }))
    // A repository-list write replaces `githubRepos` and nothing else — `store.set` writes one key, and
    // `describeStoredProblems` re-evaluates the rest — so a stub that healed every field would make the
    // natural mixed-state test fail against a *correct* renderer once a second field is guarded.
    problems = problems.filter((problem) => problem.field !== 'githubRepos')
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

  // Modelled on the real latch rather than taken as a separate input: the engine derives it at boot from
  // the store's `workflowTasks` problem, so a test that seeds that problem gets a halted host for free —
  // and, because the latch is monotone, healing the store does NOT clear it. Only the confirm call does.
  let queueLatched = initialProblems.find((problem) => problem.field === 'workflowTasks')?.message
  let queueRestartRequired =
    initialProblems.find((problem) => problem.field === 'workflowTasks')?.wholeFile === true
  const recoveryRequired = vi.fn(
    async (): Promise<QueueRecoveryState> => ({
      required: queueLatched !== undefined,
      reason: queueLatched,
      restartRequired: queueRestartRequired,
      persistenceBroken: false,
    }),
  )
  // Models MaoApp.resaveStoredQueue: observes the store, then rewrites it from the queue this process
  // holds — conditionally, so a repair that landed first answers `already-readable` and writes nothing.
  const resaveQueue = vi.fn(async (): Promise<QueueRecoveryOutcome> => {
    if (queueRestartRequired) return { kind: 'restart-required' }
    if (!problems.some((problem) => problem.field === 'workflowTasks')) return { kind: 'already-readable' }
    problems = problems.filter((problem) => problem.field !== 'workflowTasks')
    return { kind: 'replaced' }
  })
  const confirmQueueRecovery = vi.fn(async (): Promise<QueueRecoveryOutcome> => {
    if (queueLatched === undefined) return { kind: 'already-readable' }
    if (queueRestartRequired) return { kind: 'restart-required' }
    if (!problems.some((problem) => problem.field === 'workflowTasks')) return { kind: 'already-readable' }
    queueLatched = undefined
    queueRestartRequired = false
    problems = problems.filter((problem) => problem.field !== 'workflowTasks')
    return { kind: 'replaced' }
  })
  const clearPersistenceBroken = vi.fn(async (): Promise<void> => {})

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
      recoveryRequired,
      confirmQueueRecovery,
      resaveQueue,
      clearPersistenceBroken,
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
    /**
     * For a `setRepos` override that defers: store `next` wholesale — the write the default implementation
     * makes when nothing changed the store since the edit's base, which is the case those tests stage.
     */
    applyRepos: (next: RepoRef[]) => {
      stored = next.map((repo) => ({ ...repo }))
    },
    /** Replaces what the fake store reports as unusable, as a hand-edit made while the window is open would. */
    setStoreProblems: (next: StoredValueProblem[]) => {
      problems = next
    },
    recoveryRequired,
    confirmQueueRecovery,
    resaveQueue,
    clearPersistenceBroken,
  }
}
