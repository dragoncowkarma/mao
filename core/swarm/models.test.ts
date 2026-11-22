import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildModelEffortArgs, PROVIDER_OPTIONS, REASONING_LADDER, resolveReasoning, type ModelCatalogSnapshot } from '../ai/provider-options.ts'
import {
  buildAiArgv, DEFAULT_AI_CONFIG, parseRole, resolveAgyModel, resolveRoleAssignment,
  validateDistinctRoles, validateModelAvailability,
} from './models.ts'

afterEach(() => vi.unstubAllEnvs())

/** The value after `--model` — the exact id a CLI will run, not merely a string somewhere in argv. */
const modelArg = (argv: string[]) => argv[argv.indexOf('--model') + 1]
/** The effort a CLI receives: Claude's `--effort`, Codex's `model_reasoning_effort`, absent otherwise. */
const effortArg = (argv: string[]) => argv.includes('--effort')
  ? argv[argv.indexOf('--effort') + 1]
  : argv.find((arg) => arg.startsWith('model_reasoning_effort='))?.split('=')[1]

describe('Swarm role assignments', () => {
  it('ignores quoted examples and selects the last real amendment through the shared parser boundary', () => {
    const tag = '[Worker: codex | Model: terra | Reasoning: 높음]'
    expect(parseRole(`\`${tag}\`\n> ${tag}\n<!--${tag}-->\n~~~\n${tag}\n~~~`, 'worker')).toBeUndefined()
    expect(parseRole(`${tag}\n[Worker: claude | Model: sonnet 5 | Reasoning: 중간]`, 'worker'))
      .toEqual({ ai: 'claude', model: 'sonnet 5', reasoning: '중간' })
  })

  it('rejects duplicate and unknown AI assignments before dispatch', () => {
    expect(() => validateDistinctRoles(DEFAULT_AI_CONFIG.codex, DEFAULT_AI_CONFIG.codex)).toThrow(/distinct/)
    expect(() => validateDistinctRoles({ ai: 'unknown', model: 'model', reasoning: 'low' })).toThrow(/Unknown/)
    expect(() => validateDistinctRoles(DEFAULT_AI_CONFIG.codex, DEFAULT_AI_CONFIG.claude, DEFAULT_AI_CONFIG.antigravity)).not.toThrow()
  })

  it.each([
    [DEFAULT_AI_CONFIG.codex, DEFAULT_AI_CONFIG.codex, DEFAULT_AI_CONFIG.claude],
    [DEFAULT_AI_CONFIG.codex, DEFAULT_AI_CONFIG.claude, DEFAULT_AI_CONFIG.codex],
    [DEFAULT_AI_CONFIG.codex, DEFAULT_AI_CONFIG.claude, DEFAULT_AI_CONFIG.claude],
  ])('refuses every pairwise maker-checker collision %#', (worker, reviewer, maintainer) => {
    expect(() => validateDistinctRoles(worker, reviewer, maintainer)).toThrow(/distinct/)
  })

  it.each(['constructor', '__proto__', 'toString'])('refuses inherited-object provider names %s', (ai) => {
    const assignment = { ai, model: 'terra', reasoning: 'high' }
    expect(() => validateDistinctRoles(assignment)).toThrow(/Unknown/)
    expect(() => validateModelAvailability(assignment)).toThrow(/Unknown/)
  })

  it.each(['codex', 'antigravity', 'claude'] as const)('reduces checking role effort for %s without mutating tags', (ai) => {
    const assignment = { ...DEFAULT_AI_CONFIG[ai], reasoning: 'ultra' }
    expect(resolveRoleAssignment(assignment, 'worker').reasoning).toBe('ultra')
    expect(resolveRoleAssignment(assignment, 'reviewer').reasoning).toBe('medium')
    expect(resolveRoleAssignment(assignment, 'worker_revise').reasoning).toBe('medium')
    expect(resolveRoleAssignment(assignment, 'maintainer').reasoning).toBe('low')
    expect(assignment.reasoning).toBe('ultra')
  })
})

describe('model and reasoning resolution', () => {
  it.each([
    [' 낮음! ', 'low'], ['light', 'low'], ['중간', 'medium'], ['thinking', 'high'],
    ['매우\u00a0  높음.', 'xhigh'], ['엑스트라', 'xhigh'], ['최대', 'max'],
    ['ultracode', 'max'], ['울트라', 'ultra'], ['extra high', 'xhigh'], ['typo', 'medium'],
    ['constructor', 'medium'], ['__proto__', 'medium'],
  ])('folds %s onto %s', (label, expected) => expect(resolveReasoning(label)).toBe(expected))

  it('clamps excess effort and avoids jumping above a requested supported rung', () => {
    expect(resolveReasoning('ultra', REASONING_LADDER.slice(0, 3))).toBe('high')
    expect(resolveReasoning('high', ['low', 'max'])).toBe('low')
    expect(resolveReasoning('low', ['medium'])).toBe('medium')
  })

  it.each([
    ['gemini 3.1 pro', 'gemini-4-argon-high'], ['gemini 3.6 flash', 'gemini-3.8-flash-high'],
    ['gemini 4 argon (low)', 'gemini-4-argon-high'], ['gemini_3.8_flash_medium', 'gemini-3.8-flash-high'],
    ['claude opus 5.5', 'gemini-3.8-flash-high'], ['claude-sonnet-5-5-low', 'gemini-3.8-flash-high'],
    ['gpt-oss-120b', 'gemini-3.8-flash-high'], ['unknown', 'gemini-3.8-flash-high'],
  ])('resolves agy %s safely', (model, expected) => expect(resolveAgyModel(model, 'ultra')).toBe(expected))

  it.each([
    // Current Codex generation and its short forms (#140).
    ['codex', 'gpt-6.2-sol', 'gpt-6.2-sol'], ['codex', '6.2 sol', 'gpt-6.2-sol'], ['codex', 'sol', 'gpt-6.2-sol'],
    ['codex', '6.2', 'gpt-6.2-sol'], ['codex', '6.2 astra', 'gpt-6.2-astra'], ['codex', 'astra', 'gpt-6.2-astra'],
    ['codex', '6.1 terra', 'gpt-6.1-terra'], ['codex', 'terra', 'gpt-6.1-terra'], ['codex', '6.1', 'gpt-6.1-terra'],
    ['codex', '6.1 sol', 'gpt-6.1-sol'], ['codex', '6 astra', 'gpt-6-astra'], ['codex', '6 sol', 'gpt-6-sol'],
    ['codex', '6', 'gpt-6-sol'], ['codex', '6 luna', 'gpt-6-luna'], ['codex', 'luna', 'gpt-6-luna'],
    ['codex', 'GPT-6.2-Sol', 'gpt-6.2-sol'], ['codex', '6.2  sol', 'gpt-6.2-sol'],
    // 5.6 stays addressable; retired generations follow the current default's family.
    ['codex', '5.6', 'gpt-5.6-terra'], ['codex', '5.6 sol', 'gpt-5.6-sol'], ['codex', 'gpt-5.6-luna', 'gpt-5.6-luna'],
    ['codex', '5.5', 'gpt-6.1-terra'], ['codex', 'gpt-5.1-codex-max', 'gpt-6.1-terra'],
    ['codex', '5.4 mini', 'gpt-6-luna'], ['codex', '5.6 spark', 'gpt-6-luna'],
    // Current Claude generation, its family aliases, and every earlier generation resolving to it.
    ['claude', 'claude-opus-5-5', 'claude-opus-5-5'], ['claude', 'opus 5.5', 'claude-opus-5-5'], ['claude', 'opus', 'claude-opus-5-5'],
    ['claude', 'claude opus 5.5', 'claude-opus-5-5'], ['claude', 'sonnet 5.5', 'claude-sonnet-5-5'],
    ['claude', 'fable 5.2', 'claude-fable-5-2'], ['claude', 'fable', 'claude-fable-5-2'],
    ['claude', 'haiku 5.5', 'claude-haiku-5-5'], ['claude', 'haiku', 'claude-haiku-5-5'],
    ['claude', 'opus 5', 'claude-opus-5-5'], ['claude', 'claude-opus-5', 'claude-opus-5-5'], ['claude', 'opus 4.7', 'claude-opus-5-5'],
    ['claude', 'sonnet 5', 'claude-sonnet-5-5'], ['claude', 'claude-sonnet-5', 'claude-sonnet-5-5'],
    ['claude', 'sonnet 4.6', 'claude-sonnet-5-5'], ['claude', 'claude-3-5-sonnet', 'claude-sonnet-5-5'],
    ['claude', 'fable 5', 'claude-fable-5-2'], ['claude', 'claude-fable-5', 'claude-fable-5-2'],
    ['claude', 'haiku 4.5', 'claude-haiku-5-5'], ['claude', 'claude-haiku-4-5', 'claude-haiku-5-5'],
    ['claude', 'haiku 3.5', 'claude-haiku-5-5'],
  ])('maps %s %s to %s', (ai, model, expected) => {
    expect(modelArg(buildAiArgv({ ai, model, reasoning: 'high' }, 'prompt', true))).toBe(expected)
  })

  it('falls back before retry for unavailable models, allowing explicit custom models', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateModelAvailability({ ai: 'codex', model: 'typo', reasoning: 'ultra' })).toEqual(DEFAULT_AI_CONFIG.codex)
    for (const ai of ['codex', 'claude', 'antigravity'] as const) {
      expect(validateModelAvailability({ ai, model: 'constructor', reasoning: 'ultra' })).toEqual(DEFAULT_AI_CONFIG[ai])
    }
    for (const model of ['custom:private-model', 'unlisted:private-model', 'gpt-reserve', 'codex-auto-review']) {
      expect(validateModelAvailability({ ai: 'codex', model, reasoning: 'ultra' }).model).toBe(model.replace(/^(custom|unlisted):/, ''))
    }
    vi.stubEnv('SWARM_ALLOWED_CUSTOM_MODELS', 'private-a, Private-B')
    expect(validateModelAvailability({ ai: 'claude', model: 'private-b', reasoning: 'high' }).model).toBe('private-b')
    expect(validateModelAvailability({ ai: 'antigravity', model: 'custom:claude-opus-5-5', reasoning: 'ultra' }))
      .toEqual(DEFAULT_AI_CONFIG.antigravity)
    const custom = resolveRoleAssignment({ ai: 'codex', model: 'custom:private', reasoning: 'high' }, 'reviewer')
    expect(buildAiArgv(custom, 'prompt', false)).toContain('private')
    const customGemini = resolveRoleAssignment({ ai: 'antigravity', model: 'custom:gemini-private', reasoning: 'high' }, 'reviewer')
    expect(buildAiArgv(customGemini, 'prompt', false)).toContain('gemini-private-medium')
    vi.restoreAllMocks()
  })

  it('keeps provider model tables aligned with accepted effort-qualified agy slugs', () => {
    for (const option of PROVIDER_OPTIONS.antigravity.models) {
      expect(resolveAgyModel(option.value, option.value.split('-').at(-1)!)).toBe(option.value)
    }
    expect(PROVIDER_OPTIONS.codex.efforts.map((option) => option.value)).toEqual(REASONING_LADDER)
  })
})

describe('command construction', () => {
  it('explicitly overrides local Codex reasoning and clamps Luna/custom models', () => {
    for (const model of ['luna', 'custom:private']) {
      const argv = buildAiArgv({ ai: 'codex', model, reasoning: 'ultra' }, 'literal $(touch /tmp/no)', false, '/a b')
      expect(argv).toContain('model_reasoning_effort=max')
      expect(argv).toContain('read-only')
      expect(argv).not.toContain('--approve-for-me')
      expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
      expect(argv).not.toContain('literal $(touch /tmp/no)')
      expect(argv.at(-1)).toBe('-')
      expect(argv).toContain('/a b')
    }
    expect(buildAiArgv({ ai: 'codex', model: 'terra', reasoning: 'ultra' }, 'prompt', true))
      .toContain('model_reasoning_effort=ultra')
  })

  it.each(['codex', 'claude'] as const)('keeps a large private %s prompt out of argv', (ai) => {
    const prompt = 'Private issue, PR and diff: 한글\n'.repeat(10_000)
    const argv = buildAiArgv(DEFAULT_AI_CONFIG[ai], prompt, false)
    expect(argv.join(' ')).not.toContain('Private issue')
    expect(Buffer.byteLength(argv.join(' '))).toBeLessThan(1000)
    if (ai === 'codex') expect(argv.at(-1)).toBe('-')
    if (ai === 'claude') expect(argv).toContain('-p')
  })

  it.each([false, true])('keeps the established agy print-argument contract (writer=%s)', (writer) => {
    const prompt = 'Actual agy prompt: 한글\nwith multiple lines'
    const argv = buildAiArgv(DEFAULT_AI_CONFIG.antigravity, prompt, writer)
    expect(argv.slice(-2)).toEqual(['--print', prompt])
    expect(argv).not.toContain('--input-format')
  })

  it('keeps read-only permission flags separate from Worker flags', () => {
    const codexRead = buildAiArgv(DEFAULT_AI_CONFIG.codex, 'prompt', false)
    expect(codexRead).toContain('read-only')
    expect(codexRead).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(buildAiArgv(DEFAULT_AI_CONFIG.codex, 'prompt', true)).toContain('--dangerously-bypass-approvals-and-sandbox')
    const claudeRead = buildAiArgv(DEFAULT_AI_CONFIG.claude, 'prompt', false)
    expect(claudeRead).toContain('--allowed-tools')
    expect(claudeRead).not.toContain('--dangerously-skip-permissions')
    expect(buildAiArgv(DEFAULT_AI_CONFIG.claude, 'prompt', true)).toContain('--dangerously-skip-permissions')
    expect(buildAiArgv(DEFAULT_AI_CONFIG.antigravity, 'prompt', false)).toContain('--sandbox')
    expect(buildAiArgv(DEFAULT_AI_CONFIG.antigravity, 'prompt', true)).not.toContain('--sandbox')
  })

  it('normalizes and clamps Swarm prose tags before encoding CLI flags', () => {
    expect(buildAiArgv({ ai: 'claude', model: 'sonnet 5', reasoning: 'ultra' }, 'prompt', true))
      .toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5-5', '--effort', 'max']))
    expect(buildAiArgv({ ai: 'codex', model: 'luna', reasoning: 'ultra' }, 'prompt', true))
      .toContain('model_reasoning_effort=max')
    expect(buildAiArgv({ ai: 'antigravity', model: 'gemini 4 argon', reasoning: '울트라' }, 'prompt', true))
      .toContain('gemini-4-argon-high')
    // Haiku 4.5 took no effort, but the tag now means Haiku 5.5, which does.
    expect(buildAiArgv({ ai: 'claude', model: 'haiku 4.5', reasoning: 'high' }, 'prompt', true))
      .toEqual(expect.arrayContaining(['--model', 'claude-haiku-5-5', '--effort', 'high']))
  })

  it('uses shared flags without duplicating an existing operator model/effort choice', () => {
    expect(buildModelEffortArgs('codex', 'gpt-5.6-terra', 'ultra', ['-m', 'override', '-c', 'model_reasoning_effort=low'])).toEqual([])
    expect(buildModelEffortArgs('claude', 'claude-sonnet-5', 'ultra')).toEqual(['--model', 'claude-sonnet-5', '--effort', 'ultra'])
    expect(buildModelEffortArgs('agy', 'gemini-4-argon-low', 'ultra')).toEqual(['--model', 'gemini-4-argon-low'])
  })
})

describe('the 2026-11 catalog (#140)', () => {
  it('defaults to the current generation', () => {
    expect(DEFAULT_AI_CONFIG).toEqual({
      codex: { ai: 'codex', model: 'gpt-6.1-terra', reasoning: 'high' },
      antigravity: { ai: 'antigravity', model: 'gemini-3.8-flash', reasoning: 'high' },
      claude: { ai: 'claude', model: 'claude-sonnet-5-5', reasoning: 'high' },
    })
  })

  it.each([
    ['codex', 'gpt-6.2-sol', 'ultra'], ['codex', 'gpt-6.2-astra', 'ultra'], ['codex', 'gpt-6.1-terra', 'ultra'],
    ['codex', 'gpt-6.1-sol', 'ultra'], ['codex', 'gpt-6-astra', 'ultra'], ['codex', 'gpt-6-sol', 'ultra'],
    ['codex', 'gpt-5.6-sol', 'ultra'], ['codex', 'gpt-5.6-terra', 'ultra'],
    ['codex', 'gpt-6-luna', 'max'], ['codex', 'gpt-5.6-luna', 'max'], ['codex', 'custom:gpt-private', 'max'],
    ['claude', 'claude-opus-5-5', 'max'], ['claude', 'fable', 'max'], ['claude', 'custom:claude-private', 'max'],
  ])('clamps an ultra request for %s %s to %s', (ai, model, expected) => {
    expect(effortArg(buildAiArgv({ ai, model, reasoning: 'ultra' }, 'prompt', true))).toBe(expected)
  })

  it.each([
    ['neon', 'gemini-4-neon-xhigh'], ['gemini 4 neon', 'gemini-4-neon-xhigh'], ['gemini-4-neon-low', 'gemini-4-neon-xhigh'],
    ['hydrogen', 'gemini-4-hydrogen-xhigh'], ['gemini 4 hydrogen', 'gemini-4-hydrogen-xhigh'],
    ['argon', 'gemini-4-argon-high'], ['gemini-3.8-flash', 'gemini-3.8-flash-high'],
  ])('clamps agy %s to its own suffix ceiling (%s)', (model, expected) => {
    expect(resolveAgyModel(model, 'ultra')).toBe(expected)
    expect(validateModelAvailability({ ai: 'antigravity', model, reasoning: 'ultra' }).model).toBe(model)
  })

  it('keeps xhigh available below the ceiling and never rounds a request up', () => {
    expect(resolveAgyModel('neon', 'xhigh')).toBe('gemini-4-neon-xhigh')
    expect(resolveAgyModel('neon', 'medium')).toBe('gemini-4-neon-medium')
    expect(resolveAgyModel('argon', 'xhigh')).toBe('gemini-4-argon-high')
  })

  it('keeps foreign families and internal orchestrators out of the Antigravity role, custom or not', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const model of ['claude-opus-5-5', 'claude sonnet 5.5', 'gpt-oss-120b', 'custom:claude-opus-5-5',
      'custom:gpt-6.2-sol', 'custom:gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator-g1-pro']) {
      expect(validateModelAvailability({ ai: 'antigravity', model, reasoning: 'high' })).toEqual(DEFAULT_AI_CONFIG.antigravity)
    }
    expect(resolveAgyModel('gemini-pro-orchestrator-neon', 'high', true)).toBe('gemini-3.8-flash-high')
    expect(resolveAgyModel('claude-opus-5-5', 'high', true)).toBe('gemini-3.8-flash-high')
  })

  it('passes a custom model through verbatim: `custom:` pins an exact id, legacy spelling or not', () => {
    const pinned = buildAiArgv({ ai: 'claude', model: 'custom:claude-opus-5', reasoning: 'high' }, 'prompt', true)
    expect(modelArg(pinned)).toBe('claude-opus-5')
    // A pinned legacy Haiku keeps its no-effort metadata, so no unsupported flag is invented for it.
    const haiku = buildAiArgv({ ai: 'claude', model: 'custom:claude-haiku-4-5', reasoning: 'high' }, 'prompt', true)
    expect(modelArg(haiku)).toBe('claude-haiku-4-5')
    expect(haiku).not.toContain('--effort')
    expect(modelArg(buildAiArgv({ ai: 'codex', model: 'custom:gpt-5.5', reasoning: 'high' }, 'prompt', true))).toBe('gpt-5.5')
    // The issue's own tags, which the running pre-#140 Swarm needed the prefix for, still dispatch exactly.
    expect(modelArg(buildAiArgv(resolveRoleAssignment(
      { ai: 'codex', model: 'custom:gpt-6.2-sol', reasoning: 'max' }, 'reviewer'), 'prompt', false))).toBe('gpt-6.2-sol')
    expect(buildAiArgv(resolveRoleAssignment(
      { ai: 'antigravity', model: 'custom:gemini-4-neon', reasoning: 'xhigh' }, 'worker'), 'prompt', true))
      .toContain('gemini-4-neon-xhigh')
    // A custom Gemini slug that already names a level gets the role's level instead of a second suffix.
    expect(buildAiArgv(resolveRoleAssignment(
      { ai: 'antigravity', model: 'custom:gemini-private-high', reasoning: 'max' }, 'reviewer'), 'prompt', false))
      .toContain('gemini-private-medium')
  })

  it('offers every alias target, default and table entry from the provider tables Global settings shows', () => {
    const values = (kind: 'claude' | 'codex') => PROVIDER_OPTIONS[kind].models.map((option) => option.value)
    for (const ai of ['claude', 'codex'] as const) {
      expect(values(ai)).toContain(DEFAULT_AI_CONFIG[ai].model)
      // Each current model id in the table dispatches as itself — none is silently re-aliased. (The family
      // aliases and the legacy no-effort ids there are for saved configs, which pass through verbatim.)
      const ids = PROVIDER_OPTIONS[ai].models.filter((option) => !option.noEffort && /^(claude|gpt)-/.test(option.value))
      expect(ids.length).toBeGreaterThanOrEqual(4)
      for (const { value } of ids) expect(modelArg(buildAiArgv({ ai, model: value, reasoning: 'high' }, 'prompt', true))).toBe(value)
    }
    for (const model of ['sol', 'astra', 'terra', 'luna', '6', '6.1', '6.2', '5.5', '5.4 mini']) {
      expect(values('codex')).toContain(modelArg(buildAiArgv({ ai: 'codex', model, reasoning: 'high' }, 'prompt', true)))
    }
    for (const model of ['opus', 'sonnet', 'fable', 'haiku', 'opus 5', 'sonnet 4.6', 'fable 5', 'haiku 3.5']) {
      expect(values('claude')).toContain(modelArg(buildAiArgv({ ai: 'claude', model, reasoning: 'high' }, 'prompt', true)))
    }
    expect(PROVIDER_OPTIONS.antigravity.models.map((option) => option.value)).toEqual(expect.arrayContaining([
      'gemini-4-neon-xhigh', 'gemini-4-hydrogen-xhigh', 'gemini-4-argon-high', 'gemini-3.8-flash-low',
    ]))
    expect(PROVIDER_OPTIONS.antigravity.models.map((option) => option.value)).not.toContain('gemini-4-argon-xhigh')
  })
})

describe('the refreshed catalog at dispatch (#140)', () => {
  const catalog: ModelCatalogSnapshot = { providers: {
    codex: { updatedAt: '2026-11-22T00:00:00.000Z', source: 'codex-debug-models', models: [
      { id: 'gpt-7-nova', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6.2-sol', efforts: ['low', 'medium', 'high'] },
    ] },
    claude: { updatedAt: '2026-11-22T00:00:00.000Z', source: 'anthropic-models-api', models: [
      // A listing may claim more than `claude --effort` accepts; the CLI's own ladder still caps it.
      { id: 'claude-mythos-5-2', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'claude-plain-9', efforts: [] },
    ] },
    antigravity: { updatedAt: '2026-11-22T00:00:00.000Z', source: 'agy-models', models: [
      { id: 'gemini-5-krypton', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-opus-6', efforts: ['low'] },
    ] },
  } }

  it('dispatches a model only the CLI knows, within the levels it reported', () => {
    const nova = buildAiArgv({ ai: 'codex', model: 'GPT-7-Nova', reasoning: 'ultra' }, 'prompt', true, undefined, catalog)
    expect(modelArg(nova)).toBe('gpt-7-nova')
    expect(effortArg(nova)).toBe('xhigh')
    const mythos = buildAiArgv({ ai: 'claude', model: 'claude-mythos-5-2', reasoning: 'ultra' }, 'prompt', true, undefined, catalog)
    expect(modelArg(mythos)).toBe('claude-mythos-5-2')
    expect(effortArg(mythos)).toBe('max')
    expect(resolveAgyModel('gemini 5 krypton', 'ultra', false, catalog)).toBe('gemini-5-krypton-max')
    expect(validateModelAvailability({ ai: 'antigravity', model: 'gemini-5-krypton', reasoning: 'high' }, catalog).model)
      .toBe('gemini-5-krypton')
  })

  it('lets a reported narrower ladder override the built-in one for a known model', () => {
    expect(effortArg(buildAiArgv({ ai: 'codex', model: 'sol', reasoning: 'ultra' }, 'prompt', true, undefined, catalog))).toBe('high')
    expect(effortArg(buildAiArgv({ ai: 'codex', model: 'sol', reasoning: 'ultra' }, 'prompt', true))).toBe('ultra')
  })

  it('sends no effort to a model its source says takes none', () => {
    expect(buildAiArgv({ ai: 'claude', model: 'claude-plain-9', reasoning: 'high' }, 'prompt', true, undefined, catalog))
      .not.toContain('--effort')
  })

  it('falls back without the catalog, and never admits a foreign model a hand-edited agy list carries', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateModelAvailability({ ai: 'codex', model: 'gpt-7-nova', reasoning: 'high' })).toEqual(DEFAULT_AI_CONFIG.codex)
    expect(validateModelAvailability({ ai: 'antigravity', model: 'claude-opus-6', reasoning: 'high' }, catalog))
      .toEqual(DEFAULT_AI_CONFIG.antigravity)
    expect(resolveAgyModel('claude-opus-6', 'high', false, catalog)).toBe('gemini-3.8-flash-high')
  })

  it('threads the catalog through role resolution', () => {
    const reviewer = resolveRoleAssignment({ ai: 'codex', model: 'gpt-7-nova', reasoning: 'ultra' }, 'reviewer', catalog)
    expect(reviewer).toEqual({ ai: 'codex', model: 'gpt-7-nova', reasoning: 'medium' })
  })
})

describe('review follow-ups (#140)', () => {
  it('keeps a custom Gemini stem rather than re-aliasing it, as the prose tag would', () => {
    expect(modelArg(buildAiArgv({ ai: 'antigravity', model: 'custom:gemini-3-pro', reasoning: 'high' }, 'p', false)))
      .toBe('gemini-3-pro-high')
    expect(modelArg(buildAiArgv({ ai: 'antigravity', model: 'gemini-3-pro', reasoning: 'high' }, 'p', false)))
      .toBe('gemini-4-argon-high')
    expect(modelArg(buildAiArgv({ ai: 'antigravity', model: 'custom:Gemini 3.6 Flash', reasoning: 'low' }, 'p', false)))
      .toBe('gemini-3.6-flash-low')
  })

  it('dispatches a catalog model listed without levels at max at most', () => {
    const catalog: ModelCatalogSnapshot = { providers: {
      codex: { updatedAt: '2026-11-22T00:00:00.000Z', source: 'codex-debug-models', models: [{ id: 'gpt-7-luna' }] },
    } }
    expect(effortArg(buildAiArgv({ ai: 'codex', model: 'gpt-7-luna', reasoning: 'ultra' }, 'p', false, undefined, catalog)))
      .toBe('max')
  })
})
