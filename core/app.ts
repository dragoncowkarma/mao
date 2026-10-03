import { GithubService } from './github-service.ts'
import { createRepoRegistrar } from './repo-registry.ts'
import { WorkflowEngine, type QueuedTask, type QueueRecoveryOutcome } from './workflow-engine.ts'
import {
  QUEUE_GATING_FIELD,
  describeUninspectableStore,
  type MaoStore,
  type StoredObservation,
} from './store.ts'
import { hasPersistenceBrokenMarker, writePersistenceBrokenMarker } from './persistence-guard.ts'

export interface MaoAppOptions {
  store: MaoStore
  /** Local directory where repos get cloned so CLI agents can make real file edits. */
  workspaceRoot: string
  /**
   * Per-user app data directory (Electron's `app.getPath('userData')`, or the CLI's resolved
   * `defaultDataDir()`/`MAO_DATA_DIR`) — passed explicitly rather than derived from `workspaceRoot`
   * so its location doesn't depend on an incidental relationship between the two. Used only to
   * durably record a confirmed queue-persistence failure via a marker file independent of
   * `MaoStore` (see core/persistence-guard.ts) — both shipped `MaoStore` backends rewrite their
   * entire JSON blob on every `set()`, so a flag written *through* `store` would retry the exact
   * write that just failed.
   */
  dataDir: string
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
  /**
   * Discards an unreadable stored workflow queue and releases the halt — the one way out of the latch.
   *
   * Lives here rather than on `WorkflowEngine` because the write has to be **conditional**, and the
   * engine holds no store reference (architecture rule 3). Observing the queue and then writing
   * unconditionally is not enough: a repair that lands between the two is destroyed and reported as
   * success. See the implementation for the ordering the correctness rests on.
   */
  confirmQueueRecovery: () => QueueRecoveryOutcome
  /**
   * The only supported way to change the tracked-repository list. Reads, preflights and writes as one
   * serialized unit (see core/repo-registry.ts) — writing `githubRepos` through `store` directly
   * reopens the late-write race that lets a slow registration resurrect a removed repository.
   */
  updateRepos: ReturnType<typeof createRepoRegistrar>
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
/**
 * One guarded observation of the stored queue — the value, whether the guard replaced it, and whether
 * the store could be read at all.
 *
 * The single helper for both uses, so the boot decision and the engine's pre-write check cannot differ
 * in how they treat a store that cannot be read. Fails closed, and says so without interpolating the
 * error: a parse or I/O failure is free to quote the file's own text, and `config.json` holds
 * `githubToken` in plaintext. `readable: false` is a third answer, not a flavour of "unusable" —
 * `confirmQueueRecovery()` refuses to write on it and replaces on the other, which is the distinction
 * the previous string-valued probe collapsed.
 */
function observeStoredQueue(store: MaoStore): StoredObservation<typeof QUEUE_GATING_FIELD> {
  try {
    return store.inspect(QUEUE_GATING_FIELD)
  } catch {
    return {
      value: [],
      problem: describeUninspectableStore(QUEUE_GATING_FIELD, 'the config file'),
      readable: false,
      witness: undefined,
    }
  }
}

export function createMaoApp({ store, workspaceRoot, dataDir, resume }: MaoAppOptions): MaoApp {
  const githubService = new GithubService()
  const workflowEngine = new WorkflowEngine(githubService)

  const token = store.get('githubToken')
  if (token) {
    githubService.setToken(token)
    workflowEngine.setGithubToken(token)
  }
  workflowEngine.setProviders(store.get('aiProviders'))
  workflowEngine.setWorkspaceRoot(workspaceRoot)

  // Latched BEFORE the `'change'` subscription below and before restore(), and that ordering is the
  // whole fix. An unreadable `workflowTasks` is coerced to `[]` by the read guard, which looked safe
  // because resuming an empty queue is a no-op — but both long-lived hosts call startAutoTrigger()
  // straight after this function and it ticks immediately, so the first poll's enqueueFromIssue() would
  // notify(), the listener below would store.set('workflowTasks', …), and that single write would destroy
  // the only salvageable copy of the unreadable value *and* start an unattended pipeline on a host that
  // cannot know what was already in flight. Latching here makes every queue path refuse instead.
  // ONE observation, used for BOTH the latch below and `restore()` further down, and that is the fix for
  // the second window review found. `problems()` and `get()` are two separate reads, and electron-store
  // re-reads and re-parses the config file on every `get` — so a hand-edit (or another CLI) turning
  // `workflowTasks` from an array into a non-array BETWEEN them left the first read saying "healthy", so
  // no latch, while the second was coerced to `[]` and restored. The host then ran UNLATCHED with an
  // empty queue, auto-trigger ticked immediately, and the unreadable original was overwritten while
  // unattended work began — exactly what the latch exists to prevent. There is now no second read to
  // disagree with.
  const observedQueue = observeStoredQueue(store)
  if (observedQueue.problem !== undefined) workflowEngine.requireQueueRecovery(observedQueue.problem)

  workflowEngine.on('change', (tasks: QueuedTask[]) => {
    // Last-resort backstop, and a SILENT return rather than a throw: notifyAfterStage() reads a throwing
    // `'change'` listener as a persistence failure and would escalate this read-shape halt into a bogus
    // persistenceBroken. Reads the field only — never the store — because confirmQueueRecovery() clears
    // the field and then notifies, and that one emit IS the write that replaces the unreadable value; a
    // backstop that re-inspected the store here would re-latch inside it and deadlock the only way out.
    // Every public mutator already asserts the latch, so reaching this is a bug in a future emitter; it
    // exists so such a bug costs a missing persist instead of the operator's last copy.
    if (workflowEngine.isQueueRecoveryLatched()) return
    store.set('workflowTasks', tasks)
  })
  // Best-effort durable record of a confirmed persistence failure (see
  // WorkflowEngine.isPersistenceBroken()) — via a marker file independent of `store` (see
  // core/persistence-guard.ts's module doc for why going through `store` here wouldn't actually be
  // independent). If even this minimal write also fails, there's nothing more this process can do;
  // the in-memory flag on workflowEngine still stops it from running further stages for the rest of
  // this process's life.
  workflowEngine.on('persistence-broken', (err: Error) => {
    try {
      writePersistenceBrokenMarker(dataDir, err)
    } catch {
      // Nothing more we can do — even this independent, minimal write has now failed too.
    }
  })

  // A prior process confirmed it could no longer durably persist queue state (see above) and may
  // have advanced a task's stage in memory — including real GitHub writes — without that advance
  // reaching workflowTasks. The on-disk snapshot can therefore predate work that already happened;
  // auto-resuming from it risks re-running (duplicating) that work. Refuse to auto-resume — no
  // matter what the caller asked for — until an operator has verified the queue and explicitly
  // cleared the marker (`mao config clear-persistence-broken`).
  // Two independent facts, deliberately not conflated: the marker means a prior process could no longer
  // *write*, the latch means this process cannot *read* the queue. `mao config show` reports them
  // separately so neither is diagnosed as the other.
  const safeToResume = resume && !hasPersistenceBrokenMarker(dataDir) && !workflowEngine.isQueueRecoveryLatched()
  // The value from the same observation the latch was decided on — never a second `store.get`.
  workflowEngine.restore(observedQueue.value, { resume: safeToResume })

  /**
   * Observe, then write **only if nothing moved**, then release the halt.
   *
   * Every step is ordered for a failure that was actually reproduced:
   *
   * 1. Observe once. A store that cannot be read answers `'unverified'` and writes nothing — a transient
   *    failure, or a repair this process cannot see, must not be overwritten on a guess.
   * 2. Already readable? Write nothing. Something healed the file while this process stayed halted (the
   *    latch is monotone), and this process is still holding the coerced empty queue, so writing it would
   *    destroy that repair. The operator restarts to load the real one.
   * 3. Write **conditionally**, keyed on the value just observed. This is the step that makes step 2
   *    mean something: observing immediately before an unconditional write still loses a repair that
   *    lands in between, which is exactly what review found here. `'superseded'` writes nothing.
   * 4. Release the halt only after a confirmed write. Clearing first and writing after would leave a
   *    released engine over a queue that was never replaced.
   *
   * Not a cross-process lock: a write landing after this one can still overwrite it (issue #73).
   */
  function confirmQueueRecovery(): QueueRecoveryOutcome {
    if (!workflowEngine.isQueueRecoveryLatched()) return { kind: 'already-readable' }

    const observed = observeStoredQueue(store)
    if (!observed.readable) {
      return { kind: 'unverified', reason: observed.problem ?? describeUninspectableStore(QUEUE_GATING_FIELD, 'the config file') }
    }
    if (observed.problem === undefined) return { kind: 'already-readable' }

    let written
    try {
      // The engine's own queue — at a latched boot the coerced empty one, i.e. exactly what every reader
      // in this process has been operating on.
      written = store.setIfUnchanged(QUEUE_GATING_FIELD, observed.witness, workflowEngine.getTasks())
    } catch {
      // What reached the file is unknown, so the halt stands. The backend's error text is deliberately
      // not carried: it can quote a file that holds the GitHub token in plaintext.
      return { kind: 'write-failed' }
    }
    if (written === 'superseded') return { kind: 'superseded' }
    if (written === 'unverifiable') {
      return { kind: 'unverified', reason: describeUninspectableStore(QUEUE_GATING_FIELD, 'the config file') }
    }

    workflowEngine.clearQueueRecovery()
    return { kind: 'replaced' }
  }

  return {
    githubService,
    workflowEngine,
    store,
    updateRepos: createRepoRegistrar(githubService, store),
    confirmQueueRecovery,
  }
}
