import { GithubService } from './github-service.ts'
import { WorkflowEngine, type QueuedTask } from './workflow-engine.ts'
import type { MaoStore } from './store.ts'

export interface MaoAppOptions {
  store: MaoStore
  /** Local directory where repos get cloned so CLI agents can make real file edits. */
  workspaceRoot: string
  /**
   * Whether to immediately resume processing any leftover 'pending'/'running' tasks from a previous
   * session. Required (no default) on purpose: a long-lived process (the Electron main process, or
   * `mao run`) should pass true so it picks back up where it left off, but a one-shot CLI command
   * (e.g. `mao config show`) MUST pass false — otherwise loading the app to answer an unrelated
   * question would silently make real GitHub/AI-provider calls and mutate the persisted queue.
   */
  resume: boolean
}

export interface MaoApp {
  githubService: GithubService
  workflowEngine: WorkflowEngine
  store: MaoStore
}

/**
 * Wires the core engine (GitHub client, workflow queue) against a persistence backend and loads any
 * previously-queued tasks. This is the single source of truth for how the app boots — both
 * electron/ipc.ts (GUI) and cli/index.ts (headless) call this so they run identical business logic
 * and only differ in how they store settings and surface output.
 *
 * Deliberately does NOT start the auto-trigger poller (see core/auto-trigger.ts): that spins up a
 * `setInterval` that keeps the process alive indefinitely, which is right for a long-lived Electron
 * session but would make every one-shot CLI invocation hang forever. Callers that want continuous
 * polling (the Electron main process, or `mao run`) start it themselves.
 */
export function createMaoApp({ store, workspaceRoot, resume }: MaoAppOptions): MaoApp {
  const githubService = new GithubService()
  const workflowEngine = new WorkflowEngine(githubService)

  const token = store.get('githubToken')
  if (token) {
    githubService.setToken(token)
    workflowEngine.setGithubToken(token)
  }
  workflowEngine.setProviders(store.get('aiProviders'))
  workflowEngine.setWorkspaceRoot(workspaceRoot)
  workflowEngine.on('change', (tasks: QueuedTask[]) => store.set('workflowTasks', tasks))
  // Best-effort durable record of a confirmed persistence failure (see
  // WorkflowEngine.isPersistenceBroken()) — a small, independent write, distinct from the 'change'
  // listener above that just failed twice running the same task list through it. If this write
  // *also* fails, there's nothing more this process can do; the in-memory flag on workflowEngine
  // still stops it from running further stages for the rest of this process's life.
  workflowEngine.on('persistence-broken', () => {
    try {
      store.set('workflowPersistenceBroken', true)
    } catch {
      // Nothing more we can do — the store itself has failed two independent writes now.
    }
  })

  // A prior process confirmed it could no longer durably persist queue state (see above) and may
  // have advanced a task's stage in memory — including real GitHub writes — without that advance
  // reaching workflowTasks. The on-disk snapshot can therefore predate work that already happened;
  // auto-resuming from it risks re-running (duplicating) that work. Refuse to auto-resume — no
  // matter what the caller asked for — until an operator has verified the queue and explicitly
  // cleared the flag (`mao config clear-persistence-broken`).
  const safeToResume = resume && !store.get('workflowPersistenceBroken')
  workflowEngine.restore(store.get('workflowTasks'), { resume: safeToResume })

  return { githubService, workflowEngine, store }
}
