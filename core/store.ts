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
    if (key !== 'githubRepos') return raw
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

/**
 * Why a `config.json` that is *present* could not be turned into a settings object.
 *
 * A missing file is deliberately not one of these. That is a fresh install — the one case where starting
 * from `MAO_STORE_DEFAULTS` is exactly right, and where saying anything at all would be noise on every
 * first run.
 */
export type StoreReadFailure = 'unreadable' | 'unparseable' | 'not-an-object'

/**
 * Sorts a failed load into a `StoreReadFailure`, or `null` for the fresh-install case that is not a
 * failure at all.
 *
 * `ENOENT` is the only errno treated as "nothing is wrong". Everything else the filesystem can raise —
 * `EACCES` on a file whose mode or owner changed, `EISDIR`, `EIO` on a failing disk — describes a file
 * that exists and cannot be read, which is the opposite of a fresh install and must never be answered
 * with defaults. Split out from `FileStore.load()` so that one distinction, which is the whole of this
 * module's boot behaviour, is testable without a filesystem.
 */
export function classifyStoreReadFailure(error: unknown): StoreReadFailure | null {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
  return error instanceof SyntaxError ? 'unparseable' : 'unreadable'
}

/**
 * The operator-facing report for a `config.json` that exists but cannot be loaded.
 *
 * ## Why this refuses to boot rather than warning and carrying on
 *
 * `FileStore.load()` used to answer every read failure with `{}`, which spreads over `MAO_STORE_DEFAULTS`
 * into a complete, entirely empty settings object. Nothing was printed, so the first symptom was the app
 * behaving like a fresh install. The damage came one step later: `persist()` serializes the *whole* schema
 * on every `set()`, so the next write of any kind — `mao config set-theme`, a queue `'change'` event, a
 * repository-list update — replaced the file with those defaults. A truncated write, a hand-edit with a
 * trailing comma, or a disk error therefore destroyed `githubToken`, `aiProviders`, `githubRepos` and
 * `workflowTasks` in one go, silently, triggered by an ordinary unrelated command. The token is stored in
 * plain text and exists nowhere else, so that is credential loss, not a settings reset.
 *
 * Warning and carrying on does not fix it. The warning scrolls past and the destroying write still
 * happens — under `mao run`, within seconds of boot. Refusing to construct the store is what actually
 * preserves the file, because the process never reaches a `set()`.
 *
 * ## Why the file is left exactly where it is, rather than renamed aside
 *
 * Not writing preserves the file more completely than moving it would, and moving has a cost this repo
 * takes seriously: `config.json` is secret-bearing (AGENTS.md's safety rails), so an automatic
 * `fs.renameSync` to a salvage name would plant the token at a second path the operator never chose and
 * would not think to clean up. Copying it aside would be worse — two files holding one credential — which
 * is why that option is closed rather than merely unused. An operator moving the file by hand is the same
 * act with informed consent, and the message below asks for exactly that.
 *
 * ## How this relates to `resume` and the persistence-broken marker
 *
 * An unreadable store is an unreadable *queue* — `workflowTasks` lives in this file too. Booting on
 * defaults would silently drop tasks mid-pipeline (a PR already opened and awaiting review, simply gone)
 * and then persist that drop. That is the same "MAO cannot trust its queue" hazard
 * `core/persistence-guard.ts` exists for, reached from the read side instead of the write side.
 *
 * It is answered here by never constructing the store, which is strictly stronger than what the marker
 * buys: `createMaoApp()` is never called, so `restore()` never runs and `resume` — true or false — has
 * nothing to act on, and no GitHub or AI call can follow. The marker is deliberately *not* written for
 * this. It records a confirmed *write* failure, it is sticky, and clearing it is a separate operator
 * ritual (`mao config clear-persistence-broken`); a read failure is cured by repairing the file, after
 * which the queue inside it is precisely what was last persisted and is trustworthy again. A marker left
 * behind would be a second, unrelated chore imposed on someone who has already fixed the problem.
 *
 * ## The other backend
 *
 * Electron's `electron-store` (conf) already fails this way and needs no change: `clearInvalidConfig`
 * defaults to `false`, so conf's `store` getter rethrows a `SyntaxError` and every non-`ENOENT` errno, and
 * that getter is read from conf's own constructor — `new Store(...)` throws and nothing is written.
 * Setting `clearInvalidConfig: true` would reintroduce this bug in a worse form: conf would read `{}`,
 * merge the defaults, find them unequal and write them back *from the constructor*, destroying the file at
 * boot without waiting for a `set()`. `core/store.test.ts` pins that option off for that reason.
 *
 * `source` is the config file path, which is not itself secret (the token lives inside the file). No
 * stored value is ever included — see `UnreadableStoreError` for the leak that rules out.
 */
export function describeUnreadableStore(source: string, failure: StoreReadFailure): string {
  const cause =
    failure === 'unparseable'
      ? 'it is not valid JSON'
      : failure === 'not-an-object'
        ? 'it is valid JSON, but not a JSON object'
        : 'the filesystem refused to open it — most often a permissions or ownership change'
  const remedy =
    failure === 'unreadable'
      ? 'Restore read access to it, or move it aside to start from an empty config'
      : 'Repair the JSON by hand, or move the file aside to start from an empty config'
  return (
    `[store] ${source} could not be read — ${cause}. MAO is refusing to start rather than boot on empty ` +
    'settings, because the next change to any setting rewrites this whole file: the stored GitHub token, ' +
    'AI providers, tracked repositories and workflow queue would all be replaced by defaults, with nothing ' +
    `left to recover them from. Nothing has been written — the file is exactly as it was. ${remedy}. Its ` +
    'contents are deliberately not shown here, because the GitHub token is stored in it in plain text.'
  )
}

/**
 * Thrown by `FileStore`'s constructor for a `config.json` that exists and cannot be loaded. Carries the
 * classification so a caller can branch on it, and a message that is already the whole operator-facing
 * report — the CLI's top-level handler prints `err.message` to stderr and nothing else, which is the same
 * path-and-kind, never-the-contents shape `createStoredReadGuard` reports in.
 *
 * Deliberately does **not** set `cause`. V8 puts a prefix of the offending input into
 * `SyntaxError.message` — `JSON.parse('ghp_…')` reports ``Unexpected token 'g', "ghp_…" is not valid
 * JSON`` — and a `config.json` clobbered down to a bare token is exactly the hand-edit that produces it.
 * Node prints the `[cause]` chain for an uncaught throw and any handler may log it, so attaching the
 * original error would reintroduce the very token leak the rest of this module avoids. The classification
 * is everything a caller can act on; the text that would leak is nothing a caller needs.
 */
export class UnreadableStoreError extends Error {
  readonly source: string
  readonly failure: StoreReadFailure

  constructor(source: string, failure: StoreReadFailure) {
    super(describeUnreadableStore(source, failure))
    this.name = 'UnreadableStoreError'
    this.source = source
    this.failure = failure
  }
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

  /**
   * Reads the settings file, or `{}` when there is none. Every other outcome throws — see
   * `describeUnreadableStore` for why a present-but-unloadable file stops the process instead of becoming
   * `{}`. The throw happens in the constructor, before `persist()` can ever overwrite what is on disk.
   */
  private load(): Partial<MaoStoreSchema> {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    } catch (error) {
      const failure = classifyStoreReadFailure(error)
      if (failure === null) return {}
      throw new UnreadableStoreError(this.filePath, failure)
    }
    // A top-level `null`, array, string or number parses cleanly and then spreads to nothing (or, for a
    // string, to numeric index keys), so it would reach `set()` as a full defaults object and destroy the
    // file exactly as an unparseable one did. Same failure, same answer.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UnreadableStoreError(this.filePath, 'not-an-object')
    }
    return parsed as Partial<MaoStoreSchema>
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
