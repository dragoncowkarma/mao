import fs from 'node:fs'
import path from 'node:path'
// The one definition of "this element can name a repository", imported as a *value* rather than
// re-stated here. It has to be the same predicate that `canonicalRepoList()` drops entries with and
// that `github:getRepos` filters the sidebar's rows with, or the report below would count differently
// from what actually happens — telling an operator two entries were dropped while three vanished.
//
// The direction is safe, and pinned rather than argued: `core/repo-registry.ts`'s own `core/` imports
// are all `import type` (architecture rule 6 requires that — it is what keeps the module importable
// from the renderer), so they are erased and `repo-registry` imports nothing from here at runtime.
// `core/repo-registry.test.ts` asserts that, so the edge cannot quietly become a cycle. A third module
// holding just `isRepoRef` would buy nothing over this: one definition either way, one more hop.
import { isRepoRef } from './repo-registry.ts'
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
 *
 * A *type*, never a value, and that is a secrets rule rather than a stylistic one: `config.json` holds
 * `githubToken` in the same JSON blob, and these messages travel into piped CLI output, agent logs, an
 * IPC payload, and a window an operator may be screen-sharing.
 */
function describeStoredType(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'absent'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * What the schema could not use about a stored value. Three states rather than a boolean, because two
 * consumers read this and they need different cuts of it.
 *
 * - `'value'` — the value's own type is wrong, so none of it is usable *and* it is not safe to hand on:
 *   a non-array `githubRepos` throws on `.filter` at every read site (issue #60). `createStoredReadGuard`
 *   substitutes the schema default for this case, and only this case.
 * - `'every-entry'` — the right type, but no element is usable. Handed to callers **unchanged**, because
 *   the layers below already drop elements (`canonicalRepoList()`, `github:getRepos`) and there is
 *   nothing here for them to keep. For a *shell* this is the same verdict as `'value'`: nothing works, so
 *   replacing the whole value discards nothing.
 * - `'some-entries'` — the right type, and some elements work. Handed through, and a destructive reset
 *   must **not** be offered: it would delete the repositories the operator can see working.
 *
 * The middle state is why this is not a boolean. "Is the value usable as-is?" and "would replacing it
 * lose anything?" are different questions with different answers for `[null]`, and collapsing them is
 * what would either wipe a working entry on read or offer a reset that deletes one.
 */
export type StoredValueDefect = 'value' | 'every-entry' | 'some-entries'

/** What a `STORED_SHAPE_RULES` entry answers: how much of the stored value is unusable, and the report. */
export interface StoredShapeVerdict {
  defect: StoredValueDefect
  /** The operator-facing report: the field, the value's or entries' actual type, the file, the way back. */
  message: string
}

/**
 * The recovery out of a `githubRepos` that leaves nothing tracked — shared verbatim by the two states
 * that reach it: a value that is not a list at all, and a list no entry of which names a repository.
 *
 * The recovery it names first registers nothing, and that ordering is load-bearing. Any list write heals
 * the file, but only a write that registers nothing new is exempt from the write-permission preflight
 * (see `reposNeedingCapabilityCheck`) — and because an unusable value names no tracked repository, every
 * repository in an `add` counts as new. So with no token configured, or access since revoked, `mao repos
 * add` fails in the preflight and leaves the unusable value exactly where it was, while `mao repos
 * remove` heals regardless. Recommending the blockable path first would send an operator whose token is
 * the reason they were editing `config.json` straight back into the wall.
 *
 * It names the GUI's **Reset stored list**, not its Remove, for a reason that is easy to get wrong: a
 * list with nothing usable in it leaves the sidebar with no row, so no project is selected, so the
 * Settings tab and the Remove button inside it never render. Naming an action the operator cannot reach
 * is worse than naming none. Reset is the sidebar control this report itself is shown next to, and it
 * writes an empty list.
 *
 * Deliberately not reused for `'some-entries'`: there the sidebar has rows, Remove *is* reachable, and
 * Reset is withheld — so every sentence here would be wrong or dangerous advice.
 */
function describeRepoListRecovery(source: string): string {
  return (
    'The unusable value is still in the file; any repository-list write overwrites it. `mao repos ' +
    "remove <owner> <repo>`, or the sidebar's Reset stored list, always works — neither registers " +
    "anything, so neither is checked for write access. `mao repos add` and the sidebar's Add are, so " +
    `they need a working GitHub token. Copy any repositories you still need out of ${source} first.`
  )
}

/**
 * `<n> of its <m> entries do not name a repository`, phrased so the sentence stays grammatical at every
 * count — including the one-entry list, where "none of its 1 entry" reads like a typo.
 *
 * A count, not the entries. The count is what tells an operator whether the file lost the one row they
 * were mid-way through hand-writing or all twelve of them, and it is derivable from nothing they can
 * otherwise see: the sidebar and `github:getRepos` show only the survivors.
 */
function describeDroppedEntryCount(dropped: number, total: number): string {
  if (dropped !== total) {
    return `${dropped} of its ${total} entries ${dropped === 1 ? 'does' : 'do'} not name a repository`
  }
  if (total === 1) return 'its only entry does not name a repository'
  return `none of its ${total} entries names a repository`
}

/**
 * The actionable report for a stored `githubRepos` the schema cannot fully use — or `null` when every
 * part of it is usable.
 *
 * Covers the container *and* its entries, which is the gap PR #66 left. PR #57 made individual entries
 * safe by having `canonicalRepoList()` drop anything `isRepoRef` rejects, and `github:getRepos` filter
 * the same way — but the drop was silent, so a `config.json` holding `[null]`, a half-written
 * `[{"owner":"acme"}]`, or a bare `["acme/widgets"]` reached a dead end: the sidebar read "No projects
 * yet", identical to a genuinely empty list, and `mao repos list` printed `[]` with nothing on stderr.
 * With no token configured (or access revoked) even Add is refused by the registration preflight, so
 * there was no in-app recovery at all.
 *
 * All three messages name the field, the type of what the file actually holds, and the file itself,
 * because none of those were recoverable from what the operator used to get
 * (`store.get(...).filter is not a function`, or in the entry case: silence). None of them names a stored
 * *value* — see `describeStoredType`.
 */
export function describeRepoListProblem(value: unknown, source: string): StoredShapeVerdict | null {
  if (!Array.isArray(value)) {
    return {
      defect: 'value',
      message:
        `[store] "githubRepos" in ${source} is ${describeStoredType(value)}, not a JSON array of ` +
        '{ owner, repo } entries — ignoring it, so no repositories are tracked until it is replaced. ' +
        describeRepoListRecovery(source),
    }
  }

  const dropped = value.filter((entry) => !isRepoRef(entry))
  if (dropped.length === 0) return null
  // Deduplicated and type-only: five `null`s are one fact, and `an object` is as much as may be said
  // about a half-written `{"owner":"acme"}` without printing what is in the file beside the token.
  const types = [...new Set(dropped.map(describeStoredType))].join(', ')
  const counted = `${describeDroppedEntryCount(dropped.length, value.length)} (${types})`

  if (dropped.length === value.length) {
    return {
      defect: 'every-entry',
      message:
        `[store] "githubRepos" in ${source} is a JSON array, but ${counted} — each entry needs a ` +
        'non-empty "owner" and "repo" string, so no repositories are tracked. ' +
        describeRepoListRecovery(source),
    }
  }

  return {
    defect: 'some-entries',
    message:
      `[store] "githubRepos" in ${source} is a JSON array, but ${counted} — each entry needs a ` +
      'non-empty "owner" and "repo" string. Those entries are ignored, so they are not tracked; every ' +
      `other entry is tracked as usual. They are still in ${source}, and the next repository-list ` +
      'write — adding or removing any repository is one — drops them for good, so repair them there ' +
      'first if they were meant to name repositories.',
  }
}

type StoredShapeRule<K extends keyof MaoStoreSchema> = (
  raw: MaoStoreSchema[K],
  source: string,
) => StoredShapeVerdict | null

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
  githubRepos: (raw, source) => describeRepoListProblem(raw, source),
}

function storedShapeVerdict<K extends keyof MaoStoreSchema>(
  key: K,
  raw: MaoStoreSchema[K],
  source: string,
): StoredShapeVerdict | null {
  const rule = STORED_SHAPE_RULES[key] as StoredShapeRule<K> | undefined
  return rule ? rule(raw, source) : null
}

/** A stored value the schema cannot fully use, in the form a shell can show an operator. */
export interface StoredValueProblem {
  /** The `MaoStoreSchema` field whose stored value was replaced, in whole or in part, by the schema. */
  field: keyof MaoStoreSchema
  /** The config file the unusable value is still sitting in. */
  source: string
  /**
   * Whether *nothing* the field currently holds is usable — so replacing its stored value with the
   * schema default discards nothing that works.
   *
   * The gate a shell must hang a destructive "reset this to the default" control off, and the reason
   * this report and that recovery are separate things. A `githubRepos` of
   * `[null, { owner: 'acme', repo: 'one' }]` is worth reporting — an entry vanished, and the next list
   * write erases it from the file for good — but acme/one is on screen and working, so writing an empty
   * list to clear the notice would delete the very data the operator still has.
   *
   * On the wire as a boolean rather than left for a shell to infer from `field`, the message text, or
   * the `StoredValueDefect` union: `src/` may not value-import this module (architecture rule 6 — it
   * reads `node:fs`), so the renderer can only act on what travels as data.
   */
  nothingUsable: boolean
  /** The operator-facing report: the field, the unusable part's actual type, the file, and the way back. */
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
    const verdict = storedShapeVerdict(field, readRaw(field), source)
    // `'some-entries'` is the only defect that leaves something behind worth protecting; see
    // `StoredValueDefect`. Flattened to the boolean here rather than passed on, because the union is a
    // `core/` type the renderer cannot read and a shell needs exactly this one bit of it.
    if (verdict !== null) {
      const nothingUsable = verdict.defect !== 'some-entries'
      problems.push({ field, source, nothingUsable, message: verdict.message })
    }
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
 * It reports more than it corrects, and the asymmetry is the point. A value whose own *type* is wrong is
 * substituted; a list whose *entries* are wrong is reported and handed back untouched, because the layers
 * below (`canonicalRepoList()`, `github:getRepos`) drop the bad entries and keep the good ones, and
 * substituting `[]` here would throw away the repositories that still work. Before that split, entry-level
 * corruption was corrected silently and said nothing at all: a `config.json` holding `[null]` left the
 * sidebar reading "No projects yet" and `mao repos list` printing `[]` on stdout with a clean stderr, which
 * is the same dead end for an operator as the unguarded crash was. See `StoredValueDefect`.
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
    const verdict = storedShapeVerdict(key, raw, source)
    if (verdict === null) return raw
    if (!reported.has(key)) {
      reported.add(key)
      warn(verdict.message)
    }
    // Reported, but handed back as it is. An entry-level defect is one the layers below are built to
    // absorb — and PR #57's whole recovery is that a list write drops the junk *while keeping the good
    // rows*, which a substituted `[]` here would silently convert into "delete every tracked repository".
    if (verdict.defect !== 'value') return raw
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
