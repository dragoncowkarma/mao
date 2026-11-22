import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_MODEL_PAGES,
  MODEL_DISCOVERY_MAX_BUFFER,
  MODEL_DISCOVERY_TIMEOUT_MS,
  ModelDiscoveryError,
  anthropicModelsUrl,
  claudeModelsFromEnvironment,
  claudeModelsFromSettings,
  createDiscoveryCommandRunner,
  discoverClaudeModels,
  discoverModels,
  discoveryCommandFor,
  fetchAnthropicModels,
  parseAgyModels,
  parseAnthropicModelPage,
  parseCodexModels,
} from './model-discovery.ts'
import type { AiProviderConfig } from './types.ts'
import type { DiscoveryCommandRunner } from './model-discovery.ts'

/** The shape `agy models` 1.5.14 printed on 2026-11-22, including the entries Swarm must never offer. */
const AGY_OUTPUT = [
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
  'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
  'gemini-4-neon-low\tGemini 4 Neon (Low)',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
  'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  '',
].join('\n')

const level = (effort: string) => ({ effort, description: `${effort} reasoning` })
const codexEntry = (slug: string, visibility: string, priority: number, efforts: string[]) => ({
  slug, display_name: slug.toUpperCase(), visibility, priority,
  supported_reasoning_levels: efforts.map(level), base_instructions: 'x'.repeat(64),
})

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ModelDiscoveryError)
    return (error as ModelDiscoveryError).reason
  }
  throw new Error('expected a ModelDiscoveryError')
}

describe('agy models', () => {
  it('groups effort slugs into Gemini stems and drops orchestrators and foreign families', () => {
    expect(parseAgyModels(AGY_OUTPUT)).toEqual([
      { id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
    ])
  })

  it('tolerates CRLF and never reads `ultra` as a level suffix', () => {
    const models = parseAgyModels('gemini-5-ultra-high\tGemini 5 Ultra (High)\r\ngemini-5-ultra\tGemini 5 Ultra\r\n')
    expect(models).toEqual([{ id: 'gemini-5-ultra', label: 'Gemini 5 Ultra', efforts: ['high'] }])
  })

  it.each([
    ['unrecognized output', 'Fetching available models...\nerror: not signed in', 'parse-failed'],
    ['only foreign and orchestrator models', 'claude-opus-5-5-low\tClaude\ngemini-pro-orchestrator-neon\tOrchestrator', 'no-models'],
  ])('refuses %s rather than caching an empty list', async (_name, stdout, reason) => {
    expect(await reasonOf(Promise.resolve().then(() => parseAgyModels(stdout)))).toBe(reason)
  })
})

describe('codex debug models', () => {
  const output = JSON.stringify({
    models: [
      codexEntry('gpt-6-luna', 'list', 8, ['low', 'medium', 'high', 'xhigh', 'max']),
      codexEntry('gpt-reserve', 'hide', 4, ['low', 'medium']),
      codexEntry('gpt-6.2-sol', 'list', 1, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
      codexEntry('codex-auto-review', 'hide', 12, ['medium']),
      { ...codexEntry('gpt-6.1-terra', 'list', 3, []), supported_reasoning_levels: ['high', 'turbo', 'low'] },
      { slug: 'gpt-6.9-unpriced', visibility: 'list' },
    ],
  })

  it('keeps listed models in priority order with their reasoning levels, never hidden ones', () => {
    expect(parseCodexModels(output)).toEqual([
      { id: 'gpt-6.2-sol', label: 'GPT-6.2-SOL', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1-TERRA', efforts: ['low', 'high'] },
      { id: 'gpt-6-luna', label: 'GPT-6-LUNA', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-6.9-unpriced' },
    ])
  })

  it.each([
    ['invalid JSON', '{"models": [', 'parse-failed'],
    ['a document without a model list', '{"data": []}', 'parse-failed'],
    ['nothing visible', JSON.stringify({ models: [codexEntry('gpt-reserve', 'hide', 1, ['low'])] }), 'no-models'],
  ])('refuses %s', async (_name, stdout, reason) => {
    expect(await reasonOf(Promise.resolve().then(() => parseCodexModels(stdout)))).toBe(reason)
  })
})

describe('bounded, shell-free listing commands', () => {
  it('hands execFile argv, no shell, the deadline and a buffer far above the 840 KB codex prints', async () => {
    const execute = vi.fn((_command: string, _args: string[], _options: object, callback: (...args: unknown[]) => void) => {
      queueMicrotask(() => callback(null, '{"models":[]}', ''))
      return { stdin: { on: vi.fn(), end: vi.fn() }, kill: vi.fn() }
    })
    const run = createDiscoveryCommandRunner(execute as unknown as typeof execFile)
    await expect(run('codex', ['debug', 'models'])).resolves.toBe('{"models":[]}')
    expect(execute).toHaveBeenCalledWith('codex', ['debug', 'models'], expect.objectContaining({
      shell: false, timeout: MODEL_DISCOVERY_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MODEL_DISCOVERY_MAX_BUFFER,
    }), expect.any(Function))
    expect(MODEL_DISCOVERY_MAX_BUFFER).toBeGreaterThanOrEqual(8 * 1024 * 1024)
  })

  it('reads a real child output larger than Node\'s 1 MiB execFile default in full', async () => {
    const run = createDiscoveryCommandRunner()
    const size = 2 * 1024 * 1024
    const stdout = await run(process.execPath, ['-e', `process.stdout.write('x'.repeat(${size}))`])
    expect(stdout).toHaveLength(size)
  })

  it('closes stdin, so a CLI that reads it first still answers', async () => {
    const run = createDiscoveryCommandRunner()
    const script = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write('eof:'+s.length))"
    await expect(run(process.execPath, ['-e', script])).resolves.toBe('eof:0')
  })

  it.each([
    ['a missing command', 'mao-no-such-cli-140', [] as string[], 'command-not-found'],
    ['a non-zero exit', process.execPath, ['-e', 'process.exit(3)'], 'command-failed'],
  ])('classifies %s', async (_name, command, args, reason) => {
    expect(await reasonOf(createDiscoveryCommandRunner()(command, args))).toBe(reason)
  })

  it('kills a hung CLI at the deadline and an over-long answer at the buffer cap', async () => {
    const slow = createDiscoveryCommandRunner(execFile, 300)
    expect(await reasonOf(slow(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']))).toBe('command-timeout')
    const small = createDiscoveryCommandRunner(execFile, 10_000, 1024)
    expect(await reasonOf(small(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"]))).toBe('output-too-large')
  })

  it('stops when the host shuts down', async () => {
    const controller = new AbortController()
    const pending = createDiscoveryCommandRunner()(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], controller.signal)
    controller.abort()
    expect(await reasonOf(pending)).toBe('aborted')
    const aborted = new AbortController()
    aborted.abort()
    expect(await reasonOf(createDiscoveryCommandRunner()(process.execPath, ['-e', ''], aborted.signal))).toBe('aborted')
  })

  it('borrows a saved provider\'s absolute path to the real CLI, never a wrapper or a relative path', () => {
    const cli = (command: string, providerKindId: AiProviderConfig['providerKindId']): AiProviderConfig =>
      ({ id: command, name: command, kind: 'cli', command, providerKindId })
    expect(discoveryCommandFor('codex', [cli('/opt/bin/codex', 'codex')])).toBe('/opt/bin/codex')
    expect(discoveryCommandFor('antigravity', [cli('/Users/me/.local/bin/agy', 'antigravity')])).toBe('/Users/me/.local/bin/agy')
    expect(discoveryCommandFor('codex', [cli('/opt/bin/codex-wrapper', 'codex')])).toBe('codex')
    expect(discoveryCommandFor('codex', [cli('./codex', 'codex')])).toBe('codex')
    expect(discoveryCommandFor('codex', [cli('/opt/bin/codex', 'claude')])).toBe('codex')
    expect(discoveryCommandFor('antigravity', [])).toBe('agy')
  })
})

describe('Anthropic Models API', () => {
  const page = (ids: string[], hasMore = false) => ({
    data: ids.map((id) => ({
      type: 'model', id, display_name: id.toUpperCase(),
      capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, max: { supported: true } } },
    })),
    has_more: hasMore, first_id: ids[0], last_id: ids.at(-1),
  })
  const respond = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

  it('derives the models endpoint beside a messages endpoint and refuses layouts it cannot map', () => {
    expect(anthropicModelsUrl()).toBe('https://api.anthropic.com/v1/models')
    expect(anthropicModelsUrl('https://proxy.example/anthropic/v1/messages?x=1')).toBe('https://proxy.example/anthropic/v1/models')
    expect(anthropicModelsUrl('https://proxy.example/v1/complete')).toBeUndefined()
    expect(anthropicModelsUrl('https://user:pass@proxy.example/v1/messages')).toBeUndefined()
    expect(anthropicModelsUrl('file:///etc/v1/messages')).toBeUndefined()
    expect(anthropicModelsUrl('not a url')).toBeUndefined()
  })

  it('reads effort support from capabilities, and an unsupported effort as none', () => {
    expect(parseAnthropicModelPage({
      data: [
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', capabilities: { effort: { supported: true, low: { supported: true }, xhigh: { supported: true }, max: { supported: false } } } },
        { id: 'claude-haiku-4-5', capabilities: { effort: { supported: false } } },
        { id: 'claude-sonnet-5-5' },
        { id: 'gpt-6.2-sol' },
        { id: 42 },
      ],
      has_more: false,
    })).toEqual({
      models: [
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: ['low', 'xhigh'] },
        { id: 'claude-haiku-4-5', efforts: [] },
        { id: 'claude-sonnet-5-5' },
      ],
      hasMore: false,
    })
  })

  it('pages with after_id and sends only the key and version headers', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const after = new URL(String(url)).searchParams.get('after_id')
      return respond(200, after ? page(['claude-haiku-5-5']) : page(['claude-opus-5-5', 'claude-sonnet-5-5'], true))
    })
    const models = await fetchAnthropicModels('https://api.anthropic.com/v1/models', 'sk-test', fetchImpl as typeof fetch)
    expect(models.map((model) => model.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    const [firstUrl, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(firstUrl)).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(String(fetchImpl.mock.calls[1][0])).toContain('after_id=claude-sonnet-5-5')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('stops paging a server that always says has_more', async () => {
    let next = 0
    const fetchImpl = vi.fn(async () => respond(200, page([`claude-test-${(next += 1)}`], true)))
    await fetchAnthropicModels('https://api.anthropic.com/v1/models', 'k', fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledTimes(ANTHROPIC_MODEL_PAGES)
  })

  it.each([
    [401, 'unauthorized'], [403, 'unauthorized'], [404, 'http-error'], [529, 'http-error'],
  ])('maps HTTP %i to %s without echoing the body', async (status, reason) => {
    const secret = 'sk-ant-api03-SECRET'
    const fetchImpl = vi.fn(async () => respond(status, `{"error":"bad key ${secret}"}`))
    try {
      await fetchAnthropicModels('https://api.anthropic.com/v1/models', secret, fetchImpl as unknown as typeof fetch)
      expect.unreachable()
    } catch (error) {
      expect((error as ModelDiscoveryError).reason).toBe(reason)
      expect(String((error as Error).message)).not.toContain(secret)
    }
  })

  it('classifies a socket failure, an unreadable body and an empty listing', async () => {
    const url = 'https://api.anthropic.com/v1/models'
    expect(await reasonOf(fetchAnthropicModels(url, 'k', (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)))
      .toBe('network-error')
    expect(await reasonOf(fetchAnthropicModels(url, 'k', (async () => respond(200, 'not json')) as unknown as typeof fetch)))
      .toBe('parse-failed')
    expect(await reasonOf(fetchAnthropicModels(url, 'k', (async () => respond(200, { data: [], has_more: false })) as unknown as typeof fetch)))
      .toBe('no-models')
  })
})

describe('Claude discovery sources', () => {
  const api = (apiKey?: string, extra: Partial<AiProviderConfig> = {}): AiProviderConfig =>
    ({ id: 'api', name: 'API', kind: 'api', apiFormat: 'anthropic', apiKey, ...extra })
  const ok = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5' }], has_more: false })))

  it('lists through a saved Anthropic key, ignoring OpenAI-format and keyless providers', async () => {
    const fetchImpl = vi.fn(ok)
    const outcome = await discoverClaudeModels([
      { id: 'o', name: 'OpenAI', kind: 'api', apiFormat: 'openai', apiKey: 'sk-openai' },
      api(''),
      api('sk-anthropic'),
    ], { fetch: fetchImpl as unknown as typeof fetch, env: {} })
    expect(outcome).toEqual({ kind: 'catalog', source: 'anthropic-models-api', models: [{ id: 'claude-opus-5-5' }] })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].headers).toMatchObject({ 'x-api-key': 'sk-anthropic' })
  })

  it('fails, keeping the cache, when every saved key fails — the environment is not a fallback for that', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }))
    const env = { ANTHROPIC_MODEL: 'claude-opus-5-5' }
    expect(await reasonOf(discoverClaudeModels([api('a'), api('b', { baseUrl: 'https://p.example/v1/messages' })],
      { fetch: fetchImpl as unknown as typeof fetch, env }))).toBe('unauthorized')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('falls back to Claude Code\'s model settings, then to the built-in list', async () => {
    const env = {
      ANTHROPIC_MODEL: 'claude-opus-5-5[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'CLAUDE-SONNET-5-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-5-5',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'fable',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-opus-5-5',
      UNRELATED_MODEL: 'claude-secret-9',
    }
    expect(claudeModelsFromEnvironment(env)).toEqual([{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }])
    expect(await discoverClaudeModels([], { env })).toEqual({
      kind: 'catalog', source: 'claude-local-settings', models: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }],
    })
    expect(await discoverClaudeModels([], { env: {} })).toEqual({ kind: 'static', reason: 'no-source' })
  })

  it('reports an unexpected throw as a fixed category, never its message', async () => {
    const run = vi.fn(async () => { throw new Error('token ghp_SECRET in a stack trace') })
    try {
      await discoverModels('codex', [], { run })
      expect.unreachable()
    } catch (error) {
      expect((error as ModelDiscoveryError).reason).toBe('unexpected-error')
      expect((error as Error).message).not.toContain('ghp_SECRET')
    }
  })

  it('asks agy and codex with their listing subcommands', async () => {
    const run = vi.fn<DiscoveryCommandRunner>(async (command) => command === 'agy'
      ? 'gemini-4-neon-low\tGemini 4 Neon (Low)\n'
      : JSON.stringify({ models: [codexEntry('gpt-6.2-sol', 'list', 1, ['low'])] }))
    await expect(discoverModels('antigravity', [], { run })).resolves.toMatchObject({ kind: 'catalog', source: 'agy-models' })
    await expect(discoverModels('codex', [], { run })).resolves.toMatchObject({ kind: 'catalog', source: 'codex-debug-models' })
    expect(run.mock.calls.map((call) => [call[0], call[1]])).toEqual([['agy', ['models']], ['codex', ['debug', 'models']]])
  })
})

describe('review follow-ups (#140)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
  const settingsDir = (settings: unknown) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-claude-settings-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings))
    return dir
  }

  it('reads only the model settings from Claude Code\'s settings.json, never anything else in it', () => {
    const dir = settingsDir({
      model: 'claude-opus-5-5',
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-SECRET', OTHER: 'claude-x-1' },
      permissions: { allow: ['Bash(claude-fable-9)'] },
    })
    const models = claudeModelsFromSettings({ CLAUDE_CONFIG_DIR: dir })
    expect(models).toEqual([{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }])
    expect(JSON.stringify(models)).not.toContain('SECRET')
  })

  it('finds ~/.claude through the given HOME only, so a test never reads the operator\'s file', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-home-'))
    dirs.push(home)
    fs.mkdirSync(path.join(home, '.claude'))
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-fable-5-2' }))
    expect(claudeModelsFromSettings({ HOME: home })).toEqual([{ id: 'claude-fable-5-2' }])
    expect(claudeModelsFromSettings({})).toEqual([])
    await expect(discoverClaudeModels([], { env: { HOME: home } })).resolves.toEqual({
      kind: 'catalog', source: 'claude-local-settings', models: [{ id: 'claude-fable-5-2' }],
    })
  })

  it.each([['malformed JSON', '{"model": '], ['a list', '["claude-opus-5-5"]'], ['an alias only', { model: 'opus' }]])(
    'reads %s as nothing', (_name, settings) => {
      expect(claudeModelsFromSettings({ CLAUDE_CONFIG_DIR: settingsDir(settings) })).toEqual([])
    },
  )

  it('never follows a redirect with the API key: a 3xx is an error', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }))
    expect(await reasonOf(fetchAnthropicModels('https://gw.example/v1/models', 'k', fetchImpl as unknown as typeof fetch)))
      .toBe('http-error')
    expect((fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].redirect).toBe('manual')
  })
})
