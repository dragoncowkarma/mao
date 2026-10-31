import { createHash } from 'node:crypto'
import { GithubService } from './github-service.ts'
import { createRepoRegistrar } from './repo-registry.ts'
import {
  QUEUE_PERSISTENCE_BROKEN,
  QueuePersistenceError,
  WorkflowEngine,
  type QueuedTask,
  type QueueRecoveryOutcome,
} from './workflow-engine.ts'
import type { AiProviderConfig } from './ai/types.ts'
import {
  QUEUE_GATING_FIELD,
  STORE_RESTART_REQUIRED,
  describeUninspectableStore,
  operatorSafeStoreMessage,
  storeWriteRequiresRestart,
  storedValueWitness,
  type MaoStore,
  type StoredObservation,
} from './store.ts'
import { StoreLockError } from './store-file.ts'
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
   * Saves the complete provider editor snapshot only while the raw stored list is readable and — when
   * `base` is given — still the list the editor loaded. This prevents the GUI from overwriting a hidden
   * invalid entry (and its apiKey) with the read guard's filtered view, and from overwriting a list
   * another process changed after the editor loaded it.
   */
  saveProviders: (providers: AiProviderConfig[], base?: AiProviderConfig[]) => AiProviderConfig[]
  /**
   * Replaces an unusable stored queue with its freshly observed readable tasks and releases the halt.
   * Invalid entries are discarded; valid entries survive the ordinary restart normalization.
   *
   * Lives here rather than on `WorkflowEngine` because the write has to be **conditional**, and the
   * engine holds no store reference (architecture rule 3). Observing the queue and then writing
   * unconditionally is not enough: a repair that lands between the two is destroyed and reported as
   * success. See the implementation for the ordering the correctness rests on.
   */
  confirmQueueRecovery: () => QueueRecoveryOutcome
  /**
   * Rewrites a wrong-shaped stored queue field from the one this session holds, after a clean start.
   * Same conditional write as `confirmQueueRecovery()`, and refuses while halted — a whole-file failure
   * cannot use this path and requires restart. See the implementation for why sharing the sequence is
   * the point.
   */
  resaveStoredQueue: () => QueueRecoveryOutcome
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
      defect: undefined,
      readable: false,
      witness: undefined,
    }
  }
}

/**
 * The report for a queue write refused because the stored queue is no longer the one this process last
 * read or wrote — another MAO host is writing it too (issue #73).
 *
 * Value-free, like every store report. It says what the refusal costs and what to do, because it is the
 * text a halted `mao run` prints and the persistence-broken marker records: the engine reads a refused
 * write as a persistence failure and stops running stages, which is the point — two engines advancing one
 * queue are two engines able to repeat the same GitHub work.
 */
export function describeQueueWriteConflict(): string {
  return (
    '[store] Refusing to write "workflowTasks": another MAO process changed the stored workflow queue ' +
    'since this one last read or wrote it, and writing this process\'s queue would discard that change. ' +
    'Nothing was written, and this process runs no further stages. Run one MAO host per config file at a ' +
    'time (`mao run`, the desktop app, or a one-shot `mao workflow` command that processes the queue): ' +
    'stop the others, check `mao workflow list` and the target repos for work either may have repeated, ' +
    'then restart this one so it loads the queue as it is stored now.'
  )
}

/**
 * How many *removed* task ids' forms a host remembers as its own (see `ownTaskForms` in `createMaoApp`) —
 * tasks it has cleared or capped away. Tasks still in the queue are always remembered on top of this, so a
 * task removed stays recognised for many hundreds of later removals while the map stays bounded in a host
 * that runs for months.
 */
const OWN_TASK_FORM_IDS = 1_000

/** Why a re-save refused: the unusable stored queue holds readable tasks this session never loaded or wrote. */
function describeForeignTasksInStoredQueue(): string {
  return (
    '[store] The stored workflow queue is unusable, but it still holds readable tasks this session never ' +
    'loaded or wrote — another MAO host\'s, or an edit made from a copy this session never held — so saving ' +
    'this session\'s queue over it would delete them. Nothing was written, and this session cannot persist ' +
    'its queue while they are there. Stop every MAO host on this config file, this one included; copy out ' +
    'anything you need from the file; then, with no MAO host running, recover it with `mao workflow ' +
    'confirm-queue-recovery`, which keeps every readable task.'
  )
}

export function createMaoApp({ store, workspaceRoot, dataDir, resume }: MaoAppOptions): MaoApp {
  const githubService = new GithubService()
  const workflowEngine = new WorkflowEngine(
    githubService,
    (tasks) => {
      const problem = store.validateWrite('workflowTasks', tasks)
      if (problem !== undefined) throw new Error(problem)
    },
    () => {
      // Every public queue mutation is immediately followed by a synchronous persistence emit. Probe
      // the same fresh whole-file state before mutation so a refused write cannot leave hidden in-memory
      // state. Unlike a wrong-shaped field, which the live queue can heal, a whole-file failure means a
      // snapshot-backed FileStore must remain halted until restart or it can overwrite an external repair.
      const observed = observeStoredQueue(store)
      return observed.readable ? undefined : STORE_RESTART_REQUIRED
    },
  )
  const persistenceRecoveryRequired = hasPersistenceBrokenMarker(dataDir)
  if (persistenceRecoveryRequired) workflowEngine.requirePersistenceRecovery()

  const token = store.get('githubToken')
  if (token) {
    githubService.setToken(token)
    workflowEngine.setGithubToken(token)
  }
  workflowEngine.setProviders(store.get('aiProviders'))
  workflowEngine.setWorkspaceRoot(workspaceRoot)

  // Latched BEFORE the `'change'` subscription below and before restore(), and that ordering is the
  // whole fix. An unusable `workflowTasks` was once coerced wholesale to `[]`, which looked safe
  // because resuming an empty queue is a no-op — but both long-lived hosts call startAutoTrigger()
  // straight after this function and it ticks immediately, so the first poll's enqueueFromIssue() would
  // notify(), the listener below would store.set('workflowTasks', …), and that single write would destroy
  // the only salvageable copy of the unreadable value *and* start an unattended pipeline on a host that
  // cannot know what was already in flight. Latching here makes every queue path refuse instead.
  // ONE observation, used for BOTH the latch below and `restore()` further down, and that is the fix for
  // the second window review found. `problems()` and `get()` are two separate reads, and electron-store
  // re-reads and re-parses the config file on every `get` — so a hand-edit (or another CLI) turning
  // `workflowTasks` from an array into a non-array BETWEEN them left the first read saying "healthy", so
  // no latch, while the second was corrected and restored. The host then ran UNLATCHED with a queue
  // that no longer represented every durable entry, auto-trigger ticked immediately, and the original
  // was overwritten while unattended work began — exactly what the latch exists to prevent. There is
  // now no second read to disagree with.
  const observedQueue = observeStoredQueue(store)
  if (observedQueue.problem !== undefined) {
    workflowEngine.requireQueueRecovery(observedQueue.readable ? observedQueue.problem : STORE_RESTART_REQUIRED, {
      restartRequired: !observedQueue.readable,
    })
  }

  /**
   * Which stored queue this process's engine queue was derived from: the boot observation, then each
   * write this process makes. Every queue write is conditional on the file still holding it.
   *
   * This is the same-key half of issue #73. A plain `store.set` merges into a fresh read, so the queue no
   * longer reverts *other* keys — but the queue itself is derived state: the engine holds what it loaded
   * plus its own changes, so writing it unconditionally silently drops anything another MAO host wrote to
   * the queue meanwhile (a task a one-shot `mao workflow enqueue` added, a stage the desktop app advanced).
   * Refusing makes that conflict an explicit persistence failure instead: the engine parks the task in
   * `'error'`, retries the write once, and then trips `persistenceBroken` and the durable marker — the
   * existing machinery for "this process can no longer persist its queue", and the right outcome when
   * a second engine is running the same queue.
   *
   * Keyed on the witness of this process's own last write (`storedValueWitness`) rather than on a fresh
   * observation after it, so a queue change costs the compare read and no second one.
   */
  let persistedQueueWitness = observedQueue.witness
  /**
   * Every form of each task this process has loaded or written, by task id — as hashes of its serialization
   * in the read guard's form, so the set stays small however large a task's prompts and output grow.
   *
   * What the late-corruption checks need is not "what did this process write last" but "would replacing
   * this stored value delete anything only another host had". A stored task in a form this process itself
   * loaded or wrote — the boot form, or an older write left behind in an editor buffer saved late — is this
   * process's own past state, and overwriting it with the present loses nothing. Recognising only the last
   * write made exactly that stale buffer read as another host's work, so the re-save refused, blamed a host
   * that did not exist, and left the session with no way to persist its queue. The boot forms are the
   * guard-normalized reading, not the raw witness, because a queue an older build wrote (a task repo with
   * registry settings, no `autoAdvance`) reads back normalized.
   *
   * A task this process removed itself — "Clear completed", or the finished-task cap dropping the oldest on
   * every completion of a busy host — keeps its forms too: a stale copy of it is still this process's own
   * past state, and forgetting it at removal wedged the session the same way the last-write-only rule did.
   * The map is bounded instead, by recency, and only among tasks that have left the queue: each write
   * touches the ids it holds, and of the ids it does *not* hold, the least-recently-touched beyond
   * `OWN_TASK_FORM_IDS` are forgotten. A task still in the queue is never forgotten, however many there are
   * — forgetting a live one made this process's own queue read as another host's. Hashes, so a few
   * hundred kilobytes.
   */
  const ownTaskForms = new Map<string, Set<string>>()
  const formOf = (task: QueuedTask) => createHash('sha256').update(JSON.stringify(task)).digest('hex')
  function rememberOwnForms(tasks: QueuedTask[]) {
    for (const task of tasks) {
      const forms = ownTaskForms.get(task.id) ?? new Set<string>()
      forms.add(formOf(task))
      // Re-inserted so the map's insertion order is recency order.
      ownTaskForms.delete(task.id)
      ownTaskForms.set(task.id, forms)
    }
    const live = new Set(tasks.map((task) => task.id))
    let removedCount = ownTaskForms.size - live.size
    for (const id of ownTaskForms.keys()) {
      if (removedCount <= OWN_TASK_FORM_IDS) break
      if (live.has(id)) continue
      ownTaskForms.delete(id)
      removedCount -= 1
    }
  }
  rememberOwnForms(observedQueue.value)

  /** Records a confirmed write of `tasks` as the stored queue this process's next write is keyed on. */
  function recordQueueWrite(tasks: QueuedTask[]) {
    persistedQueueWitness = storedValueWitness(tasks)
    rememberOwnForms(tasks)
  }

  /** Whether every readable task in `readable` is in a form this process has itself loaded or written. */
  function onlyHoldsTasksThisProcessWrote(readable: QueuedTask[]): boolean {
    return readable.every((task) => ownTaskForms.get(task.id)?.has(formOf(task)) === true)
  }

  /**
   * A queue write this process could not make, reported as having written nothing.
   *
   * Every refusal below is decided before the backend writes, so `'not-written'` is what it establishes:
   * a public mutation rolls its in-memory change back (`notifyPublicMutation`), and a stage's exit
   * notification parks the task in `'error'` and, on a second refusal, records `persistenceBroken`.
   */
  function refuseQueueWrite(message: string): never {
    throw new QueuePersistenceError(message, 'not-written')
  }

  /**
   * The stored queue could not be read or compared, so this process can establish nothing about it —
   * the whole-file outage `healStoredQueue()` and the readiness probe treat as restart-required.
   */
  function refuseUnverifiableQueueWrite(): never {
    workflowEngine.requireQueueRecovery(STORE_RESTART_REQUIRED, { restartRequired: true })
    refuseQueueWrite(STORE_RESTART_REQUIRED)
  }

  function writeQueue(tasks: QueuedTask[]) {
    const result = store.setIfUnchanged(QUEUE_GATING_FIELD, persistedQueueWitness, tasks)
    if (result === 'written') {
      recordQueueWrite(tasks)
      return
    }
    if (result === 'invalid') {
      refuseQueueWrite(
        store.validateWrite(QUEUE_GATING_FIELD, tasks) ??
          'The workflow queue failed validation. No stored value is shown.',
      )
    }
    if (result === 'unverifiable') refuseUnverifiableQueueWrite()

    // Moved. One case is not another writer's work: a value that went *unusable* after this session booted
    // clean. Then this engine holds the real queue and its next write is documented to restore the file
    // from it (the Sidebar's late-corruption card says exactly that) — so repair it, conditionally on the
    // unusable value just observed. A usable value that moved is someone else's queue, and is refused.
    //
    // "Unusable" alone is not enough, though: a mixed array can still hold readable tasks this process
    // never wrote — another host's queue, then hand-edited or written by a build whose task shape this one
    // rejects — and overwriting it would delete them, which is the very loss the refusal exists to stop.
    // So the repair is taken only when every readable task left in the stored value is one this process
    // itself loaded or wrote; anything else is a conflict.
    const current = observeStoredQueue(store)
    if (!current.readable) refuseUnverifiableQueueWrite()
    if (current.problem === undefined || !onlyHoldsTasksThisProcessWrote(current.value)) {
      refuseQueueWrite(describeQueueWriteConflict())
    }
    const repaired = store.setIfUnchanged(QUEUE_GATING_FIELD, current.witness, tasks)
    if (repaired === 'written') {
      recordQueueWrite(tasks)
      return
    }
    if (repaired === 'superseded') refuseQueueWrite(describeQueueWriteConflict())
    refuseUnverifiableQueueWrite()
  }

  /**
   * Persists the engine's queue — conditionally, see `persistedQueueWitness` — and turns every failure into
   * a `QueuePersistenceError` that says whether anything can have reached the file.
   */
  function persistQueue(tasks: QueuedTask[]) {
    try {
      writeQueue(tasks)
    } catch (error) {
      if (error instanceof QueuePersistenceError) throw error
      // The lock was never taken, so nothing was written; its message names only the lock path and holder.
      if (error instanceof StoreLockError) refuseQueueWrite(error.message)
      // Close the preflight -> write TOCTOU when the store's own fresh write guard is what detected the
      // whole-file outage. Upgrade before rethrowing so a repaired snapshot-backed process cannot try a
      // later mutation and serialize its startup settings over the repair.
      if (storeWriteRequiresRestart(error)) {
        workflowEngine.requireQueueRecovery(STORE_RESTART_REQUIRED, { restartRequired: true })
      }
      const safeMessage = operatorSafeStoreMessage(error)
      throw new QueuePersistenceError(
        safeMessage ?? 'The workflow queue could not be persisted. No stored value or backend error is shown.',
        safeMessage === undefined ? 'unknown' : 'not-written',
      )
    }
  }

  workflowEngine.on('change', (tasks: QueuedTask[]) => {
    // Public mutators are gated before mutation and roll back if this listener throws. Reaching this
    // while latched therefore means an in-flight stage crossed the outage during an await (or a future
    // emitter missed its gate). Throwing is load-bearing: runStage's guarded exit records
    // persistenceBroken, preventing restart from replaying external work whose final state could not be
    // stored. A silent return leaves durable `running` behind and turns it back into `pending` on boot.
    if (workflowEngine.isPersistenceBroken()) {
      throw new QueuePersistenceError(QUEUE_PERSISTENCE_BROKEN, 'not-written')
    }
    const blocked = workflowEngine.getQueueRecoveryReason()
    if (blocked !== undefined) throw new QueuePersistenceError(blocked, 'not-written')
    persistQueue(tasks)
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
  // reaching workflowTasks. The on-disk snapshot can therefore predate work that already happened.
  // Carry the marker into persistenceBroken before restore: merely setting resume=false is insufficient,
  // because auto-trigger's immediate enqueue (or a later click) calls processQueue and would wake every
  // restored pending task. Mutation, polling and resume all stay blocked until an operator verifies the
  // queue, clears the marker (`mao config clear-persistence-broken`) and starts a fresh process.
  // Two independent facts, deliberately not conflated: the marker means a prior process could no longer
  // *write*, the latch means this process cannot *read* the queue. `mao config show` reports them
  // separately so neither is diagnosed as the other.
  const safeToResume =
    resume && !persistenceRecoveryRequired && !workflowEngine.isQueueRecoveryLatched()
  // The value from the same observation the latch was decided on — never a second `store.get`.
  workflowEngine.restore(observedQueue.value, { resume: safeToResume })

  /**
   * Persist the provider editor's complete list without letting a filtered read become destructive.
   *
   * `ai:list` intentionally returns only structurally valid entries so the renderer stays usable. If
   * the raw list is mixed, that means the editor does not hold everything on disk — an unconditional
   * save would permanently delete the hidden entries and any API keys they contain. Inspect once,
   * refuse that state, then key the write to the clean observation. The engine adopts the new providers
   * only after the durable write succeeds.
   *
   * The observation is taken when Save is clicked, so on its own it only covers the instant of the save.
   * What the editor's list was derived from is `base` — the list Global settings loaded — and an edit
   * made from it must not land over a list that moved since: a `mao config import-providers` run in a
   * terminal while the pane was open would otherwise be deleted by the next Save, imported API keys
   * included, with nothing said (issue #73). So a `base` that is no longer what is stored refuses, the
   * same way a list that moves during the save does. Without `base` (no editor load to compare with) the
   * check is the save-time one alone, as before.
   */
  function saveProviders(providers: AiProviderConfig[], base?: AiProviderConfig[]): AiProviderConfig[] {
    let observed: StoredObservation<'aiProviders'>
    try {
      observed = store.inspect('aiProviders')
    } catch {
      throw new Error(
        'Cannot save AI providers because the stored provider list could not be read. Nothing was ' +
          'written; inspect the config file and retry.',
      )
    }

    if (!observed.readable) {
      throw new Error(
        'Cannot save AI providers because the stored provider list could not be read. Nothing was ' +
          'written; inspect the config file and retry.',
      )
    }
    if (observed.problem !== undefined) {
      throw new Error(
        'Cannot save the filtered provider list from Global settings. Nothing was written. ' +
          observed.problem,
      )
    }

    const validationProblem = store.validateWrite('aiProviders', providers)
    if (validationProblem !== undefined) throw new Error(validationProblem)

    if (base !== undefined && storedValueWitness(base) !== observed.witness) {
      throw new Error(
        'The stored AI provider list changed after Global settings loaded it — another MAO process, or ' +
          'an edit to the config file. Nothing was written; reopen Global settings and apply the edit again.',
      )
    }

    let result
    try {
      result = store.setIfUnchanged('aiProviders', observed.witness, providers)
    } catch (err) {
      // Nothing was written while another MAO process held the lock; say that, not "unknown".
      if (err instanceof StoreLockError) throw new Error(`Nothing was saved. ${err.message}`)
      throw new Error(
        'The AI provider write failed, so what reached the config file is unknown. Inspect the file ' +
          'before retrying; no provider value, token or API key is shown.',
      )
    }

    if (result === 'invalid') {
      throw new Error('The AI provider replacement was rejected before any write. Nothing was written.')
    }
    if (result === 'superseded') {
      throw new Error(
        'The stored AI provider list changed before Save completed. Nothing was written; reload ' +
          'Global settings and apply the edit again.',
      )
    }
    if (result === 'unverifiable') {
      throw new Error(
        'The stored AI provider list could not be verified before Save. Nothing was written; inspect ' +
          'the config file and retry.',
      )
    }

    workflowEngine.setProviders(providers)
    return providers
  }

  /**
   * Replace an unusable stored queue — observed fresh, written only if nothing moved, and never on a
   * state that could not be established.
   *
   * The single implementation behind both operator actions, because they are the same write with
   * different preconditions and replacement sources. A halted session writes the *fresh observation's*
   * readable subset, so a valid task added after boot is retained while invalid entries are discarded
   * with explicit confirmation. A session that booted clean writes its live engine queue, so this is a
   * repair and is safe to offer directly.
   * Sharing the sequence is what stops one of them drifting into an unconditional write — which is
   * exactly what happened to the re-save when it was built separately on
   * `WorkflowEngine.persistQueue()`: it emitted the in-memory queue with no fresh observation at all,
   * so an external repair landing after the 30s poll and before the click was overwritten by a stale
   * queue.
   *
   * Step order, each step for a failure that was reproduced:
   *
   * 1. Observe once, fresh. A store that cannot be read upgrades the process to `'restart-required'`
   *    and writes nothing — a transient failure, or a repair this process cannot see, must not be
   *    overwritten on a guess or reconsidered later from a stale startup snapshot.
   * 2. Already readable? Write nothing. Something healed the file; writing would replace it with this
   *    process's queue, which for a halted session is filtered/normalized and for a clean one may be
   *    stale.
   * 3. Choose the replacement from that same fresh observation when halted, or from the live engine
   *    when repairing a clean session. Mixing a fresh witness with the boot-time halted queue loses valid
   *    tasks another process added while leaving the stored queue mixed.
   * 4. Write **conditionally**, keyed on the value just observed. Observing before an unconditional
   *    write still loses a repair landing in between. `'superseded'` writes nothing.
   * 5. After a confirmed halted write, restore the engine from the same readable subset and only then
   *    release the halt. It is still not resumed in this process.
   *
   * 6. Record the write as the queue this process's later writes are keyed on (`persistedQueueWitness`),
   *    or the engine's next change would mistake this recovery for another process's work and refuse it.
   *
   * Its limit is stated where it is implemented (`MaoStore.setIfUnchanged`): the compare and the write
   * share one hold of the config file's cross-process write lock, so no other MAO process can land a write
   * between them (issue #73) — but a writer that takes no lock, a hand-edit included, still can.
   */
  function healStoredQueue(replacementSource: 'fresh-subset' | 'live-engine'): QueueRecoveryOutcome {
    // A persistence-broken marker means the durable queue may predate GitHub work that already happened.
    // Neither recovery action may rewrite that uncertain baseline before the operator reconciles it.
    if (workflowEngine.isPersistenceBroken()) {
      return { kind: 'unverified', reason: QUEUE_PERSISTENCE_BROKEN }
    }
    // Once this process has observed a whole-file failure, even a now-readable field-only problem is
    // unsafe to heal: FileStore would serialize every other setting from its startup snapshot. Keep the
    // origin, not merely the current problem shape, as the authority.
    if (workflowEngine.isQueueRecoveryRestartRequired()) return { kind: 'restart-required' }

    const observed = observeStoredQueue(store)
    if (!observed.readable) {
      workflowEngine.requireQueueRecovery(STORE_RESTART_REQUIRED, { restartRequired: true })
      return { kind: 'restart-required' }
    }
    if (observed.problem === undefined) return { kind: 'already-readable' }
    // The re-save writes this session's queue over the stored value, so it has the same duty as the
    // automatic repair in `persistQueue`: an unusable value can still hold readable tasks another host
    // wrote, and replacing it would delete them. The halted discard is different — it writes the fresh
    // observation's own readable subset, which keeps every readable task whoever wrote it.
    if (replacementSource === 'live-engine' && !onlyHoldsTasksThisProcessWrote(observed.value)) {
      return { kind: 'unverified', reason: describeForeignTasksInStoredQueue() }
    }

    const replacement =
      replacementSource === 'fresh-subset' ? observed.value : workflowEngine.getTasks()
    let written
    try {
      written = store.setIfUnchanged(QUEUE_GATING_FIELD, observed.witness, replacement)
    } catch (err) {
      // Another MAO process held the write lock throughout: nothing was written, which is a stronger
      // statement than `'write-failed'` makes, and its message is value-free by construction.
      if (err instanceof StoreLockError) return { kind: 'unverified', reason: err.message }
      // What reached the file is unknown. Promote this to the same durable persistence block as a
      // failed ordinary queue write: a restart must not normalize and resume a queue whose recovery
      // write may or may not have landed. The backend's error text is deliberately not carried because
      // it can quote a file that holds the GitHub token in plaintext.
      workflowEngine.markPersistenceBroken()
      return { kind: 'write-failed' }
    }
    if (written === 'superseded') return { kind: 'superseded' }
    if (written === 'invalid') return { kind: 'invalid-replacement' }
    if (written === 'unverifiable') {
      workflowEngine.requireQueueRecovery(STORE_RESTART_REQUIRED, { restartRequired: true })
      return { kind: 'restart-required' }
    }
    // This write is now the stored queue this process's later writes are derived from — without this the
    // engine's very next change would read its own recovery as another process's and refuse it.
    recordQueueWrite(replacement)

    if (replacementSource === 'fresh-subset') {
      // `restore()` emits nothing and `resume: false` is explicit: confirmation may update the in-memory
      // queue to valid tasks found after boot, but it must never turn a one-shot recovery command into
      // unattended GitHub work. Normal restore semantics still normalize a prior `running` task and cap
      // finished history; the durable replacement above preserves every structurally valid entry.
      workflowEngine.restore(observed.value, { resume: false })
    }
    if (workflowEngine.isQueueRecoveryLatched() && !workflowEngine.clearQueueRecovery()) {
      return { kind: 'restart-required' }
    }
    return { kind: 'replaced' }
  }

  /**
   * Discards only the unreadable part of a stored queue and releases the halt. Only meaningful while
   * halted — the queue it writes is the guard's readable subset, which is why this needs the operator's
   * confirmation. It deliberately does not start those retained tasks itself: this same core path serves
   * the one-shot CLI recovery command, whose `resume: false` contract forbids real GitHub work. In an
   * already-running host, later queue activity may call processing after the latch is released; do not
   * describe confirmation as keeping that host paused until restart.
   */
  function confirmQueueRecovery(): QueueRecoveryOutcome {
    if (workflowEngine.isPersistenceBroken()) {
      return { kind: 'unverified', reason: QUEUE_PERSISTENCE_BROKEN }
    }
    if (!workflowEngine.isQueueRecoveryLatched()) return { kind: 'already-readable' }
    if (workflowEngine.isQueueRecoveryRestartRequired()) return { kind: 'restart-required' }
    return healStoredQueue('fresh-subset')
  }

  /**
   * Rewrites an unusable stored queue from the real one this session is holding, for a value that went
   * unusable *after* a clean start.
   *
   * Refuses while halted, and that refusal is load-bearing rather than defensive: a halted session's
   * queue is only the validated subset, so letting this run would silently discard invalid durable
   * entries with none of the confirmation `confirmQueueRecovery()` requires.
   */
  function resaveStoredQueue(): QueueRecoveryOutcome {
    if (workflowEngine.isPersistenceBroken()) {
      return { kind: 'unverified', reason: QUEUE_PERSISTENCE_BROKEN }
    }
    if (workflowEngine.isQueueRecoveryRestartRequired()) return { kind: 'restart-required' }
    if (workflowEngine.isQueueRecoveryLatched()) {
      return {
        kind: 'unverified',
        reason:
          'This session cannot save its live queue while workflow recovery is halted. Nothing was ' +
          'written; use the confirmed recovery action for a field-only problem.',
      }
    }
    return healStoredQueue('live-engine')
  }

  return {
    githubService,
    workflowEngine,
    store,
    saveProviders,
    updateRepos: createRepoRegistrar(githubService, store),
    confirmQueueRecovery,
    resaveStoredQueue,
  }
}
