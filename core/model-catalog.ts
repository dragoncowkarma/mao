import fs from 'node:fs'
import path from 'node:path'
import { createStoreWriteLock, writeStoreFileAtomic } from './store-file.ts'
import {
  discoverModels,
  ModelDiscoveryError,
  type DiscoveryOutcome,
  type ModelDiscoveryDeps,
} from './ai/model-discovery.ts'
import {
  DISCOVERABLE_PROVIDER_KINDS,
  MODEL_CATALOG_FAILURES,
  MODEL_CATALOG_FAILURE_TEXT,
  REASONING_LADDER,
  catalogModelRows,
  isEligibleAgyStem,
  type CatalogModel,
  type DiscoverableProviderKind,
  type ModelCatalogAttempt,
  type ModelCatalogFailure,
  type ModelCatalogSource,
  type ModelCatalogView,
  type ProviderModelCatalog,
} from './ai/provider-options.ts'
import type { AiProviderConfig } from './ai/types.ts'

/**
 * The refreshed model catalog: a cache of what each AI CLI last reported, merged over the built-in tables
 * in `core/ai/provider-options.ts` wherever a model list is offered or checked.
 *
 * It lives in its own file beside `config.json`, never inside it. `config.json` holds the queue and the
 * GitHub token, and its writers are fixed (safety rail 2); a cache rewritten once a day by up to three
 * processes has no business taking that file's lock or risking its contents. Losing this file costs
 * nothing but freshness: every reader falls back to the built-in tables.
 *
 * Nothing here starts a timer on import, and `createMaoApp()` never calls `startModelCatalogRefresher()`
 * (architecture rule 5): only the long-running hosts — `electron/ipc.ts`, `mao run`, and the Swarm
 * polling cycle through `createModelCatalogMaintainer()` — refresh on their own.
 */

export const MODEL_CATALOG_FILE = 'model-catalog.json'
const MODEL_CATALOG_VERSION = 1

/** How long a fetched list stays fresh before a long-running host asks again. */
export const DEFAULT_MODEL_CATALOG_TTL_MS = 24 * 60 * 60_000
/** Operator override in hours; `0` turns automatic refresh off (manual refresh still works). */
export const MODEL_CATALOG_TTL_ENV = 'MAO_MODEL_CATALOG_TTL_HOURS'
/** A failed refresh waits this long (never longer than the TTL), so a broken CLI is not re-run every Swarm poll. */
export const MODEL_CATALOG_RETRY_MS = 60 * 60_000
/** How often a long-running host checks whether anything is due. A check is a small file read. */
export const MODEL_CATALOG_TICK_MS = 15 * 60_000
const MIN_TTL_MS = 60_000
/** A timestamp this far in the future is a wrong clock or a hand edit, and must not postpone refreshes forever. */
const CLOCK_SKEW_MS = 5 * 60_000

/**
 * Failures that say something about this host only. A GUI launched from the Dock has a minimal PATH and
 * cannot find `agy`, while `mao swarm` in a terminal can: one host's `command-not-found` must not hold
 * the other back, so only the other failures back off across processes.
 */
const HOST_SPECIFIC_FAILURES: ReadonlySet<ModelCatalogFailure> = new Set(['command-not-found', 'aborted'])

const SOURCE_KINDS: Record<ModelCatalogSource, DiscoverableProviderKind> = {
  'agy-models': 'antigravity',
  'codex-debug-models': 'codex',
  'anthropic-models-api': 'claude',
  'claude-local-settings': 'claude',
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_MODELS_PER_PROVIDER = 500

export function modelCatalogPath(dataDir: string): string {
  return path.join(dataDir, MODEL_CATALOG_FILE)
}

/**
 * The automatic refresh period: 24 hours, or `MAO_MODEL_CATALOG_TTL_HOURS`. `0` means off (`null`). A
 * value that is not a non-negative number is ignored rather than trusted, and the period never drops
 * below a minute, so a typo cannot turn every Swarm poll into three CLI runs.
 */
export function modelCatalogTtlMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env[MODEL_CATALOG_TTL_ENV]?.trim()
  if (!raw) return DEFAULT_MODEL_CATALOG_TTL_MS
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_MODEL_CATALOG_TTL_MS
  if (hours === 0) return null
  return Math.max(Math.round(hours * 60 * 60_000), MIN_TTL_MS)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isoTimestamp = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

const emptyView = (ttlMs: number | null): ModelCatalogView => ({ providers: {}, attempts: {}, ttlMs })

/**
 * The file is a cache that anyone can hand-edit, so every entry is re-validated on the way in: ids keep a
 * conservative shape, effort levels come from the ladder only, and the Antigravity list admits eligible
 * Gemini stems only (`isEligibleAgyStem`) — an edit cannot smuggle a foreign family into the agy role.
 */
function sanitizeModels(kind: DiscoverableProviderKind, value: unknown): CatalogModel[] {
  if (!Array.isArray(value)) return []
  const models: CatalogModel[] = []
  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_MODELS_PER_PROVIDER)) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    const id = entry.id.trim().toLowerCase()
    if (!SAFE_ID.test(id) || seen.has(id)) continue
    if (kind === 'antigravity' && !isEligibleAgyStem(id)) continue
    if (kind === 'claude' && !id.startsWith('claude-')) continue
    seen.add(id)
    const label = typeof entry.label === 'string' ? entry.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : ''
    const efforts = Array.isArray(entry.efforts)
      ? REASONING_LADDER.filter((level) => (entry.efforts as unknown[]).includes(level))
      : undefined
    models.push({ id, ...(label ? { label } : {}), ...(efforts ? { efforts } : {}) })
  }
  return models
}

function sanitizeCatalog(kind: DiscoverableProviderKind, value: unknown): ProviderModelCatalog | undefined {
  if (!isRecord(value) || typeof value.source !== 'string') return undefined
  const source = value.source as ModelCatalogSource
  if (!Object.hasOwn(SOURCE_KINDS, source) || SOURCE_KINDS[source] !== kind) return undefined
  const updatedAt = isoTimestamp(value.updatedAt)
  const models = sanitizeModels(kind, value.models)
  return updatedAt && models.length > 0 ? { updatedAt, source, models } : undefined
}

function sanitizeAttempt(value: unknown): ModelCatalogAttempt | undefined {
  if (!isRecord(value)) return undefined
  const at = isoTimestamp(value.at)
  const outcome = value.outcome
  if (!at || (outcome !== 'updated' && outcome !== 'static' && outcome !== 'failed')) return undefined
  const reason = typeof value.reason === 'string' && (MODEL_CATALOG_FAILURES as readonly string[]).includes(value.reason)
    ? value.reason as ModelCatalogFailure : undefined
  return { at, outcome, ...(reason ? { reason } : {}) }
}

/** Validates a parsed cache document. Unknown fields — a newer MAO's — are ignored, never trusted. */
export function sanitizeModelCatalog(value: unknown, ttlMs: number | null = modelCatalogTtlMs()): ModelCatalogView {
  const view = emptyView(ttlMs)
  if (!isRecord(value)) return view
  const providers = isRecord(value.providers) ? value.providers : {}
  const attempts = isRecord(value.attempts) ? value.attempts : {}
  for (const kind of DISCOVERABLE_PROVIDER_KINDS) {
    const catalog = Object.hasOwn(providers, kind) ? sanitizeCatalog(kind, providers[kind]) : undefined
    if (catalog) view.providers[kind] = catalog
    const attempt = Object.hasOwn(attempts, kind) ? sanitizeAttempt(attempts[kind]) : undefined
    if (attempt) view.attempts[kind] = attempt
  }
  return view
}

/**
 * The cached catalog, fresh from disk. Never throws: a missing, unreadable or malformed file reads as
 * empty, which every consumer treats as "use the built-in tables".
 */
export function readModelCatalog(dataDir: string, ttlMs: number | null = modelCatalogTtlMs()): ModelCatalogView {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(modelCatalogPath(dataDir), 'utf8'))
  } catch {
    return emptyView(ttlMs)
  }
  return sanitizeModelCatalog(parsed, ttlMs)
}

type KindOutcome = { kind: DiscoverableProviderKind } & ({ result: DiscoveryOutcome } | { failure: ModelCatalogFailure })

export interface ModelCatalogRefreshResult {
  kind: DiscoverableProviderKind
  outcome: ModelCatalogAttempt['outcome']
  reason?: ModelCatalogFailure
  /** How many models the source listed (0 unless `updated`). */
  models: number
}

export interface ModelCatalogRefreshReport {
  results: ModelCatalogRefreshResult[]
  /** The catalog after this refresh, as this process will use it. */
  catalog: ModelCatalogView
  /**
   * False when the cache file could not be written: this process still uses the result, others do not see
   * it. A maintainer (`createModelCatalogMaintainer`) keeps that promise past this report, in `read()`.
   */
  persisted: boolean
}

interface AppliedOutcomes {
  catalog: ModelCatalogView
  /** What the fold actually did per provider, which is what a report must say. */
  results: ModelCatalogRefreshResult[]
}

/**
 * Folds one refresh into the cached state, and says what it did.
 *
 * - A fetched list replaces the provider's entry — except that Claude Code's local settings (a model or
 *   two) never replace an Anthropic API listing (all of them): the host without a key leaves that list
 *   for the host with one to refresh, and reports `static`/`kept-api-list` rather than a refresh.
 * - `static` (no source here) and failures leave the entry alone. Stale is better than empty, and the
 *   built-in tables cover what the cache does not. A `static` attempt is not even recorded over a cached
 *   list — "this host has no source" says nothing about a list another host fetched — and is reported as
 *   `kept-cached-list`.
 * - A record stamped after this refresh began belongs to another process that finished later; it stands.
 *   One stamped beyond `CLOCK_SKEW_MS` ahead is a wrong clock or a hand edit and stands for nothing, or a
 *   single bad timestamp would freeze the provider's list until the wall clock caught up.
 * - An interrupted refresh records nothing.
 */
function applyOutcomes(current: ModelCatalogView, outcomes: readonly KindOutcome[], at: string): AppliedOutcomes {
  const next: ModelCatalogView = { providers: { ...current.providers }, attempts: { ...current.attempts }, ttlMs: current.ttlMs }
  const time = Date.parse(at)
  const isLater = (timestamp: string | undefined) => {
    const stamped = Date.parse(timestamp ?? '')
    return Number.isFinite(stamped) && stamped > time && stamped <= time + CLOCK_SKEW_MS
  }
  const record = (kind: DiscoverableProviderKind, attempt: ModelCatalogAttempt) => {
    if (!isLater(next.attempts[kind]?.at)) next.attempts[kind] = attempt
  }
  const results = outcomes.map((outcome): ModelCatalogRefreshResult => {
    const { kind } = outcome
    if ('failure' in outcome) {
      if (outcome.failure !== 'aborted') record(kind, { at, outcome: 'failed', reason: outcome.failure })
      return { kind, outcome: 'failed', reason: outcome.failure, models: 0 }
    }
    if (outcome.result.kind === 'static') {
      // A list another host fetched is what stays in use, not the built-in one: say that, record nothing.
      if (next.providers[kind]) return { kind, outcome: 'static', reason: 'kept-cached-list', models: 0 }
      record(kind, { at, outcome: 'static', reason: outcome.result.reason })
      return { kind, outcome: 'static', reason: outcome.result.reason, models: 0 }
    }
    const existing = next.providers[kind]
    if (existing?.source === 'anthropic-models-api' && outcome.result.source === 'claude-local-settings') {
      return { kind, outcome: 'static', reason: 'kept-api-list', models: 0 }
    }
    // A list another process stored after this refresh began is at least as fresh: it stays, and the
    // report counts what is actually in use.
    const fresher = existing && isLater(existing.updatedAt) ? existing : undefined
    if (!fresher) next.providers[kind] = { updatedAt: at, source: outcome.result.source, models: outcome.result.models }
    record(kind, { at, outcome: 'updated' })
    return { kind, outcome: 'updated', models: (fresher ?? outcome.result).models.length }
  })
  return { catalog: next, results }
}

/** Lists and attempts a process fetched but could not save, per provider (`createModelCatalogMaintainer`). */
type UnsavedCatalog = Pick<ModelCatalogView, 'providers' | 'attempts'>

const NO_UNSAVED: UnsavedCatalog = { providers: {}, attempts: {} }

/**
 * Whether list `a` stands over list `b` whatever their ages: an Anthropic API listing (the whole catalog)
 * over Claude Code's local settings (a model or two), the rule `applyOutcomes` applies to a refresh.
 */
const outranks = (a: ProviderModelCatalog | undefined, b: ProviderModelCatalog | undefined) =>
  a?.source === 'anthropic-models-api' && b?.source === 'claude-local-settings'

/**
 * Which of an unsaved entry and the file's entry for the same provider is current. `unsaved`: it is newer, or
 * the file has nothing that counts — another host's refresh, or this process's own once the file is writable
 * again, is what makes the file current. `file`: the file holds an entry that counts and is at least as new.
 * `neither`: no stamp on either side counts, as when the clock has stepped back past this process's own stamp;
 * the entry is not used then, but nothing superseded it either.
 *
 * Stamps beyond `CLOCK_SKEW_MS` ahead count for nothing, on both sides. As in `applyOutcomes`, an Anthropic API
 * listing and Claude Code's local settings never trade places by age, in either direction: an unsaved listing
 * stands over settings another host saved later, exactly as a saved listing would have stood over that host's
 * refresh. One rule for `withUnsaved` (what is used) and `pruneSuperseded` (what is forgotten), so they cannot
 * disagree: an entry is used only when `unsaved`, and forgotten only when `file`.
 */
type Current = 'unsaved' | 'file' | 'neither'

function currentEntries(view: ModelCatalogView, unsaved: UnsavedCatalog, kind: DiscoverableProviderKind, time: number) {
  const stamp = (timestamp: string | undefined) => {
    const at = Date.parse(timestamp ?? '')
    return Number.isFinite(at) && at <= time + CLOCK_SKEW_MS ? at : -Infinity
  }
  const byAge = (mine: string, theirs: string | undefined): Current => {
    if (stamp(mine) > stamp(theirs)) return 'unsaved'
    return stamp(theirs) !== -Infinity && stamp(theirs) >= stamp(mine) ? 'file' : 'neither'
  }
  const list = unsaved.providers[kind]
  const saved = view.providers[kind]
  const attempt = unsaved.attempts[kind]
  return {
    list: list === undefined ? undefined
      : outranks(list, saved) ? 'unsaved' : outranks(saved, list) ? 'file' : byAge(list.updatedAt, saved?.updatedAt),
    attempt: attempt === undefined ? undefined : byAge(attempt.at, view.attempts[kind]?.at),
  }
}

/** `view` with each unsaved entry that is current (`currentEntries`) laid over the file's. */
function withUnsaved(view: ModelCatalogView, unsaved: UnsavedCatalog, time: number): ModelCatalogView {
  const merged: ModelCatalogView = { providers: { ...view.providers }, attempts: { ...view.attempts }, ttlMs: view.ttlMs }
  for (const kind of DISCOVERABLE_PROVIDER_KINDS) {
    const current = currentEntries(view, unsaved, kind, time)
    if (current.list === 'unsaved') merged.providers[kind] = unsaved.providers[kind]
    if (current.attempt === 'unsaved') merged.attempts[kind] = unsaved.attempts[kind]
  }
  return merged
}

/**
 * Forgets each unsaved entry the file has superseded: one the file's own entry beats (`currentEntries` says
 * `file`). Kept, it would come back the moment that entry went away — a deleted or damaged cache file — and the
 * next write would save the stale list over everyone's. Never an entry the file has nothing against: a clock
 * stepping back hides it for a while, and it returns when the clock catches up. Mutates `unsaved`; a maintainer
 * calls it whenever it reads the file.
 */
function pruneSuperseded(unsaved: UnsavedCatalog, view: ModelCatalogView, time: number): void {
  for (const kind of DISCOVERABLE_PROVIDER_KINDS) {
    const current = currentEntries(view, unsaved, kind, time)
    if (current.list === 'file') delete unsaved.providers[kind]
    if (current.attempt === 'file') delete unsaved.attempts[kind]
  }
}

/**
 * Read, fold and replace under the cache's own cross-process lock (the store's lock mechanism,
 * `createStoreWriteLock`, on `model-catalog.json` — never `config.json`'s), so two hosts refreshing
 * different providers at once both land. The lock is synchronous and held only for this read-merge-write,
 * never across the discovery awaits. The replace is atomic (`writeStoreFileAtomic`): a reader sees the old
 * file or the new one. The caller's unsaved lists are folded in first, so this write saves them too.
 */
function persistOutcomes(
  dataDir: string, outcomes: readonly KindOutcome[], at: string, ttlMs: number | null, unsaved: UnsavedCatalog,
): AppliedOutcomes {
  const file = modelCatalogPath(dataDir)
  fs.mkdirSync(dataDir, { recursive: true })
  return createStoreWriteLock(file)(() => {
    const applied = applyOutcomes(withUnsaved(readModelCatalog(dataDir, ttlMs), unsaved, Date.parse(at)), outcomes, at)
    const document = { version: MODEL_CATALOG_VERSION, providers: applied.catalog.providers, attempts: applied.catalog.attempts }
    writeStoreFileAtomic(file, `${JSON.stringify(document, null, 2)}\n`)
    return applied
  })
}

const toResult = (outcome: KindOutcome): ModelCatalogRefreshResult => {
  if ('failure' in outcome) return { kind: outcome.kind, outcome: 'failed', reason: outcome.failure, models: 0 }
  if (outcome.result.kind === 'static') return { kind: outcome.kind, outcome: 'static', reason: outcome.result.reason, models: 0 }
  return { kind: outcome.kind, outcome: 'updated', models: outcome.result.models.length }
}

export interface RefreshModelCatalogOptions {
  dataDir: string
  /** Providers to refresh; all three when omitted. */
  kinds?: readonly DiscoverableProviderKind[]
  /** Saved provider configs: the source of an Anthropic API key and of absolute CLI paths. */
  providers?: readonly AiProviderConfig[]
  deps?: ModelDiscoveryDeps
  signal?: AbortSignal
  now?: () => number
  ttlMs?: number | null
  /**
   * Lists and attempts the calling process holds but could not save (a maintainer's). The refresh folds its
   * answers over the file with these laid on top, so `kept-cached-list` and `kept-api-list` are judged
   * against what the process actually uses, and a successful write saves them along with it.
   */
  unsaved?: Pick<ModelCatalogView, 'providers' | 'attempts'>
}

/**
 * Asks every requested provider at once (each call bounded by `MODEL_DISCOVERY_TIMEOUT_MS`), then folds the
 * answers into the cache. Never rejects: discovery failures become `failed` results and a cache that
 * cannot be written becomes `persisted: false`. Hosts depend on that — a refresh must never stop the app,
 * the queue or Swarm dispatch.
 */
export async function refreshModelCatalog(options: RefreshModelCatalogOptions): Promise<ModelCatalogRefreshReport> {
  const kinds = DISCOVERABLE_PROVIDER_KINDS.filter((kind) => !options.kinds || options.kinds.includes(kind))
  const ttlMs = options.ttlMs === undefined ? modelCatalogTtlMs() : options.ttlMs
  const outcomes: KindOutcome[] = await Promise.all(kinds.map(async (kind): Promise<KindOutcome> => {
    try {
      return { kind, result: await discoverModels(kind, options.providers ?? [], options.deps ?? {}, options.signal) }
    } catch (error) {
      return { kind, failure: error instanceof ModelDiscoveryError ? error.reason : 'unexpected-error' }
    }
  }))
  const time = (options.now ?? Date.now)()
  const at = new Date(time).toISOString()
  const unsaved = options.unsaved ?? NO_UNSAVED
  const current = () => withUnsaved(readModelCatalog(options.dataDir, ttlMs), unsaved, time)
  if (outcomes.every((outcome) => 'failure' in outcome && outcome.failure === 'aborted')) {
    return { results: outcomes.map(toResult), catalog: current(), persisted: true }
  }
  try {
    return { ...persistOutcomes(options.dataDir, outcomes, at, ttlMs, unsaved), persisted: true }
  } catch {
    return { ...applyOutcomes(current(), outcomes, at), persisted: false }
  }
}

export interface ModelCatalogMaintainerOptions {
  dataDir: string
  /** Read at each refresh, so a key or CLI path saved after start is used. A throw reads as no providers. */
  listProviders?: () => readonly AiProviderConfig[]
  /** Defaults to `modelCatalogTtlMs()`; `null` disables `refreshDue()` (manual refresh still works). */
  ttlMs?: number | null
  retryMs?: number
  deps?: ModelDiscoveryDeps
  now?: () => number
}

export interface ModelCatalogMaintainer {
  /**
   * The cached catalog as it is on disk now — another host's refresh included — plus any list this
   * process fetched but could not save, until a write saves it or the file holds one that supersedes it.
   */
  read(): ModelCatalogView
  /** The providers a refresh would ask now. See `createModelCatalogMaintainer()` for the rule. */
  dueKinds(): DiscoverableProviderKind[]
  /** Refreshes what is due; resolves `undefined` when nothing is. Never rejects. */
  refreshDue(signal?: AbortSignal): Promise<ModelCatalogRefreshReport | undefined>
  /** Refreshes now regardless of age — the manual path (`mao providers refresh-models`, the GUI button). Never rejects. */
  refreshNow(kinds?: readonly DiscoverableProviderKind[], signal?: AbortSignal): Promise<ModelCatalogRefreshReport>
}

/**
 * One process's view of the catalog and its refresh schedule.
 *
 * A provider is due when its cached list is missing or older than the TTL — whoever wrote it — and this
 * process has not itself tried it within the TTL (or within the retry window, after a failure). A failure
 * another process recorded within the retry window also counts, unless it is host-specific (a CLI one
 * host cannot find, say). Refreshes run one at a time per process; a second request waits its turn.
 *
 * A refresh the cache file refused (`persisted: false`) is still this process's catalog: `read()`, and so
 * Swarm dispatch, `ai:getModelCatalog` and the due check, keep using it rather than the older file — which
 * would otherwise undo the refresh at the next read while its report said the result was in use. Later
 * refreshes fold over it as they would over a saved list (a failure or a missing source leaves it in place),
 * and the next one that writes the file saves it too; only then is it dropped from memory. It is dropped
 * earlier for a provider whose file entry supersedes it (`pruneSuperseded`, at every read): kept, it would
 * resurface when that entry disappeared, and be written back over everyone's.
 */
export function createModelCatalogMaintainer(options: ModelCatalogMaintainerOptions): ModelCatalogMaintainer {
  const ttlMs = options.ttlMs === undefined ? modelCatalogTtlMs() : options.ttlMs
  const retryMs = options.retryMs ?? MODEL_CATALOG_RETRY_MS
  const now = options.now ?? Date.now
  const notBefore = new Map<DiscoverableProviderKind, number>()
  const unsaved: UnsavedCatalog = { providers: {}, attempts: {} }
  let queue: Promise<unknown> = Promise.resolve()
  let pendingDue: Promise<ModelCatalogRefreshReport | undefined> | undefined

  const providers = (): readonly AiProviderConfig[] => {
    try {
      const list = options.listProviders?.()
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  /** The file with this process's unsaved lists on top, after forgetting those the file has superseded. */
  const read = () => {
    const time = now()
    const view = readModelCatalog(options.dataDir, ttlMs)
    pruneSuperseded(unsaved, view, time)
    return withUnsaved(view, unsaved, time)
  }

  const recent = (timestamp: string | undefined, windowMs: number, time: number) => {
    const at = Date.parse(timestamp ?? '')
    return Number.isFinite(at) && at <= time + CLOCK_SKEW_MS && time - at < windowMs
  }

  const dueKinds = (): DiscoverableProviderKind[] => {
    if (ttlMs === null) return []
    const view = read()
    const time = now()
    return DISCOVERABLE_PROVIDER_KINDS.filter((kind) => {
      if (time < (notBefore.get(kind) ?? 0)) return false
      if (recent(view.providers[kind]?.updatedAt, ttlMs, time)) return false
      const attempt = view.attempts[kind]
      if (attempt?.outcome === 'failed' && attempt.reason && !HOST_SPECIFIC_FAILURES.has(attempt.reason)
        && recent(attempt.at, Math.min(retryMs, ttlMs), time)) return false
      return true
    })
  }

  const run = (kinds: readonly DiscoverableProviderKind[], signal?: AbortSignal): Promise<ModelCatalogRefreshReport> => {
    const task = queue.then(() => refreshModelCatalog({
      dataDir: options.dataDir, kinds, providers: providers(), deps: options.deps, signal, now, ttlMs, unsaved,
    }))
    queue = task.catch(() => {})
    return task.then((report) => {
      const time = now()
      const attempted = report.results.filter((result) => result.reason !== 'aborted')
      for (const result of attempted) {
        const wait = result.outcome === 'failed' ? Math.min(retryMs, ttlMs ?? retryMs) : (ttlMs ?? retryMs)
        notBefore.set(result.kind, time + wait)
      }
      // An interrupted refresh wrote nothing and changes nothing here.
      if (attempted.length > 0 && report.persisted) {
        // That write folded every unsaved list in, so the file holds each one now, or something newer. From
        // here the file is the truth; nothing old may resurface from memory if it is later deleted or damaged.
        for (const kind of DISCOVERABLE_PROVIDER_KINDS) {
          delete unsaved.providers[kind]
          delete unsaved.attempts[kind]
        }
      } else if (attempted.length > 0) {
        // Still unwritable: the report's catalog (file, earlier unsaved lists, this refresh) is in use now.
        for (const result of attempted) {
          const list = report.catalog.providers[result.kind]
          if (result.outcome === 'updated' && list) unsaved.providers[result.kind] = list
          const attempt = report.catalog.attempts[result.kind]
          if (attempt) unsaved.attempts[result.kind] = attempt
        }
      }
      // Whatever the path, the report shows what `read()` returns now. That read also forgets any unsaved list
      // the file superseded while this refresh ran — a refresh sees the file too, not only an explicit read.
      return { ...report, catalog: read() }
    })
  }

  return {
    read,
    dueKinds,
    refreshDue(signal) {
      if (pendingDue) return pendingDue
      const kinds = dueKinds()
      if (kinds.length === 0) return Promise.resolve(undefined)
      pendingDue = run(kinds, signal).finally(() => { pendingDue = undefined })
      return pendingDue
    },
    refreshNow(kinds, signal) {
      // Arrives over IPC too, so it is checked rather than trusted: an unknown name selects nothing.
      if (!Array.isArray(kinds) || kinds.length === 0) return run(DISCOVERABLE_PROVIDER_KINDS, signal)
      return run(DISCOVERABLE_PROVIDER_KINDS.filter((kind) => kinds.includes(kind)), signal)
    },
  }
}

export interface ModelCatalogRefresher extends ModelCatalogMaintainer {
  /** The scheduler's interval, unref'd: it never keeps a process alive by itself. */
  readonly handle: ReturnType<typeof setInterval>
  /** Clears the interval and interrupts a refresh in flight. */
  stop(): void
}

/**
 * The long-running hosts' scheduler: checks at start and every `tickMs`, refreshing whatever is due in the
 * background. Only `electron/ipc.ts` and `mao run` call this (architecture rule 5); the Swarm engine drives
 * a maintainer from its own polling cycle instead, so it needs no second timer.
 */
export function startModelCatalogRefresher(
  options: ModelCatalogMaintainerOptions & { tickMs?: number; log?: (message: string) => void },
): ModelCatalogRefresher {
  const maintainer = createModelCatalogMaintainer(options)
  const controller = new AbortController()
  let stopped = false
  const tick = () => {
    if (stopped) return
    void maintainer.refreshDue(controller.signal).then((report) => {
      if (report && options.log && !stopped) for (const line of describeModelCatalogRefresh(report)) options.log(line)
    }, () => { /* refreshDue never rejects; this keeps a future change from becoming an unhandled rejection. */ })
  }
  const handle = setInterval(tick, options.tickMs ?? MODEL_CATALOG_TICK_MS)
  handle.unref?.()
  tick()
  return {
    ...maintainer,
    handle,
    stop() {
      stopped = true
      clearInterval(handle)
      controller.abort()
    },
  }
}

const KIND_LABELS: Record<DiscoverableProviderKind, string> = {
  antigravity: 'Antigravity (agy)',
  claude: 'Claude',
  codex: 'Codex',
}

const SOURCE_LABELS: Record<ModelCatalogSource, string> = {
  'agy-models': '`agy models`',
  'codex-debug-models': '`codex debug models`',
  'anthropic-models-api': 'the Anthropic Models API',
  'claude-local-settings': "Claude Code's model settings",
}

/**
 * `mao providers models`: each provider's source and freshness, then the models a picker or Swarm accepts
 * with their levels — the rows Global settings lists too (`catalogModelRows`).
 */
export function describeModelCatalog(view: ModelCatalogView): string[] {
  const lines: string[] = []
  for (const kind of DISCOVERABLE_PROVIDER_KINDS) {
    const catalog = view.providers[kind]
    lines.push(catalog
      ? `${KIND_LABELS[kind]}: ${catalog.models.length} model(s) from ${SOURCE_LABELS[catalog.source]}, refreshed ${catalog.updatedAt}`
      : `${KIND_LABELS[kind]}: built-in list`)
    const attempt = view.attempts[kind]
    if (attempt && attempt.outcome !== 'updated') {
      const reason = MODEL_CATALOG_FAILURE_TEXT[attempt.reason ?? 'unexpected-error']
      lines.push(attempt.outcome === 'failed' ? `  last refresh (${attempt.at}) failed: ${reason}` : `  ${reason}`)
    }
    for (const row of catalogModelRows(kind, view)) {
      lines.push(`  ${row.id} (${row.efforts.length > 0 ? row.efforts.join(', ') : 'no effort flag'})`)
    }
  }
  lines.push(view.ttlMs === null
    ? `Automatic refresh is off (${MODEL_CATALOG_TTL_ENV}=0); run \`mao providers refresh-models\`.`
    : `Long-running hosts refresh every ${Math.round((view.ttlMs / 3_600_000) * 100) / 100} h (${MODEL_CATALOG_TTL_ENV}).`)
  return lines
}

/** One line per provider for a finished refresh, plus a line when the cache could not be saved. */
export function describeModelCatalogRefresh(report: ModelCatalogRefreshReport): string[] {
  const lines = report.results.map((result) => {
    const label = KIND_LABELS[result.kind]
    if (result.outcome === 'updated') {
      const source = report.catalog.providers[result.kind]?.source
      return `${label}: refreshed, ${result.models} model(s)${source ? ` from ${SOURCE_LABELS[source]}` : ''}`
    }
    const reason = MODEL_CATALOG_FAILURE_TEXT[result.reason ?? 'unexpected-error']
    return result.outcome === 'static'
      ? `${label}: ${reason}`
      : `${label}: refresh failed — ${reason}; the cached or built-in list stays in use`
  })
  if (!report.persisted) {
    lines.push(`The refreshed lists could not be saved to ${MODEL_CATALOG_FILE}; only this process uses them.`)
  }
  return lines
}
