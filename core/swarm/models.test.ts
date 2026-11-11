import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildModelEffortArgs, PROVIDER_OPTIONS, REASONING_LADDER, resolveReasoning } from '../ai/provider-options.ts'
import {
  buildAiArgv, DEFAULT_AI_CONFIG, parseRole, resolveAgyModel, resolveRoleAssignment,
  validateDistinctRoles, validateModelAvailability,
} from './models.ts'

afterEach(() => vi.unstubAllEnvs())

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
    ['codex', '5.6', 'gpt-5.6-terra'], ['codex', '5.4 mini', 'gpt-5.6-luna'],
    ['codex', '5.6 spark', 'gpt-5.6-luna'], ['claude', 'opus 4.7', 'claude-opus-5'],
    ['claude', 'claude-3-5-sonnet', 'claude-sonnet-5'], ['claude', 'haiku 3.5', 'claude-haiku-4-5'],
  ])('maps %s %s to %s', (ai, model, expected) => {
    expect(buildAiArgv({ ai, model, reasoning: 'high' }, 'prompt', true)).toContain(expected)
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

  it.each(['codex', 'claude', 'antigravity'] as const)('keeps a large private %s prompt out of argv', (ai) => {
    const prompt = 'Private issue, PR and diff: 한글\n'.repeat(10_000)
    const argv = buildAiArgv(DEFAULT_AI_CONFIG[ai], prompt, false)
    expect(argv.join(' ')).not.toContain('Private issue')
    expect(Buffer.byteLength(argv.join(' '))).toBeLessThan(1000)
    if (ai === 'antigravity') expect(argv.slice(-4)).toEqual(['--input-format', 'text', '--print', ''])
    if (ai === 'codex') expect(argv.at(-1)).toBe('-')
    if (ai === 'claude') expect(argv).toContain('-p')
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
      .toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5', '--effort', 'max']))
    expect(buildAiArgv({ ai: 'codex', model: 'luna', reasoning: 'ultra' }, 'prompt', true))
      .toContain('model_reasoning_effort=max')
    expect(buildAiArgv({ ai: 'antigravity', model: 'gemini 4 argon', reasoning: '울트라' }, 'prompt', true))
      .toContain('gemini-4-argon-high')
    expect(buildAiArgv({ ai: 'claude', model: 'haiku 4.5', reasoning: 'high' }, 'prompt', true))
      .not.toContain('--effort')
  })

  it('uses shared flags without duplicating an existing operator model/effort choice', () => {
    expect(buildModelEffortArgs('codex', 'gpt-5.6-terra', 'ultra', ['-m', 'override', '-c', 'model_reasoning_effort=low'])).toEqual([])
    expect(buildModelEffortArgs('claude', 'claude-sonnet-5', 'ultra')).toEqual(['--model', 'claude-sonnet-5', '--effort', 'ultra'])
    expect(buildModelEffortArgs('agy', 'gemini-4-argon-low', 'ultra')).toEqual(['--model', 'gemini-4-argon-low'])
  })
})
