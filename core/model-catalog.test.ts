import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MODEL_CATALOG_TTL_MS,
  MODEL_CATALOG_FILE,
  MODEL_CATALOG_RETRY_MS,
  createModelCatalogMaintainer,
  describeModelCatalog,
  describeModelCatalogRefresh,
  modelCatalogPath,
  modelCatalogTtlMs,
  readModelCatalog,
  refreshModelCatalog,
  sanitizeModelCatalog,
  startModelCatalogRefresher,
} from './model-catalog.ts'
import type { DiscoveryCommandRunner, ModelDiscoveryDeps } from './ai/model-discovery.ts'
import { ModelDiscoveryError } from './ai/model-discovery.ts'

const dirs: string[] = []
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-model-catalog-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const HOUR = 60 * 60_000
const T0 = Date.parse('2026-11-22T00:00:00.000Z')
const AGY = 'gemini-4-neon-low\tGemini 4 Neon (Low)\ngemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n'
const CODEX = JSON.stringify({ models: [{ slug: 'gpt-7-nova', visibility: 'list', priority: 1,
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] }] })

/** Fake CLIs: each name answers, or fails with the given category, and every call is counted. */
function cliDeps(answers: Partial<Record<'agy' | 'codex', string | ModelDiscoveryError>>, env: NodeJS.ProcessEnv = {}) {
  const run = vi.fn<DiscoveryCommandRunner>(async (command) => {
    const answer = answers[command as 'agy' | 'codex'] ?? new ModelDiscoveryError('command-not-found')
    if (answer instanceof ModelDiscoveryError) throw answer
    return answer
  })
  const deps: ModelDiscoveryDeps = { run, env }
  return { run, deps }
}

const writeCache = (dir: string, document: unknown) =>
  fs.writeFileSync(modelCatalogPath(dir), JSON.stringify(document))

describe('refresh period', () => {
  it.each([
    [undefined, DEFAULT_MODEL_CATALOG_TTL_MS], ['', DEFAULT_MODEL_CATALOG_TTL_MS], ['6', 6 * HOUR], ['0.5', HOUR / 2],
    ['0', null], ['-1', DEFAULT_MODEL_CATALOG_TTL_MS], ['soon', DEFAULT_MODEL_CATALOG_TTL_MS], ['0.000001', 60_000],
  ])('MAO_MODEL_CATALOG_TTL_HOURS=%s gives %s ms', (value, expected) => {
    expect(modelCatalogTtlMs(value === undefined ? {} : { MAO_MODEL_CATALOG_TTL_HOURS: value })).toBe(expected)
  })
})

describe('the cache file', () => {
  it('reads as empty when missing or unparseable, so the built-in tables apply', () => {
    const dir = tempDir()
    expect(readModelCatalog(dir, 1000)).toEqual({ providers: {}, attempts: {}, ttlMs: 1000 })
    fs.writeFileSync(modelCatalogPath(dir), '{"providers": ')
    expect(readModelCatalog(dir, 1000)).toEqual({ providers: {}, attempts: {}, ttlMs: 1000 })
  })

  it('re-validates a hand-edited file: no foreign agy model, no unknown level, no source from another kind', () => {
    const view = sanitizeModelCatalog({
      providers: {
        antigravity: { updatedAt: '2026-11-22T00:00:00Z', source: 'agy-models', models: [
          { id: 'gemini-4-neon', efforts: ['low', 'turbo', 'xhigh'] },
          { id: 'claude-opus-5-5', efforts: ['low'] },
          { id: 'gemini-pro-orchestrator-neon', efforts: ['low'] },
          { id: 'Gemini 4 Argon' },
        ] },
        codex: { updatedAt: '2026-11-22T00:00:00Z', source: 'agy-models', models: [{ id: 'gpt-6.2-sol' }] },
        claude: { updatedAt: 'yesterday', source: 'anthropic-models-api', models: [{ id: 'claude-opus-5-5' }] },
        constructor: { updatedAt: '2026-11-22T00:00:00Z', source: 'agy-models', models: [{ id: 'gemini-4-neon' }] },
      },
      attempts: {
        codex: { at: '2026-11-22T00:00:00Z', outcome: 'failed', reason: 'command-not-found' },
        claude: { at: '2026-11-22T00:00:00Z', outcome: 'exploded' },
        antigravity: { at: '2026-11-22T00:00:00Z', outcome: 'failed', reason: 'stack trace with a token' },
      },
    }, null)
    expect(view).toEqual({
      providers: {
        antigravity: { updatedAt: '2026-11-22T00:00:00.000Z', source: 'agy-models',
          models: [{ id: 'gemini-4-neon', efforts: ['low', 'xhigh'] }] },
      },
      attempts: {
        codex: { at: '2026-11-22T00:00:00.000Z', outcome: 'failed', reason: 'command-not-found' },
        antigravity: { at: '2026-11-22T00:00:00.000Z', outcome: 'failed' },
      },
      ttlMs: null,
    })
  })
})

describe('refreshing', () => {
  it('caches each answer and keeps the previous list of a provider that failed this time', async () => {
    const dir = tempDir()
    writeCache(dir, { version: 1, providers: {
      antigravity: { updatedAt: '2026-11-01T00:00:00.000Z', source: 'agy-models', models: [{ id: 'gemini-4-argon', efforts: ['low'] }] },
    } })
    const { deps } = cliDeps({ codex: CODEX, agy: new ModelDiscoveryError('command-timeout') })
    const report = await refreshModelCatalog({ dataDir: dir, deps, now: () => T0, ttlMs: DEFAULT_MODEL_CATALOG_TTL_MS })

    expect(report.persisted).toBe(true)
    expect(report.results).toEqual([
      { kind: 'antigravity', outcome: 'failed', reason: 'command-timeout', models: 0 },
      { kind: 'claude', outcome: 'static', reason: 'no-source', models: 0 },
      { kind: 'codex', outcome: 'updated', models: 1 },
    ])
    const onDisk = readModelCatalog(dir, DEFAULT_MODEL_CATALOG_TTL_MS)
    expect(onDisk).toEqual(report.catalog)
    expect(onDisk.providers.antigravity?.models).toEqual([{ id: 'gemini-4-argon', efforts: ['low'] }])
    expect(onDisk.providers.codex).toEqual({ updatedAt: '2026-11-22T00:00:00.000Z', source: 'codex-debug-models',
      models: [{ id: 'gpt-7-nova', efforts: ['low', 'ultra'] }] })
    expect(onDisk.providers.claude).toBeUndefined()
    expect(onDisk.attempts).toEqual({
      antigravity: { at: '2026-11-22T00:00:00.000Z', outcome: 'failed', reason: 'command-timeout' },
      claude: { at: '2026-11-22T00:00:00.000Z', outcome: 'static', reason: 'no-source' },
      codex: { at: '2026-11-22T00:00:00.000Z', outcome: 'updated' },
    })
    // The file is the whole document, replaced atomically: no temporary file or lock is left behind.
    expect(fs.readdirSync(dir).sort()).toEqual([MODEL_CATALOG_FILE])
    expect(JSON.parse(fs.readFileSync(modelCatalogPath(dir), 'utf8')).version).toBe(1)
  })

  it('refreshes only the requested providers and leaves the others untouched', async () => {
    const dir = tempDir()
    const { run, deps } = cliDeps({ codex: CODEX, agy: AGY })
    const report = await refreshModelCatalog({ dataDir: dir, kinds: ['antigravity'], deps, now: () => T0 })
    expect(run).toHaveBeenCalledTimes(1)
    expect(report.results.map((result) => result.kind)).toEqual(['antigravity'])
    expect(Object.keys(readModelCatalog(dir).providers)).toEqual(['antigravity'])
  })

  it('never lets Claude Code\'s local settings replace an Anthropic API listing', async () => {
    const dir = tempDir()
    const api = { updatedAt: '2026-11-01T00:00:00.000Z', source: 'anthropic-models-api',
      models: [{ id: 'claude-opus-5-5' }, { id: 'claude-mythos-5-2' }] }
    writeCache(dir, { providers: { claude: api } })
    const { deps } = cliDeps({}, { ANTHROPIC_MODEL: 'claude-sonnet-5-5' })
    await refreshModelCatalog({ dataDir: dir, kinds: ['claude'], deps, now: () => T0 })
    expect(readModelCatalog(dir).providers.claude).toEqual(api)
    // …while the same local answer does fill an empty cache.
    const empty = tempDir()
    await refreshModelCatalog({ dataDir: empty, kinds: ['claude'], deps, now: () => T0 })
    expect(readModelCatalog(empty).providers.claude?.source).toBe('claude-local-settings')
  })

  it('leaves a later attempt another process recorded in place', async () => {
    const dir = tempDir()
    const later = { at: '2026-11-22T01:00:00.000Z', outcome: 'updated' }
    writeCache(dir, { attempts: { codex: later } })
    const { deps } = cliDeps({ codex: new ModelDiscoveryError('command-failed') })
    await refreshModelCatalog({ dataDir: dir, kinds: ['codex'], deps, now: () => T0 })
    expect(readModelCatalog(dir).attempts.codex).toEqual(later)
  })

  it('records nothing for a refresh that was interrupted', async () => {
    const dir = tempDir()
    const { deps } = cliDeps({ codex: new ModelDiscoveryError('aborted'), agy: new ModelDiscoveryError('aborted') })
    const report = await refreshModelCatalog({ dataDir: dir, kinds: ['codex', 'antigravity'], deps, now: () => T0 })
    expect(report.results.every((result) => result.reason === 'aborted')).toBe(true)
    expect(fs.existsSync(modelCatalogPath(dir))).toBe(false)
  })

  it('still answers, unsaved, when the cache cannot be written', async () => {
    const blocker = path.join(tempDir(), 'not-a-directory')
    fs.writeFileSync(blocker, '')
    const { deps } = cliDeps({ codex: CODEX })
    const report = await refreshModelCatalog({ dataDir: blocker, kinds: ['codex'], deps, now: () => T0 })
    expect(report.persisted).toBe(false)
    expect(report.catalog.providers.codex?.models[0].id).toBe('gpt-7-nova')
    expect(describeModelCatalogRefresh(report).at(-1)).toMatch(/could not be saved/)
  })
})

describe('the refresh schedule', () => {
  it('is due for a missing or stale list and not for a fresh one, whoever refreshed it', async () => {
    const dir = tempDir()
    let now = T0
    writeCache(dir, { providers: {
      codex: { updatedAt: new Date(T0 - 2 * HOUR).toISOString(), source: 'codex-debug-models', models: [{ id: 'gpt-6.2-sol' }] },
      antigravity: { updatedAt: new Date(T0 - 30 * HOUR).toISOString(), source: 'agy-models', models: [{ id: 'gemini-4-neon' }] },
    } })
    const maintainer = createModelCatalogMaintainer({ dataDir: dir, ttlMs: 24 * HOUR, now: () => now, deps: cliDeps({}).deps })
    expect(maintainer.dueKinds()).toEqual(['antigravity', 'claude'])
    now = T0 + 23 * HOUR
    expect(maintainer.dueKinds()).toEqual(['antigravity', 'claude', 'codex'])
  })

  it('treats a far-future timestamp as due, so a wrong clock cannot postpone refreshes forever', () => {
    const dir = tempDir()
    writeCache(dir, { providers: {
      codex: { updatedAt: '2099-01-01T00:00:00.000Z', source: 'codex-debug-models', models: [{ id: 'gpt-6.2-sol' }] },
    } })
    expect(createModelCatalogMaintainer({ dataDir: dir, ttlMs: HOUR, now: () => T0 }).dueKinds()).toContain('codex')
  })

  it('does nothing automatically when the period is off', async () => {
    const dir = tempDir()
    const { run, deps } = cliDeps({ codex: CODEX })
    const maintainer = createModelCatalogMaintainer({ dataDir: dir, ttlMs: null, deps })
    expect(maintainer.dueKinds()).toEqual([])
    await expect(maintainer.refreshDue()).resolves.toBeUndefined()
    expect(run).not.toHaveBeenCalled()
    await maintainer.refreshNow(['codex'])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('backs off a failure for the retry window and anything else for the full period, in this process', async () => {
    const dir = tempDir()
    let now = T0
    const { run, deps } = cliDeps({ agy: new ModelDiscoveryError('command-not-found') })
    const maintainer = createModelCatalogMaintainer({ dataDir: dir, ttlMs: 24 * HOUR, now: () => now, deps })
    await maintainer.refreshDue()
    expect(run).toHaveBeenCalledTimes(2)
    expect(maintainer.dueKinds()).toEqual([])
    now = T0 + MODEL_CATALOG_RETRY_MS
    // The failed CLIs are retried; Claude, which simply has no source here, waits out the period.
    expect(maintainer.dueKinds()).toEqual(['antigravity', 'codex'])
    now = T0 + 24 * HOUR
    expect(maintainer.dueKinds()).toEqual(['antigravity', 'claude', 'codex'])
  })

  it('honours another process\'s recent failure, unless it only says that host lacks the CLI', () => {
    const dir = tempDir()
    const at = new Date(T0 - 10 * 60_000).toISOString()
    writeCache(dir, { attempts: {
      codex: { at, outcome: 'failed', reason: 'command-timeout' },
      antigravity: { at, outcome: 'failed', reason: 'command-not-found' },
      claude: { at, outcome: 'static', reason: 'no-source' },
    } })
    const maintainer = createModelCatalogMaintainer({ dataDir: dir, ttlMs: 24 * HOUR, now: () => T0 })
    expect(maintainer.dueKinds()).toEqual(['antigravity', 'claude'])
  })

  it('runs one refresh at a time: a concurrent due check joins the one in flight', async () => {
    const dir = tempDir()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn<DiscoveryCommandRunner>(async (command) => {
      await gate
      return command === 'agy' ? AGY : CODEX
    })
    const maintainer = createModelCatalogMaintainer({ dataDir: dir, ttlMs: HOUR, deps: { run, env: {} } })
    const first = maintainer.refreshDue()
    const second = maintainer.refreshDue()
    expect(second).toBe(first)
    release()
    await first
    expect(run).toHaveBeenCalledTimes(2)
    await expect(maintainer.refreshDue()).resolves.toBeUndefined()
  })

  it('selects nothing for an unknown provider name instead of refreshing everything', async () => {
    const dir = tempDir()
    const { run, deps } = cliDeps({ codex: CODEX, agy: AGY })
    const report = await createModelCatalogMaintainer({ dataDir: dir, deps }).refreshNow(['gemini' as never])
    expect(report.results).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the long-running hosts\' refresher', () => {
  it('checks at start, again every tick, and stops cleanly', async () => {
    vi.useFakeTimers({ now: T0 })
    const dir = tempDir()
    const run = vi.fn<DiscoveryCommandRunner>(async (command, _args, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return command === 'agy' ? AGY : CODEX
    })
    const log = vi.fn()
    const refresher = startModelCatalogRefresher({ dataDir: dir, ttlMs: HOUR, tickMs: 60_000, deps: { run, env: {} }, log })
    await vi.waitFor(() => expect(log).toHaveBeenCalled())
    expect(run).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.map((call) => call[0])).toContain('Codex: refreshed, 1 model(s) from `codex debug models`')

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4))

    const clear = vi.spyOn(globalThis, 'clearInterval')
    refresher.stop()
    expect(clear).toHaveBeenCalledWith(refresher.handle)
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('interrupts a refresh in flight on stop', async () => {
    const dir = tempDir()
    let seen: AbortSignal | undefined
    const run = vi.fn<DiscoveryCommandRunner>((_command, _args, signal) => new Promise((_resolve, reject) => {
      seen = signal
      signal?.addEventListener('abort', () => reject(new ModelDiscoveryError('aborted')))
    }))
    const refresher = startModelCatalogRefresher({ dataDir: dir, ttlMs: HOUR, deps: { run, env: {} } })
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    refresher.stop()
    expect(seen?.aborted).toBe(true)
    // Claude's static answer is still recorded; the interrupted CLIs record nothing.
    await vi.waitFor(() => expect(fs.existsSync(modelCatalogPath(dir))).toBe(true))
    expect(Object.keys(readModelCatalog(dir).attempts)).toEqual(['claude'])
  })

  it('never keeps a process alive by itself', () => {
    const refresher = startModelCatalogRefresher({ dataDir: tempDir(), ttlMs: null })
    expect(refresher.handle.hasRef()).toBe(false)
    refresher.stop()
  })
})

describe('operator-facing text', () => {
  it('names sources and fixed reasons, and lists what pickers and Swarm accept', () => {
    const lines = describeModelCatalog({
      providers: {
        codex: { updatedAt: '2026-11-22T00:00:00.000Z', source: 'codex-debug-models', models: [{ id: 'gpt-7-nova', efforts: ['low', 'max'] }] },
      },
      attempts: {
        antigravity: { at: '2026-11-22T00:00:00.000Z', outcome: 'failed', reason: 'command-not-found' },
        claude: { at: '2026-11-22T00:00:00.000Z', outcome: 'static', reason: 'no-source' },
      },
      ttlMs: 24 * HOUR,
    })
    expect(lines).toContain('Codex: 1 model(s) from `codex debug models`, refreshed 2026-11-22T00:00:00.000Z')
    expect(lines).toContain('  gpt-7-nova (low, max)')
    expect(lines).toContain('  gpt-6-luna (low, medium, high, xhigh, max)')
    expect(lines).toContain('Antigravity (agy): built-in list')
    expect(lines).toContain('  last refresh (2026-11-22T00:00:00.000Z) failed: the CLI is not installed or not on PATH')
    expect(lines).toContain('  gemini-4-neon (low, medium, high, xhigh)')
    expect(lines).toContain('  haiku (no effort flag)')
    expect(lines.at(-1)).toBe('Long-running hosts refresh every 24 h (MAO_MODEL_CATALOG_TTL_HOURS).')
  })
})
