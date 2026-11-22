import { describe, expect, it } from 'vitest'
import { resolveStageAgent } from '../agent-selection.ts'
import type { AiProviderConfig } from './types.ts'
import {
  PROVIDER_OPTIONS, REASONING_LADDER, UNIDENTIFIED_EFFORT_CEILING, agyStemEfforts, buildModelEffortArgs, catalogModelRows,
  effortOptionsForModel, getProviderOptions, isEligibleAgyStem, modelEfforts, parseDiscoverableKind,
  providerOptionsWithCatalog, type ModelCatalogSnapshot,
} from './provider-options.ts'

const haikuModels = ['haiku', 'claude-3-5-haiku', 'claude-3.5-haiku',
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001']

describe('stored provider compatibility', () => {
  it.each(haikuModels)('retains no-effort metadata and resolves every override layer safely for %s', (model) => {
    expect(getProviderOptions('claude').models.find((entry) => entry.value === model)?.noEffort).toBe(true)
    const provider: AiProviderConfig = {
      id: 'claude', name: 'Claude', kind: 'cli', providerKindId: 'claude', command: 'claude', model,
      effort: 'high', presets: [{ id: 'saved', model, effort: 'max' }], selectedPresetId: 'saved',
    }
    for (const stage of ['issue', 'pr', 'review', 'merge'] as const) {
      for (const parameters of [{}, { override: { effort: 'high' as const } },
        { oneShot: { model, effort: 'max' as const } }]) {
        const selected = resolveStageAgent([provider], { stage, ...parameters })
        expect(selected).toMatchObject({ model, effort: undefined })
        expect(buildModelEffortArgs('claude', selected.model, selected.effort)).toEqual(['--model', model])
      }
      const presetOnly = resolveStageAgent([{ ...provider, model: undefined, effort: undefined }], { stage })
      expect(presetOnly).toMatchObject({ model, effort: undefined })
    }
    expect(provider.effort).toBe('high')
  })

  it('encodes a saved agy model without inventing an effort-qualified slug', () => {
    expect(buildModelEffortArgs('agy', 'gemini-2.5-flash', 'high'))
      .toEqual(['--model', 'gemini-2.5-flash', '--effort', 'high'])
  })

  it.each(['ultracode', 'extra high', 'ultra'])('passes a custom wrapper effort %s through verbatim', (effort) => {
    expect(buildModelEffortArgs('claude', 'my-provider-model', effort))
      .toEqual(['--model', 'my-provider-model', '--effort', effort])
    expect(buildModelEffortArgs('codex', 'my-provider-model', effort))
      .toEqual(['--model', 'my-provider-model', '-c', `model_reasoning_effort=${effort}`])
  })
})

describe('merging a refreshed catalog over the built-in tables (#140)', () => {
  const at = '2026-11-22T00:00:00.000Z'
  const catalog: ModelCatalogSnapshot = { providers: {
    codex: { updatedAt: at, source: 'codex-debug-models', models: [
      { id: 'gpt-7-nova', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-6-luna' },
    ] },
    claude: { updatedAt: at, source: 'anthropic-models-api', models: [
      { id: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5', efforts: ['low', 'high'] },
      { id: 'claude-plain-9', efforts: [] },
    ] },
    antigravity: { updatedAt: at, source: 'agy-models', models: [
      { id: 'gemini-5-krypton', efforts: ['low', 'xhigh'] },
      { id: 'claude-opus-5-5', efforts: ['low'] },
      { id: 'gemini-pro-orchestrator-neon', efforts: ['low'] },
    ] },
  } }
  const merged = providerOptionsWithCatalog(catalog)
  const option = (kind: 'claude' | 'codex' | 'antigravity', value: string) =>
    merged[kind].models.find((entry) => entry.value === value)

  it('is the built-in table itself when nothing was refreshed', () => {
    expect(providerOptionsWithCatalog()).toBe(PROVIDER_OPTIONS)
    expect(providerOptionsWithCatalog({ providers: {} })).toEqual(PROVIDER_OPTIONS)
  })

  it('lists refreshed models first and keeps every built-in entry after them', () => {
    expect(merged.codex.models[0]).toEqual({ value: 'gpt-7-nova', label: 'gpt-7-nova', efforts: REASONING_LADDER })
    for (const builtIn of PROVIDER_OPTIONS.codex.models) expect(option('codex', builtIn.value)).toBeDefined()
    for (const builtIn of PROVIDER_OPTIONS.claude.models) expect(option('claude', builtIn.value)).toBeDefined()
    expect(merged.codex.efforts).toBe(PROVIDER_OPTIONS.codex.efforts)
  })

  it('keeps a built-in ceiling a source left unstated, and built-in no-effort metadata over any claim', () => {
    expect(option('codex', 'gpt-6-luna')?.efforts).toEqual(REASONING_LADDER.slice(0, 5))
    expect(option('claude', 'claude-haiku-4-5')).toEqual({ value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', noEffort: true })
    expect(option('claude', 'claude-plain-9')).toMatchObject({ noEffort: true })
    expect(modelEfforts('claude', 'claude-haiku-4-5', catalog)).toEqual([])
    expect(modelEfforts('claude', 'claude-opus-5-5', catalog)).toEqual(REASONING_LADDER.slice(0, 5))
    expect(modelEfforts('codex', 'gpt-7-nova', catalog)).toEqual(REASONING_LADDER)
    expect(modelEfforts('codex', 'gpt-9-unknown', catalog)).toBeUndefined()
  })

  it('expands Antigravity stems into no-effort slugs, Gemini only, never an orchestrator', () => {
    expect(merged.antigravity.models.slice(0, 2)).toEqual([
      { value: 'gemini-5-krypton-low', label: 'gemini-5-krypton (low)', noEffort: true },
      { value: 'gemini-5-krypton-xhigh', label: 'gemini-5-krypton (xhigh)', noEffort: true },
    ])
    expect(merged.antigravity.models.some((entry) => /claude|orchestrator/.test(entry.value))).toBe(false)
    expect(agyStemEfforts('gemini-5-krypton', catalog)).toEqual(['low', 'xhigh'])
    expect(agyStemEfforts('gemini-4-neon')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(agyStemEfforts('claude-opus-5-5', catalog)).toBeUndefined()
  })

  it.each([
    ['gemini-4-neon', true], ['Gemini-4-Hydrogen', true], ['gemini-3.8-flash', true],
    ['gemini-pro-orchestrator-neon', false], ['gemini-orchestrator', false], ['claude-opus-5-5', false],
    ['gpt-oss-120b', false], ['gemini-', false],
  ])('treats %s as an eligible Antigravity stem: %s', (stem, eligible) => {
    expect(isEligibleAgyStem(stem)).toBe(eligible)
  })

  it('narrows a preset\'s effort choices to what the chosen model accepts', () => {
    const levels = (model: string | undefined) => effortOptionsForModel(merged.codex, model).map((entry) => entry.value)
    expect(levels('gpt-6-luna')).toEqual(REASONING_LADDER.slice(0, 5))
    expect(levels('gpt-6.2-sol')).toEqual(REASONING_LADDER)
    expect(levels(undefined)).toEqual(REASONING_LADDER)
    expect(effortOptionsForModel(merged.claude, 'haiku')).toEqual([])
  })
})

describe('review follow-ups (#140)', () => {
  const at = '2026-11-22T00:00:00.000Z'

  it('caps a refreshed model the source listed without levels at max, never the provider\'s widest', () => {
    const catalog: ModelCatalogSnapshot = { providers: {
      codex: { updatedAt: at, source: 'codex-debug-models', models: [{ id: 'gpt-7-luna' }, { id: 'gpt-6.2-sol' }] },
    } }
    expect(modelEfforts('codex', 'gpt-7-luna', catalog)).toEqual(UNIDENTIFIED_EFFORT_CEILING)
    // A model MAO knows keeps its own ceiling: Sol still reaches ultra.
    expect(modelEfforts('codex', 'gpt-6.2-sol', catalog)).toEqual(REASONING_LADDER)
  })

  it.each([
    ['agy', 'antigravity'], ['AGY', 'antigravity'], ['Antigravity', 'antigravity'], [' codex ', 'codex'],
    ['Claude', 'claude'], ['gemini', undefined], ['', undefined], ['custom', undefined],
  ])('reads --provider %j as %j', (name, kind) => {
    expect(parseDiscoverableKind(name)).toBe(kind)
  })

  it('lists one row per model with its levels, for the CLI and the GUI alike', () => {
    const catalog: ModelCatalogSnapshot = { providers: {
      codex: { updatedAt: at, source: 'codex-debug-models', models: [{ id: 'gpt-7-nova', efforts: ['low', 'high'] }] },
      antigravity: { updatedAt: at, source: 'agy-models', models: [{ id: 'gemini-5-krypton', efforts: ['low', 'max'] }] },
    } }
    const codex = catalogModelRows('codex', catalog)
    expect(codex[0]).toEqual({ id: 'gpt-7-nova', efforts: ['low', 'high'] })
    expect(codex).toContainEqual({ id: 'gpt-6-luna', efforts: REASONING_LADDER.slice(0, 5) })
    expect(codex).toContainEqual({ id: 'gpt-6.2-sol', efforts: REASONING_LADDER })
    expect(catalogModelRows('claude')).toContainEqual({ id: 'haiku', efforts: [] })
    expect(catalogModelRows('claude')).toContainEqual({ id: 'claude-haiku-5-5', efforts: REASONING_LADDER.slice(0, 5) })
    expect(catalogModelRows('antigravity', catalog).slice(0, 2)).toEqual([
      { id: 'gemini-5-krypton', efforts: ['low', 'max'] },
      { id: 'gemini-4-neon', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ])
  })
})
