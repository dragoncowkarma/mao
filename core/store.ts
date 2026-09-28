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
 * The recovery it names is a *removal*, not an add, and that ordering is load-bearing. Any list write
 * heals the file, but only a write that registers nothing new is exempt from the write-permission
 * preflight (see `reposNeedingCapabilityCheck`) — and because an unusable value names no tracked
 * repository, every repository in an `add` counts as new. So with no token configured, or access since
 * revoked, `mao repos add` fails in the preflight and leaves the unusable value exactly where it was,
 * while `mao repos remove` heals regardless. Recommending the blockable path first would send an
 * operator whose token is the reason they were editing `config.json` straight back into the wall.
 */
export function describeUnusableRepoList(value: unknown, source: string): string | null {
  if (Array.isArray(value)) return null
  return (
    `[store] "githubRepos" in ${source} is ${describeStoredType(value)}, not a JSON array of ` +
    '{ owner, repo } entries — ignoring it, so no repositories are tracked until it is replaced. The ' +
    'unusable value is still in the file; any repository-list write overwrites it. `mao repos remove ' +
    "<owner> <repo>` (or the sidebar's Remove) always works; `mao repos add` has to pass a write-access " +
    'check first, so it needs a working GitHub token. Copy any repositories you still need out of ' +
    `${source} first.`
  )
}

/**
 * A backend's own unvalidated read of one field — what it would have handed callers before
 * `createStoredReadGuard` corrected it. Injected rather than passed value-by-value so the guard can
 * also answer `problems()` on demand, without a caller having had to read the field first.
 */
export type RawStoredRead = <K extends keyof MaoStoreSchema>(key: K) => MaoStoreSchema[K]

/**
 * One stored value a `MaoStore` cannot use, in a form a shell can both render and answer questions
 * about — the queryable half of the report `createStoredReadGuard` also writes to stderr.
 *
 * `message` names the field, the value's **type**, and the config file, and never the value itself:
 * `githubToken` lives in plaintext in the same JSON blob, so a report that echoed what it found could
 * put a GitHub token into a CLI log, an IPC payload, and a window the operator may be screen-sharing.
 * `describeStoredType` is what keeps that true (see `describeUnusableRepoList`).
 */
export interface StoredValueProblem {
  /** The `MaoStoreSchema` field whose stored value was discarded. */
  key: keyof MaoStoreSchema
  /** The operator-facing explanation, naming the value's type and never its contents. */
  message: string
}

/** A backend's reads, corrected to the shape `MaoStoreSchema` declares. See `createStoredReadGuard`. */
export interface StoredReadGuard {
  /** The guarded read a `MaoStore.get()` delegates to. */
  read<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K]
  /**
   * Every guarded field whose value is unusable **right now**, re-derived from the backend on each
   * call rather than accumulated as reads go by.
   *
   * That is the difference between a diagnostic and a stale flag. The condition ends the moment a list
   * write replaces the value, and a GUI polling this (see `store:problems`) has to stop warning when it
   * does — an operator who has just fixed their `config.json` and still sees the warning has no way to
   * tell a working fix from a failed one. Re-deriving also means the answer does not depend on whether
   * anything happened to read the field first, which is what lets `mao config show` report it in any
   * order.
   */
  problems(): StoredValueProblem[]
}

/**
 * The one field the guard corrects. Named once because `read` and `problems` must not drift apart:
 * a `problems()` that answered for a field `read` does not coerce would report a problem nothing is
 * working around, and the reverse would discard a value in silence — which is the whole bug.
 */
const GUARDED_FIELD = 'githubRepos'

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
 * The problem is reported two ways, because one channel cannot serve both callers. `warn` fires at most
 * once per field per guard, because the cadence of reads is not the cadence of the problem: auto-trigger
 * re-reads the list on every 5s tick and `mao run` runs for days. It goes through `console.warn` — i.e.
 * stderr — so `mao repos list` and `mao config show` stay parseable on stdout. But a side effect on
 * stderr is not something a caller can ask about: it is invisible to `mao config show | jq`, discarded
 * outright by `2>/dev/null`, and in a packaged Electron app it lands in a console no operator ever opens.
 * So the same verdict is also readable through `problems()`, which every `MaoStore` exposes — that is
 * what `mao config show`'s `githubReposUnusable` and the GUI's `store:problems` channel report.
 *
 * Every `MaoStore` backend applies this on read — `FileStore` below, `electron/store.ts` for the GUI —
 * so the two shells cannot answer differently for the same corrupt file. A new backend must call it
 * too: that is the point of the rule living here rather than at the read sites, which are scattered
 * across `core/`, `cli/` and `electron/` and would each have to remember it. Taking a `RawStoredRead`
 * rather than a value per call is what makes that hard to get half-right — a backend hands over its own
 * unguarded read once, and has nothing left to forget to wrap.
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
  rawRead: RawStoredRead,
  warn: (message: string) => void = (message) => console.warn(message),
): StoredReadGuard {
  const reported = new Set<keyof MaoStoreSchema>()

  return {
    read<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
      const raw = rawRead(key)
      if (key !== GUARDED_FIELD) return raw
      const problem = describeUnusableRepoList(raw, source)
      if (problem === null) return raw
      if (!reported.has(key)) {
        reported.add(key)
        warn(problem)
      }
      // The only cast in this module, and the reason it exists: comparing `key` cannot narrow `K`, so the
      // replacement list has to be asserted back into the field's declared type. A fresh array each time,
      // never `MAO_STORE_DEFAULTS.githubRepos` — that instance is shared, and one caller pushing into it
      // would poison the defaults for the rest of the process.
      return [] as unknown as MaoStoreSchema[K]
    },

    problems(): StoredValueProblem[] {
      // Deliberately silent: a query must not warn. `read` owns the once-per-process stderr report, and
      // a `problems()` that also warned would make the GUI's 30s poll print the same paragraph forever.
      const message = describeUnusableRepoList(rawRead(GUARDED_FIELD), source)
      return message === null ? [] : [{ key: GUARDED_FIELD, message }]
    },
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
   * Every stored value this backend cannot use, as of right now — see `StoredReadGuard.problems`.
   *
   * Part of the contract rather than an extra on one backend, because the question "is what I just read
   * actually what is in the file?" is asked by both shells (`mao config show`'s `githubReposUnusable`,
   * the GUI's `store:problems` channel) and neither knows which backend it holds. Required, not
   * optional: a backend that silently answered nothing would reintroduce exactly the silence issue #60
   * is about, and tsc refusing to compile it is the only thing that catches a new backend forgetting.
   */
  problems(): StoredValueProblem[]
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
  private guard: StoredReadGuard

  constructor(filePath: string) {
    this.filePath = filePath
    // Cloned, not spread onto. A shallow spread copies each default's *reference*, so for any key the
    // file does not set, `get()` handed out the module-level `MAO_STORE_DEFAULTS` value itself — one
    // caller pushing into the list it read leaked a phantom entry into the default, and the next
    // `FileStore` built in that process then read it back as a tracked repository for auto-trigger to
    // poll. The read guard below owes callers a value that is theirs; this is the other half of that.
    this.data = { ...structuredClone(MAO_STORE_DEFAULTS), ...this.load() }
    // Handed `this.data` as its raw source, not a snapshot of one field: `problems()` re-reads on every
    // call, so a list write that heals the file has to be visible to the very next query.
    this.guard = createStoredReadGuard(filePath, (key) => this.data[key])
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
    return this.guard.read(key)
  }

  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
    this.data[key] = value
    this.persist()
  }

  problems(): StoredValueProblem[] {
    return this.guard.problems()
  }
}
