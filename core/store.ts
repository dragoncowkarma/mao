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
 * The actionable report for a stored `githubRepos` that is not a list — or `null` when it is one and
 * there is nothing to report.
 *
 * Names the field, what the file actually holds, and the file itself, because none of those were
 * recoverable from what the operator used to get (`store.get(...).filter is not a function`). It also
 * states the recovery explicitly: the unusable value stays on disk, so the next list write is what
 * replaces it, and anything the operator wants to salvage has to be copied out first.
 *
 * The recovery it names first registers nothing, and that ordering is load-bearing. Any list write heals
 * the file, but only a write that registers nothing new is exempt from the write-permission preflight
 * (see `reposNeedingCapabilityCheck`) — and because an unusable value names no tracked repository, every
 * repository in an `add` counts as new. So with no token configured, or access since revoked, `mao repos
 * add` fails in the preflight and leaves the unusable value exactly where it was, while `mao repos
 * remove` heals regardless. Recommending the blockable path first would send an operator whose token is
 * the reason they were editing `config.json` straight back into the wall.
 *
 * It names the GUI's **Reset stored list**, not its Remove, for a reason that is easy to get wrong: an
 * unusable list leaves the sidebar with no row, so no project is selected, so the Settings tab and the
 * Remove button inside it never render. Naming an action the operator cannot reach is worse than naming
 * none. Reset is the sidebar control this report itself is shown next to, and it writes an empty list.
 */
export function describeUnusableRepoList(value: unknown, source: string): string | null {
  if (Array.isArray(value)) return null
  return (
    `[store] "githubRepos" in ${source} is ${describeStoredType(value)}, not a JSON array of ` +
    '{ owner, repo } entries — ignoring it, so no repositories are tracked until it is replaced. The ' +
    'unusable value is still in the file; any repository-list write overwrites it. `mao repos remove ' +
    "<owner> <repo>`, or the sidebar's Reset stored list, always works — neither registers anything, so " +
    'neither is checked for write access. `mao repos add` and the sidebar\'s Add are, so they need a ' +
    `working GitHub token. Copy any repositories you still need out of ${source} first.`
  )
}

type StoredShapeRule<K extends keyof MaoStoreSchema> = (raw: MaoStoreSchema[K], source: string) => string | null

/**
 * The single table of fields whose stored *shape* is validated, and the report for each — so the guard
 * below and `describeStoredProblems()` cannot disagree about which values are usable, and so adding a
 * field is one entry rather than an edit in two places (issue #68 adds the other array-typed fields).
 *
 * A table rather than a predicate over every schema key, because `describeStoredProblems()` iterates it
 * to decide what to *read*: electron-store re-reads and re-parses the whole config file on every `get`,
 * so walking all six fields to have five of them answer `null` cost six full file reads per call, on the
 * main process, in the `finally` of every repository-list write.
 */
const STORED_SHAPE_RULES: { [K in keyof MaoStoreSchema]?: StoredShapeRule<K> } = {
  githubRepos: (raw, source) => describeUnusableRepoList(raw, source),
}

function unusableStoredValue<K extends keyof MaoStoreSchema>(
  key: K,
  raw: MaoStoreSchema[K],
  source: string,
): string | null {
  const rule = STORED_SHAPE_RULES[key] as StoredShapeRule<K> | undefined
  return rule ? rule(raw, source) : null
}

/** A stored value the schema cannot use, in the form a shell can show an operator. */
export interface StoredValueProblem {
  /** The `MaoStoreSchema` field whose stored value was replaced with the schema default. */
  field: keyof MaoStoreSchema
  /** The config file the unusable value is still sitting in. */
  source: string
  /** The operator-facing report: the field, the value's actual type, the file, and the way back. */
  message: string
}

/**
 * Which of the values a backend holds **right now** the schema cannot use.
 *
 * Evaluated on demand rather than accumulated as reads happen, and that is the whole point. The guard
 * only learns about a field when something reads it, so a recorded-as-you-go list would answer "no
 * problems" until the right read had happened — and the renderer polls this *independently* of
 * `github:getRepos`, so the order of two IPC calls would decide whether the operator was told. Asking
 * the backend directly makes the answer true whenever it is asked. It is also live for Electron, whose
 * electron-store backend re-reads the file on every `get`.
 *
 * Read-only, like the guard: nothing here repairs the file. Only the fields `STORED_SHAPE_RULES` has a
 * rule for are read at all — see there for why reading the rest would not be free.
 */
export function describeStoredProblems(
  readRaw: <K extends keyof MaoStoreSchema>(key: K) => MaoStoreSchema[K],
  source: string,
): StoredValueProblem[] {
  const problems: StoredValueProblem[] = []
  for (const field of Object.keys(STORED_SHAPE_RULES) as Array<keyof MaoStoreSchema>) {
    const message = unusableStoredValue(field, readRaw(field), source)
    if (message !== null) problems.push({ field, source, message })
  }
  return problems
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
 * Coercing to the empty list rather than throwing is what makes that recovery possible: `updateRepos`
 * reads the stored list before it writes, so a read that throws takes `repos add` / `repos remove` down
 * with it, while a read that answers `[]` lets the very next list write replace the unusable value. The
 * read is deliberately not a repair — nothing here writes — so a command that only reads leaves the
 * file exactly as it found it, and the operator keeps the chance to salvage it by hand.
 *
 * Reported at most once per field per guard, because the cadence of reads is not the cadence of the
 * problem: auto-trigger re-reads the list on every 5s tick and `mao run` runs for days. Once per
 * process is enough to be non-silent without burying the rest of the output. Written through
 * `console.warn` — i.e. stderr — so `mao repos list` and `mao config show` stay parseable on stdout.
 * `source` is the config file path, which is not itself a secret (the token lives *inside* that file);
 * no stored value is ever printed.
 *
 * Every `MaoStore` backend applies this on read — `FileStore` below, `electron/store.ts` for the GUI —
 * so the two shells cannot answer differently for the same corrupt file. A new backend must call it
 * too: that is the point of the rule living here rather than at the read sites, which are scattered
 * across `core/`, `cli/` and `electron/` and would each have to remember it.
 *
 * `githubRepos` is the only field guarded, and the other two array-typed fields are left out
 * deliberately rather than overlooked. `aiProviders` would be the same one-line coercion. `workflowTasks`
 * would not: a queue MAO cannot read is a question about unattended-pipeline safety, which this repo
 * already answers with a whole mechanism (`core/persistence-guard.ts`, the persistence-broken marker and
 * `resume`), and substituting `[]` for it without deciding how that interacts with auto-resume would be
 * the wrong half of the fix. Adding a field here means answering that question for it first.
 */
export function createStoredReadGuard(
  source: string,
  warn: (message: string) => void = (message) => console.warn(message),
): StoredReadGuard {
  const reported = new Set<keyof MaoStoreSchema>()

  return function guardStoredRead<K extends keyof MaoStoreSchema>(key: K, raw: MaoStoreSchema[K]): MaoStoreSchema[K] {
    const problem = unusableStoredValue(key, raw, source)
    if (problem === null) return raw
    if (!reported.has(key)) {
      reported.add(key)
      warn(problem)
    }
    // The schema's own default, *cloned*. Returning `MAO_STORE_DEFAULTS[key]` itself would hand every
    // caller the same shared instance, and one of them pushing into what it read would poison the
    // default for the rest of the process — the same aliasing `FileStore`'s constructor avoids below.
    return structuredClone(MAO_STORE_DEFAULTS[key])
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
  /**
   * The stored values this backend cannot use, evaluated against what it holds now (see
   * `describeStoredProblems()`).
   *
   * Part of the contract rather than a backend detail, because `get()` alone cannot tell a caller that
   * it answered with a default instead of what is on disk — it returns the same `[]` either way. Both
   * shells need to say so: `mao config show` reports it, and the GUI has no other way to learn at all,
   * since the guard's own report goes to a main-process console a packaged-app operator never sees.
   */
  problems(): StoredValueProblem[]
}

/**
 * The raw key/value surface a backend offers before anything validates it.
 *
 * `get` may answer `undefined`: electron-store merges its `defaults` into the file only when it first
 * writes it, and reads the file's *current* contents afterwards, so a key an operator deletes by hand
 * comes back missing. `createGuardedStore()` substitutes the schema default for exactly that case.
 */
export interface StoredValueBackend {
  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] | undefined
  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void
}

/**
 * The one composition of a raw backend into a `MaoStore`: absent keys filled from the schema, reads
 * guarded, and `problems()` answered from the **raw** values.
 *
 * Both shipped backends are this function — `FileStore` below over its in-memory snapshot,
 * `electron/store.ts` over electron-store — so "the two shells cannot answer differently for the same
 * corrupt file" is true by construction rather than by two files being kept in step by hand. It also
 * puts the whole of the Electron backend's behaviour somewhere a `core` test can reach it: that backend
 * cannot be imported from `core/` (architecture rule 1) and electron-store needs a live Electron app, so
 * before this the only coverage it could have was a regex over its source — which a mutation feeding
 * `problems()` the *guarded* value instead of the raw one passed while making the GUI permanently blind.
 *
 * That distinction is the subtle part and the reason `readRaw` is not the guard: the guard has already
 * replaced an unusable value with the schema default, so asking it what is wrong always answers
 * "nothing".
 */
export function createGuardedStore(
  backend: StoredValueBackend,
  source: string,
  warn?: (message: string) => void,
): MaoStore {
  const guardRead = createStoredReadGuard(source, warn)

  function readRaw<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    const value = backend.get(key)
    // Cloned, never the shared `MAO_STORE_DEFAULTS` instance — one caller pushing into what it read
    // would otherwise poison the default for the rest of the process.
    return value === undefined ? structuredClone(MAO_STORE_DEFAULTS[key]) : value
  }

  return {
    get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
      return guardRead(key, readRaw(key))
    },
    set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
      backend.set(key, value)
    },
    problems(): StoredValueProblem[] {
      return describeStoredProblems(readRaw, source)
    },
  }
}

/** JSON-file-backed MaoStore for CLI/headless environments that don't have electron-store available. */
export class FileStore implements MaoStore {
  private data: MaoStoreSchema
  private filePath: string
  /**
   * The same composition Electron's backend is (see `createGuardedStore`), over this instance's own
   * snapshot rather than reimplemented beside it. Held per instance because "already reported" is per
   * store, and the CLI builds a fresh `FileStore` for every invocation, so each command that touches an
   * unusable list says so exactly once.
   */
  private guarded: MaoStore

  constructor(filePath: string) {
    this.filePath = filePath
    // Cloned, not spread onto. A shallow spread copies each default's *reference*, so for any key the
    // file does not set, `get()` handed out the module-level `MAO_STORE_DEFAULTS` value itself — one
    // caller pushing into the list it read leaked a phantom entry into the default, and the next
    // `FileStore` built in that process then read it back as a tracked repository for auto-trigger to
    // poll. The read guard owes callers a value that is theirs; this is the other half of that.
    this.data = { ...structuredClone(MAO_STORE_DEFAULTS), ...this.load() }
    this.guarded = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => this.data[key],
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          this.data[key] = value
          this.persist()
        },
      },
      filePath,
    )
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
    return this.guarded.get(key)
  }

  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
    this.guarded.set(key, value)
  }

  problems(): StoredValueProblem[] {
    return this.guarded.problems()
  }
}
