import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  AGY_EFFORT_SUFFIX,
  REASONING_LADDER,
  isEligibleAgyStem,
  type CatalogModel,
  type DiscoverableProviderKind,
  type ModelCatalogFailure,
  type ModelCatalogSource,
  type ReasoningLevel,
} from './provider-options.ts'
import type { AiProviderConfig } from './types.ts'
import { anthropicMessagesUrl } from './api-provider.ts'

/**
 * Asks each AI CLI (or the Anthropic API) which models it serves right now. Read-only and billing-free:
 * `agy models` and `codex debug models` only list, and `GET /v1/models` runs no inference.
 *
 * Every call is bounded (domain invariant 3), shell-free (safety rail 10) and fails as a typed
 * `ModelDiscoveryError` carrying a fixed category — never the command's output, a URL or a response
 * body, which can quote a credential. Callers in `core/model-catalog.ts` keep the previous list on any
 * failure, so an outage costs freshness, never a working catalog.
 */

/**
 * Per provider: one CLI run, or the whole Claude listing — every page with every saved key, one deadline
 * between them. A hung CLI or socket must not stall a refresh, let alone the Swarm cycle that awaits one.
 */
export const MODEL_DISCOVERY_TIMEOUT_MS = 60_000

/**
 * `codex debug models` printed 837,067 bytes for twelve models (codex-cli 0.169.0, 2026-11-22): each
 * entry carries ~27 KB of base instructions. Node's `execFile` default of 1 MiB is one or two models from
 * truncating it — which kills the child and reads as a failure — so allow sixteen times that.
 */
export const MODEL_DISCOVERY_MAX_BUFFER = 16 * 1024 * 1024

/** Pages of `GET /v1/models` at 1,000 models each: a server that always answers `has_more` cannot loop us. */
export const ANTHROPIC_MODEL_PAGES = 10

/** The `anthropic-version` `core/ai/api-provider.ts` sends; the Models API answers identically on newer ones. */
const ANTHROPIC_VERSION = '2023-06-01'

export class ModelDiscoveryError extends Error {
  override readonly name = 'ModelDiscoveryError'

  constructor(readonly reason: ModelCatalogFailure) {
    super(`Model discovery failed: ${reason}`)
  }
}

/** A fetched list, or "no source here: use the built-in list" — the latter is not a failure. */
export type DiscoveryOutcome =
  | { kind: 'catalog'; source: ModelCatalogSource; models: CatalogModel[] }
  | { kind: 'static'; reason: ModelCatalogFailure }

/** Resolves with a listing command's stdout or rejects with a `ModelDiscoveryError`. */
export type DiscoveryCommandRunner = (command: string, args: string[], signal?: AbortSignal) => Promise<string>

function classifyCommandError(error: { code?: unknown; killed?: boolean }): ModelCatalogFailure {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output-too-large'
  if (error.code === 'ENOENT') return 'command-not-found'
  if (error.killed) return 'command-timeout'
  return 'command-failed'
}

/**
 * Runs a listing command as argv, without a shell, with stdin closed (so a CLI that would read a prompt
 * sees EOF instead of waiting), a hard deadline and an explicit output cap. The watchdog settles on its own,
 * as `createCommandRunner()` in `core/swarm/platform.ts` does: a child that never closes cannot hold the
 * promise open. A raw `Promise` around a child process keeps a `settled` guard and clears its timer.
 */
export function createDiscoveryCommandRunner(
  execute: typeof execFile = execFile,
  timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
  maxBuffer = MODEL_DISCOVERY_MAX_BUFFER,
): DiscoveryCommandRunner {
  return (command, args, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelDiscoveryError('aborted'))
      return
    }
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<typeof execFile> | undefined
    const kill = () => {
      try { child?.kill('SIGKILL') } catch { /* The rejection below does not depend on the OS. */ }
    }
    const onAbort = () => settle(() => {
      kill()
      reject(new ModelDiscoveryError('aborted'))
    })
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      action()
    }
    try {
      child = execute(command, args, {
        encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, windowsHide: true, shell: false,
      }, (error, stdout) => settle(() => {
        if (error) reject(new ModelDiscoveryError(classifyCommandError(error)))
        else resolve(String(stdout))
      }))
    } catch {
      settle(() => reject(new ModelDiscoveryError('command-not-found')))
      return
    }
    child.stdin?.on('error', () => { /* A CLI that exits before reading stdin is not a discovery failure. */ })
    child.stdin?.end()
    if (settled) return
    timer = setTimeout(() => settle(() => {
      kill()
      reject(new ModelDiscoveryError('command-timeout'))
    }), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const CANONICAL_COMMANDS = { antigravity: 'agy', codex: 'codex' } as const

/**
 * The binary to ask. A saved CLI provider of the same kind lends its command only when that is an absolute
 * path to the real CLI (basename `agy`/`codex`): a GUI launched from the Dock has a minimal PATH, and the
 * operator's configured path is how it finds the tool. A wrapper with another name, or a relative path,
 * might not take `models` at all, so it is never handed one; the bare name on PATH is used instead.
 */
export function discoveryCommandFor(
  kind: 'antigravity' | 'codex', providers: readonly AiProviderConfig[] = [],
): string {
  const canonical = CANONICAL_COMMANDS[kind]
  for (const provider of providers) {
    if (!provider || provider.kind !== 'cli' || provider.providerKindId !== kind) continue
    if (typeof provider.command !== 'string') continue
    const command = provider.command.trim()
    const base = path.basename(command).replace(/\.(exe|cmd)$/i, '').toLowerCase()
    if (base === canonical && path.isAbsolute(command)) return command
  }
  return canonical
}

const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const CLAUDE_MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,120}$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const label = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120)
  return text || undefined
}
const ladderOrder = (levels: Iterable<string>): ReasoningLevel[] => {
  const set = new Set(levels)
  return REASONING_LADDER.filter((level) => set.has(level))
}

/**
 * `agy models` prints one `<slug>\t<Display Name>` line per model, effort included in the slug
 * (`gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)`). Lines group into stems with the levels listed for each.
 *
 * Dropped: slugs without an effort suffix (agy addresses a level by suffix, so Swarm could never pick one),
 * foreign families and internal orchestrators (`isEligibleAgyStem`). A list left empty is a failure, not
 * an answer: an empty catalog must never replace a good one.
 */
export function parseAgyModels(stdout: string): CatalogModel[] {
  const stems = new Map<string, { label?: string; efforts: Set<string> }>()
  let recognizedLines = 0
  for (const line of stdout.split(/\r?\n/)) {
    const [rawSlug = '', rawLabel] = line.split('\t')
    const slug = rawSlug.trim().toLowerCase()
    if (!SAFE_MODEL_ID.test(slug) || rawLabel === undefined) continue
    recognizedLines += 1
    const match = AGY_EFFORT_SUFFIX.exec(slug)
    if (!match) continue
    const stem = slug.slice(0, match.index)
    if (!isEligibleAgyStem(stem)) continue
    const entry = stems.get(stem) ?? { label: label(rawLabel.replace(/\s*\([^()]*\)\s*$/, '')), efforts: new Set<string>() }
    entry.efforts.add(match[1])
    stems.set(stem, entry)
  }
  if (recognizedLines === 0) throw new ModelDiscoveryError('parse-failed')
  const models = [...stems].map(([id, entry]) => ({
    id, ...(entry.label ? { label: entry.label } : {}), efforts: ladderOrder(entry.efforts),
  }))
  if (models.length === 0) throw new ModelDiscoveryError('no-models')
  return models
}

/**
 * `codex debug models` prints `{ "models": [...] }`. Only `visibility: "list"` entries are offered —
 * `hide` ones such as `gpt-reserve` and `codex-auto-review` are internal and Swarm already admits them by
 * name — with each one's `supported_reasoning_levels` (`[{ effort: "low" }, …]`), in `priority` order.
 */
export function parseCodexModels(stdout: string): CatalogModel[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new ModelDiscoveryError('parse-failed')
  }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : undefined
  if (!list) throw new ModelDiscoveryError('parse-failed')
  const entries: Array<{ model: CatalogModel; priority: number; index: number }> = []
  const seen = new Set<string>()
  list.forEach((value, index) => {
    if (!isRecord(value) || value.visibility !== 'list' || typeof value.slug !== 'string') return
    const id = value.slug.trim().toLowerCase()
    if (!SAFE_MODEL_ID.test(id) || seen.has(id)) return
    seen.add(id)
    const levels = Array.isArray(value.supported_reasoning_levels)
      ? ladderOrder(value.supported_reasoning_levels.flatMap((level: unknown) =>
        typeof level === 'string' ? [level] : isRecord(level) && typeof level.effort === 'string' ? [level.effort] : []))
      : undefined
    const name = label(value.display_name)
    entries.push({
      model: { id, ...(name ? { label: name } : {}), ...(levels ? { efforts: levels } : {}) },
      priority: typeof value.priority === 'number' && Number.isFinite(value.priority) ? value.priority : Number.MAX_SAFE_INTEGER,
      index,
    })
  })
  if (entries.length === 0) throw new ModelDiscoveryError('no-models')
  return entries.sort((a, b) => a.priority - b.priority || a.index - b.index).map((entry) => entry.model)
}

/** `capabilities.effort` → the levels marked `supported`; `[]` when effort itself is unsupported. */
function effortsFromCapabilities(capabilities: unknown): { efforts?: ReasoningLevel[] } {
  if (!isRecord(capabilities) || !isRecord(capabilities.effort)) return {}
  const effort = capabilities.effort
  if (effort.supported === false) return { efforts: [] }
  const levels = REASONING_LADDER.filter((level) => isRecord(effort[level]) && (effort[level] as Record<string, unknown>).supported === true)
  return levels.length > 0 ? { efforts: levels } : {}
}

/** One `GET /v1/models` page: `{ data: [{ id, display_name, capabilities }], has_more, last_id }`. */
export function parseAnthropicModelPage(body: unknown): { models: CatalogModel[]; hasMore: boolean; lastId?: string } {
  if (!isRecord(body) || !Array.isArray(body.data)) throw new ModelDiscoveryError('parse-failed')
  const models = body.data.filter(isRecord).flatMap((entry) => {
    const id = typeof entry.id === 'string' ? entry.id.trim().toLowerCase() : ''
    if (!CLAUDE_MODEL_ID.test(id)) return []
    const name = label(entry.display_name)
    return [{ id, ...(name ? { label: name } : {}), ...effortsFromCapabilities(entry.capabilities) }]
  })
  const lastId = typeof body.last_id === 'string' && body.last_id ? body.last_id : undefined
  return { models, hasMore: body.has_more === true, ...(lastId ? { lastId } : {}) }
}

/**
 * The models endpoint beside the messages endpoint inference posts to — `anthropicMessagesUrl()`, the rule
 * `core/ai/api-provider.ts` itself uses, so `…/v1/messages` becomes `…/v1/models`. A `baseUrl` that is empty,
 * blank or unparseable sends inference nowhere, and so lists nothing here: it is never read as "unset" and
 * replaced by the public API. Any other layout is one MAO cannot map, and its key is not sent anywhere new.
 */
export function anthropicModelsUrl(baseUrl?: string): string | undefined {
  let url: URL
  try {
    // Parsed exactly as `fetch` parses it, without trimming first: a URL inference cannot use lists nothing.
    url = new URL(anthropicMessagesUrl(baseUrl))
  } catch {
    return undefined
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined
  if (!/\/messages\/?$/.test(url.pathname)) return undefined
  url.pathname = url.pathname.replace(/\/messages\/?$/, '/models')
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Anthropic-format API providers with a key, as (models URL, key) pairs, first occurrence wins. */
export function anthropicApiSources(providers: readonly AiProviderConfig[]): Array<{ url: string; apiKey: string }> {
  const sources: Array<{ url: string; apiKey: string }> = []
  for (const provider of providers) {
    if (!provider || provider.kind !== 'api' || provider.apiFormat !== 'anthropic') continue
    const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : ''
    const url = anthropicModelsUrl(provider.baseUrl)
    if (!apiKey || !url) continue
    if (!sources.some((source) => source.url === url && source.apiKey === apiKey)) sources.push({ url, apiKey })
  }
  return sources
}

/**
 * One deadline shared by every request of a listing: `signal` aborts when it passes (or the caller aborts),
 * and `timedOut()` tells the two apart.
 */
export interface DiscoveryDeadline {
  readonly signal: AbortSignal
  timedOut(): boolean
}

/** A signal that aborts after `ms` or when `parent` does, with a disposer for the timer and listener. */
function boundedSignal(parent: AbortSignal | undefined, ms: number): DiscoveryDeadline & { dispose: () => void } {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, ms)
  const onAbort = () => controller.abort()
  if (parent?.aborted) controller.abort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Pages through `GET /v1/models` with one provider's key. Status codes map to fixed categories; no
 * response body, header or URL is ever surfaced, since an error page can echo the request.
 *
 * Every page shares `deadline` — by default one `MODEL_DISCOVERY_TIMEOUT_MS` from the first request, never a
 * fresh one per page — and nothing is sent once it has passed. `discoverClaudeModels()` passes one deadline
 * across every saved key as well, so a slow first answer leaves the rest less time, not another minute.
 */
export async function fetchAnthropicModels(
  url: string, apiKey: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal, deadline?: DiscoveryDeadline,
): Promise<CatalogModel[]> {
  const own = deadline ? undefined : boundedSignal(signal, MODEL_DISCOVERY_TIMEOUT_MS)
  const bound = deadline ?? own!
  // A deadline that fired without timing out was aborted by whoever owns it, even if no `signal` came along.
  const aborted = () => signal?.aborted === true || (bound.signal.aborted && !bound.timedOut())
  const failure = (otherwise: ModelCatalogFailure) =>
    new ModelDiscoveryError(aborted() ? 'aborted' : bound.timedOut() ? 'request-timeout' : otherwise)
  try {
    const models: CatalogModel[] = []
    const seen = new Set<string>()
    let afterId: string | undefined
    for (let page = 0; page < ANTHROPIC_MODEL_PAGES; page += 1) {
      // Checked before sending, not left to `fetch`: past the deadline the key goes nowhere at all.
      if (signal?.aborted || bound.signal.aborted) throw failure('request-timeout')
      const pageUrl = new URL(url)
      pageUrl.searchParams.set('limit', '1000')
      if (afterId) pageUrl.searchParams.set('after_id', afterId)
      let response: Response
      try {
        response = await fetchImpl(pageUrl, {
          method: 'GET',
          headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
          // Never followed: fetch strips Authorization on a cross-origin redirect but forwards `x-api-key`,
          // and this request runs unattended against a path the operator never configured. A 3xx is an error.
          redirect: 'manual',
          signal: bound.signal,
        })
      } catch {
        throw failure('network-error')
      }
      if (response.status === 401 || response.status === 403) throw new ModelDiscoveryError('unauthorized')
      if (!response.ok) throw new ModelDiscoveryError('http-error')
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw failure('parse-failed')
      }
      const parsed = parseAnthropicModelPage(body)
      for (const model of parsed.models) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
      }
      if (!parsed.hasMore || !parsed.lastId) break
      afterId = parsed.lastId
    }
    if (models.length === 0) throw new ModelDiscoveryError('no-models')
    return models
  } finally {
    own?.dispose()
  }
}

/**
 * The environment variables Claude Code reads to pin a model or an alias's target — with its `settings.json`
 * (`claudeModelsFromSettings`), the zero-cost local source for a CLI-only setup (names verified in the
 * Claude Code 2.1.330 binary). Only these keys are read.
 */
export const CLAUDE_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const

/**
 * First-party Claude ids pinned in the environment, deduplicated. A trailing context marker such as
 * `[1m]` is dropped; platform-prefixed ids (Bedrock, Vertex) and aliases are not ids and are skipped.
 */
export function claudeModelsFromEnvironment(env: Readonly<Record<string, unknown>>): CatalogModel[] {
  const ids: string[] = []
  for (const key of CLAUDE_MODEL_ENV_KEYS) {
    const value = env[key]
    if (typeof value !== 'string') continue
    const id = value.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
    if (CLAUDE_MODEL_ID.test(id) && !ids.includes(id)) ids.push(id)
  }
  return ids.map((id) => ({ id }))
}

/** A settings file larger than this is not Claude Code's: it is skipped, not parsed. */
const CLAUDE_SETTINGS_MAX_BYTES = 1024 * 1024

/**
 * Claude Code's user settings — `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`, located
 * through `env` so a test (or a host with another home) never reads the operator's file by accident. Only
 * the `model` setting and the model keys of its `env` block are read: the file can also hold an API key,
 * which is neither kept nor reported. Anything missing, unreadable or malformed reads as nothing.
 */
export function claudeModelsFromSettings(env: NodeJS.ProcessEnv): CatalogModel[] {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim()
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || (home ? path.join(home, '.claude') : undefined)
  if (!configDir) return []
  const file = path.join(configDir, 'settings.json')
  let settings: unknown
  try {
    if (fs.statSync(file).size > CLAUDE_SETTINGS_MAX_BYTES) return []
    settings = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(settings)) return []
  const models = [
    ...claudeModelsFromEnvironment({ ANTHROPIC_MODEL: settings.model }),
    ...claudeModelsFromEnvironment(isRecord(settings.env) ? settings.env : {}),
  ]
  return models.filter((model, index) => models.findIndex((other) => other.id === model.id) === index)
}

export interface ModelDiscoveryDeps {
  run?: DiscoveryCommandRunner
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
}

/**
 * Claude has no listing command. With an Anthropic-format API provider configured, its key lists models
 * through the API: the first key that answers wins, and if every one fails the refresh fails, keeping the
 * cached list — a key rejected today is no reason to forget yesterday's models. All the keys share one
 * `MODEL_DISCOVERY_TIMEOUT_MS`, so the listing ends within it however many keys or pages there are. Without
 * one, Claude Code's own model settings are the source, from the environment and its `settings.json`; with
 * neither, the built-in list and the family aliases (`opus`, `sonnet`, `fable`, `haiku`) are the answer,
 * which is not a failure.
 */
export async function discoverClaudeModels(
  providers: readonly AiProviderConfig[], deps: ModelDiscoveryDeps = {}, signal?: AbortSignal,
): Promise<DiscoveryOutcome> {
  const sources = anthropicApiSources(providers)
  if (sources.length > 0) {
    const deadline = boundedSignal(signal, MODEL_DISCOVERY_TIMEOUT_MS)
    let failure: ModelCatalogFailure = 'no-models'
    try {
      for (const source of sources) {
        try {
          const models = await fetchAnthropicModels(source.url, source.apiKey, deps.fetch, signal, deadline)
          return { kind: 'catalog', source: 'anthropic-models-api', models }
        } catch (error) {
          failure = error instanceof ModelDiscoveryError ? error.reason : 'unexpected-error'
          if (failure === 'aborted') break
        }
      }
    } finally {
      deadline.dispose()
    }
    throw new ModelDiscoveryError(failure)
  }
  const env = deps.env ?? process.env
  const local = [...claudeModelsFromEnvironment(env), ...claudeModelsFromSettings(env)]
    .filter((model, index, all) => all.findIndex((other) => other.id === model.id) === index)
  if (local.length > 0) return { kind: 'catalog', source: 'claude-local-settings', models: local }
  return { kind: 'static', reason: 'no-source' }
}

let defaultRunner: DiscoveryCommandRunner | undefined

/** One provider's current list. Rejects only with `ModelDiscoveryError`. */
export async function discoverModels(
  kind: DiscoverableProviderKind,
  providers: readonly AiProviderConfig[] = [],
  deps: ModelDiscoveryDeps = {},
  signal?: AbortSignal,
): Promise<DiscoveryOutcome> {
  try {
    if (kind === 'claude') return await discoverClaudeModels(providers, deps, signal)
    const run = deps.run ?? (defaultRunner ??= createDiscoveryCommandRunner())
    if (kind === 'antigravity') {
      const stdout = await run(discoveryCommandFor('antigravity', providers), ['models'], signal)
      return { kind: 'catalog', source: 'agy-models', models: parseAgyModels(stdout) }
    }
    const stdout = await run(discoveryCommandFor('codex', providers), ['debug', 'models'], signal)
    return { kind: 'catalog', source: 'codex-debug-models', models: parseCodexModels(stdout) }
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error
    throw new ModelDiscoveryError('unexpected-error')
  }
}
