import { describe, expect, it } from 'vitest'
import { resolveStageAgent } from '../agent-selection.ts'
import type { AiProviderConfig } from './types.ts'
import { buildModelEffortArgs, getProviderOptions } from './provider-options.ts'

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
