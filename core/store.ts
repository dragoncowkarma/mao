import fs from 'node:fs'
import path from 'node:path'
import type { AiProviderConfig } from './ai/types.ts'
import type { QueuedTask, RepoRef } from './workflow-engine.ts'

/**
 * UI color scheme preference. 'system' follows the OS-level `prefers-color-scheme` media query and
 * is the default — it's the only option that doesn't require the user to make a choice up front.
 */
export type ThemePreference = 'light' | 'dark' | 'system'

export interface MaoStoreSchema {
  githubToken: string
  githubRepos: RepoRef[]
  aiProviders: AiProviderConfig[]
  workflowTasks: QueuedTask[]
  /**
   * Git commit SHA for the Electron build currently running. Electron writes this on boot from the
   * build-time constant when available so the update checker can compare the app's own repository
   * `main` branch against the binary the user is actually running.
   */
  buildSha: string
  theme: ThemePreference
}

export const MAO_STORE_DEFAULTS: MaoStoreSchema = {
  githubToken: '',
  githubRepos: [],
  aiProviders: [],
  workflowTasks: [],
  buildSha: '',
  theme: 'system',
}

/**
 * How a value reads in an operator-facing message, so a report says what is actually in the file
 * rather than only what was expected. `typeof` alone prints `object` for both `null` and `{…}`, which
 * are the two likeliest hand-edits, so those are separated out.
 */
function describeStoredType(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'absent'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * Every `MaoStoreSchema` field whose declared type is an array — derived from the schema by a mapped
 * type rather than listed by hand.
 *
 * That derivation is the lockstep mechanism, not decoration: adding a new array-typed field to
 * `MaoStoreSchema` makes `GUARDED_LIST_FIELDS` below stop satisfying `Record<StoredListField, …>`, so
 * `npm run lint` fails until its author has written that field's consequence and recovery hint. The
 * first version of this guard covered `githubRepos` alone and left the other two to throw, which is
 * precisely the drift a hand-maintained list invites — the schema now refuses to let it recur.
 */
type StoredListField = {
  [K in keyof MaoStoreSchema]: MaoStoreSchema[K] extends readonly unknown[] ? K : never
}[keyof MaoStoreSchema]

/** The per-field half of a report: what the array should have held, what ignoring it costs, and the way back. */
interface GuardedListField {
  /** What the schema says the array contains, phrased to follow "not a JSON array of …". */
  expected: string
  /** What an empty list means for this field, phrased to follow "ignoring it, so …". */
  consequence: string
  /**
   * The field's own recovery paragraph. Takes the config file path because every hint has to name the
   * file, and a hint is only actionable if it names the command that actually heals *this* field: the
   * fields differ in which writes are gated (a write-permission preflight) and which have side effects
   * (a whole unattended pipeline), so one shared sentence would be wrong for two of the three.
   */
  recovery: (source: string) => string
}

/**
 * What the operator is told for each guarded field.
 *
 * Every recovery hint names the *cheapest unconditional* write that heals the field, and that choice is
 * load-bearing in all three cases rather than a matter of phrasing:
 *
 * - `githubRepos` — a removal, not an add. Any list write heals the file, but only a write that
 *   registers nothing new is exempt from the write-permission preflight (see
 *   `reposNeedingCapabilityCheck`), and because an unusable value names no tracked repository, every
 *   repository in an `add` counts as new. With no token configured, or access since revoked, `mao repos
 *   add` fails in the preflight and leaves the unusable value exactly where it was, while `mao repos
 *   remove` heals regardless. Recommending the blockable path first would send an operator whose token
 *   is the reason they were editing `config.json` straight back into the wall.
 * - `aiProviders` — `mao config import-providers`, which needs no GitHub token at all, so it stays
 *   available in exactly the situation that produced the hand-edit.
 * - `workflowTasks` — `mao workflow clear-completed`, because it is the only queue write that performs
 *   no GitHub write of its own (`clearCompleted()` calls `notify()` unconditionally, so it persists even
 *   when it removed nothing). `mao workflow enqueue` would heal the field too, and would run the entire
 *   pipeline unattended to do it.
 */
const GUARDED_LIST_FIELDS: Record<StoredListField, GuardedListField> = {
  githubRepos: {
    expected: '{ owner, repo } entries',
    consequence: 'no repositories are tracked until it is replaced',
    recovery: (source) =>
      'The unusable value is still in the file; any repository-list write overwrites it. `mao repos ' +
      "remove <owner> <repo>` (or the sidebar's Remove) always works; `mao repos add` has to pass a " +
      'write-access check first, so it needs a working GitHub token. Copy any repositories you still ' +
      `need out of ${source} first.`,
  },
  aiProviders: {
    expected: 'AI provider configs',
    consequence:
      'no AI providers are registered until it is replaced, and every workflow stage fails for want ' +
      'of an agent to route to',
    recovery: (source) =>
      'The unusable value is still in the file; any provider-list write overwrites it. `mao config ' +
      "import-providers <file>` (or the GUI's Global settings pane) replaces it, and neither needs a " +
      'GitHub token. Copy any provider configs you still need out of ' +
      `${source} first — including their apiKey values, which exist nowhere else.`,
  },
  workflowTasks: {
    expected: 'queued workflow tasks',
    consequence:
      'the queue starts empty: nothing is auto-resumed, and a task that was mid-pipeline is no ' +
      'longer tracked here',
    recovery: (source) =>
      'The unusable value is still in the file; any queue write overwrites it. `mao workflow ' +
      'clear-completed` is the one to reach for, because it persists the queue without making a single ' +
      'GitHub write — unlike `mao workflow enqueue`, which would heal the field by running the whole ' +
      'pipeline. The in-flight tasks are gone either way, so before queueing more work check the ' +
      'target repo for an issue still labelled `workflow-active` whose branch or PR is half-finished. ' +
      `Copy anything you still need out of ${source} first.`,
  },
}

/**
 * The actionable report for a stored list field that is not a list — or `null` when it is one, or when
 * `field` is not a list field at all and there is nothing to say about it.
 *
 * Names the field, what the file actually holds, and the file itself, because none of those were
 * recoverable from what the operator used to get (`store.get(...).filter is not a function`). It also
 * states the recovery explicitly: the unusable value stays on disk, so the next write of that field is
 * what replaces it, and anything the operator wants to salvage has to be copied out first.
 *
 * Deliberately never prints the value. `config.json` is a single JSON blob that also holds `githubToken`
 * in plaintext, and a malformed field is exactly the kind of hand-edit that can leave a fragment of a
 * neighbouring key inside it — so the report describes the shape and stops there.
 */
export function describeUnusableStoredList(
  field: keyof MaoStoreSchema,
  value: unknown,
  source: string,
): string | null {
  const spec: GuardedListField | undefined = GUARDED_LIST_FIELDS[field as StoredListField]
  if (spec === undefined) return null
  if (Array.isArray(value)) return null
  return (
    `[store] "${field}" in ${source} is ${describeStoredType(value)}, not a JSON array of ` +
    `${spec.expected} — ignoring it, so ${spec.consequence}. ${spec.recovery(source)}`
  )
}

/** A backend's read, corrected to the shape `MaoStoreSchema` declares. See `createStoredReadGuard`. */
export type StoredReadGuard = <K extends keyof MaoStoreSchema>(key: K, raw: MaoStoreSchema[K]) => MaoStoreSchema[K]

/**
 * Closes the gap between what `MaoStoreSchema` declares and what a `config.json` can actually hold.
 *
 * `MaoStore.get()` is typed `MaoStoreSchema[K]`, but both shipped backends read unvalidated JSON and
 * fill in only the keys that are *missing* — `FileStore` by spreading the parsed file over
 * `MAO_STORE_DEFAULTS`, electron-store by its own `defaults` option. A key that is present but the
 * wrong shape therefore survives and is handed to every reader under a type promising otherwise. For
 * `githubRepos` that one fact broke every repository path at once (issue #60): `.filter` threw for
 * `mao repos remove` and `github:getRepos`, `canonicalRepoList` threw on a non-iterable `previous` for
 * `mao repos add` and for auto-trigger's per-tick canonicalisation, and `mao repos list` printed the
 * malformed value as though it were the list. Because nothing could write the list either, there was no
 * way back from inside the app — the operator had to hand-edit JSON.
 *
 * All three of the schema's array-typed fields are guarded, and the other two were no less broken:
 * a non-array `workflowTasks` reached `WorkflowEngine.restore()`'s `tasks.map(...)` *inside*
 * `createMaoApp()`, so every single `mao` command died on boot — including the `mao repos remove` that
 * issue #60's own recovery depends on — and `registerIpcHandlers()` threw before registering a single
 * channel, leaving the GUI with no working IPC at all and no in-app recovery of any kind. A non-array
 * `aiProviders` booted but killed `mao config show` on `.map`, and white-screened the GUI's Global
 * settings pane, which renders `providers.map` with no error boundary above it.
 *
 * Coercing to the empty list rather than throwing is what makes recovery possible: `updateRepos` reads
 * the stored list before it writes, so a read that throws takes `repos add` / `repos remove` down with
 * it, while a read that answers `[]` lets the very next write of that field replace the unusable value.
 * The read is deliberately not a repair — nothing here writes — so a command that only reads leaves the
 * file exactly as it found it, and the operator keeps the chance to salvage it by hand.
 *
 * **`workflowTasks` neither blocks auto-resume nor writes the persistence-broken marker**, and that is a
 * decision rather than an omission. The marker (`core/persistence-guard.ts`, consulted by `createMaoApp`
 * before it passes `resume` through) exists for one specific hazard: a process that could no longer
 * persist has advanced a task's stage in memory, including real GitHub writes, so the on-disk queue lags
 * reality and resuming *its entries* re-runs work that already happened. That hazard needs entries. The
 * coerced queue has none — `restore([])` then `resumeProcessing()` reaches a `processQueue()` that
 * iterates an empty queue and returns — so auto-resume of an unreadable queue is already a no-op, and
 * blocking it would protect nothing. Writing the marker would meanwhile be actively wrong three times
 * over: it reports a *write* failure for what is a read-shape problem, so `mao config show` would answer
 * `workflowPersistenceBroken: true` while persistence is in fact fine; it is sticky and operator-gated,
 * so it would outlive the corruption and keep blocking auto-resume of every *later*, legitimate queue
 * until someone ran `mao config clear-persistence-broken`; and it is a filesystem write, which would
 * cost this guard the "a read never repairs, and never writes" property that the whole recovery story
 * rests on. What an empty queue does cost is visibility — a task that was mid-pipeline is simply gone —
 * so the report says so and points at the `workflow-active` label as the place to look instead.
 *
 * Reported at most once per field per guard, because the cadence of reads is not the cadence of the
 * problem: auto-trigger re-reads the list on every 5s tick and `mao run` runs for days. Once per
 * process is enough to be non-silent without burying the rest of the output. Two corrupt fields
 * therefore report twice — the dedup is per field, since each names a different recovery. Written
 * through `console.warn` — i.e. stderr — so `mao repos list` and `mao config show` stay parseable on
 * stdout. `source` is the config file path, which is not itself a secret (the token lives *inside* that
 * file); no stored value is ever printed.
 *
 * Every `MaoStore` backend applies this on read — `FileStore` below, `electron/store.ts` for the GUI —
 * so the two shells cannot answer differently for the same corrupt file. A new backend must call it
 * too: that is the point of the rule living here rather than at the read sites, which are scattered
 * across `core/`, `cli/` and `electron/` and would each have to remember it.
 */
export function createStoredReadGuard(
  source: string,
  warn: (message: string) => void = (message) => console.warn(message),
): StoredReadGuard {
  const reported = new Set<keyof MaoStoreSchema>()

  return function guardStoredRead<K extends keyof MaoStoreSchema>(key: K, raw: MaoStoreSchema[K]): MaoStoreSchema[K] {
    const problem = describeUnusableStoredList(key, raw, source)
    if (problem === null) return raw
    if (!reported.has(key)) {
      reported.add(key)
      warn(problem)
    }
    // The only cast in this module, and the reason it exists: `describeUnusableStoredList` returning a
    // string cannot narrow `K`, so the replacement list has to be asserted back into the field's
    // declared type. A fresh array each time, never the corresponding `MAO_STORE_DEFAULTS` entry — that
    // instance is shared, and one caller pushing into it would poison the defaults for the rest of the
    // process.
    return [] as unknown as MaoStoreSchema[K]
  }
}

/**
 * A confirmed WorkflowEngine queue-persistence failure (see WorkflowEngine.isPersistenceBroken())
 * is deliberately NOT a MaoStoreSchema field — both shipped MaoStore backends (FileStore below, and
 * Electron's electron-store wrapper) persist their entire schema as one JSON blob and rewrite the
 * whole file on every set() call, so a flag written through `store` would just retry the exact
 * full-file write that already failed for `workflowTasks`. See core/persistence-guard.ts for the
 * independent marker-file mechanism createMaoApp uses instead.
 */

/**
 * Minimal persistence contract the core app needs. The Electron GUI backs this with electron-store
 * (see electron/store.ts); the headless CLI backs it with FileStore below. Core code never imports
 * either implementation directly, so it stays runnable outside of Electron.
 */
export interface MaoStore {
  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K]
  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void
}

/** JSON-file-backed MaoStore for CLI/headless environments that don't have electron-store available. */
export class FileStore implements MaoStore {
  private data: MaoStoreSchema
  private filePath: string
  /**
   * Shared with Electron's backend rather than reimplemented — see `createStoredReadGuard`. Held per
   * instance because "already reported" is per store, and the CLI builds a fresh `FileStore` for every
   * invocation, so each command that touches an unusable list says so exactly once.
   */
  private guardRead: StoredReadGuard

  constructor(filePath: string) {
    this.filePath = filePath
    // Cloned, not spread onto. A shallow spread copies each default's *reference*, so for any key the
    // file does not set, `get()` handed out the module-level `MAO_STORE_DEFAULTS` value itself — one
    // caller pushing into the list it read leaked a phantom entry into the default, and the next
    // `FileStore` built in that process then read it back as a tracked repository for auto-trigger to
    // poll. The read guard below owes callers a value that is theirs; this is the other half of that.
    this.data = { ...structuredClone(MAO_STORE_DEFAULTS), ...this.load() }
    this.guardRead = createStoredReadGuard(filePath)
  }

  private load(): Partial<MaoStoreSchema> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
  }

  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    return this.guardRead(key, this.data[key])
  }

  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
    this.data[key] = value
    this.persist()
  }
}
