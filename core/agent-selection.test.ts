import { describe, expect, it } from 'vitest'
import { eligibleAgentsForRun, isStageEligible, previewStageAgent, resolveStageAgent } from './agent-selection.ts'
import type { AgentStage, AiProviderConfig } from './ai/types.ts'

function makeProvider(id: string, allowedStages?: AgentStage[]): AiProviderConfig {
  return {
    id,
    name: id,
    kind: 'api',
    apiFormat: 'anthropic',
    apiKey: 'test-key',
    model: `${id}-model`,
    ...(allowedStages ? { allowedStages } : {}),
  }
}

const a = makeProvider('agent-a')
const b = makeProvider('agent-b')

describe('isStageEligible', () => {
  it('treats an absent or empty allowedStages as "any stage"', () => {
    expect(isStageEligible(a, 'merge')).toBe(true)
    expect(isStageEligible({ ...a, allowedStages: [] }, 'merge')).toBe(true)
    expect(isStageEligible({ ...a, allowedStages: ['review'] }, 'merge')).toBe(false)
    expect(isStageEligible({ ...a, allowedStages: ['review'] }, 'review')).toBe(true)
  })
})

describe('eligibleAgentsForRun', () => {
  it('offers everyone when the task has not run a stage yet', () => {
    expect(eligibleAgentsForRun([a, b], 'pr').map((p) => p.id)).toEqual(['agent-a', 'agent-b'])
  })

  it('drops the agent that ran the previous stage across a role boundary', () => {
    const options = eligibleAgentsForRun([a, b], 'review', { stage: 'pr', agentId: 'agent-a' })
    expect(options.map((p) => p.id)).toEqual(['agent-b'])
  })

  it('keeps the previous agent when the same role simply carries on (issue -> pr)', () => {
    const options = eligibleAgentsForRun([a, b], 'pr', { stage: 'issue', agentId: 'agent-a' })
    expect(options.map((p) => p.id)).toEqual(['agent-a', 'agent-b'])
  })

  it('keeps the only option rather than offering none at all', () => {
    const options = eligibleAgentsForRun([a], 'review', { stage: 'pr', agentId: 'agent-a' })
    expect(options.map((p) => p.id)).toEqual(['agent-a'])
  })

  it('never offers a provider whose allowedStages excludes the stage', () => {
    const reviewOnly = makeProvider('agent-r', ['review'])
    expect(eligibleAgentsForRun([a, reviewOnly], 'merge').map((p) => p.id)).toEqual(['agent-a'])
  })

  // The dropdown must never present a choice the engine would then reject — the whole point of
  // sharing this module with the renderer.
  it('only offers picks that resolveStageAgent() accepts', () => {
    const providers = [a, b, makeProvider('agent-r', ['review'])]
    const stages: AgentStage[] = ['issue', 'pr', 'review', 'merge']
    for (const stage of stages) {
      for (const previous of [undefined, { stage: 'pr' as AgentStage, agentId: 'agent-a' }]) {
        for (const option of eligibleAgentsForRun(providers, stage, previous)) {
          expect(() =>
            resolveStageAgent(providers, { stage, previous, oneShot: { providerId: option.id } }),
          ).not.toThrow()
        }
      }
    }
  })
})

describe('resolveStageAgent one-shot handling', () => {
  it('outranks both a stored providerId and a stored role pin', () => {
    const c = makeProvider('agent-c')
    const chosen = resolveStageAgent([a, b, c], {
      stage: 'review',
      override: { providerId: 'agent-a', roles: { reviewer: 'agent-b' } },
      oneShot: { providerId: 'agent-c' },
    })
    expect(chosen.id).toBe('agent-c')
  })

  it('applies one-shot model/effort over the stored override, on a copy', () => {
    const stored = { ...a }
    const chosen = resolveStageAgent([stored, b], {
      stage: 'issue',
      override: { model: 'pinned', effort: 'low' },
      oneShot: { model: 'once', effort: 'max' },
    })
    expect(chosen.model).toBe('once')
    expect(chosen.effort).toBe('max')
    expect(stored.model).toBe('agent-a-model')
    expect(stored.effort).toBeUndefined()
  })

  it('falls back to the stored override for fields the one-shot leaves unset', () => {
    const chosen = resolveStageAgent([a, b], {
      stage: 'issue',
      override: { model: 'pinned', effort: 'low' },
      oneShot: { providerId: 'agent-b' },
    })
    expect(chosen).toMatchObject({ id: 'agent-b', model: 'pinned', effort: 'low' })
  })

  it('fails loudly rather than silently substituting another agent', () => {
    expect(() =>
      resolveStageAgent([a, b], {
        stage: 'review',
        previous: { stage: 'pr', agentId: 'agent-a' },
        oneShot: { providerId: 'agent-a' },
      }),
    ).toThrow(/maker-checker requires a different/i)
  })
})

describe('no-effort models', () => {
  // Regression: every layer of the preference chain can contribute an effort, and none of them knows
  // which model it lands on — so a no-effort model used to still resolve one, which
  // core/ai/cli-provider.ts turns into a literal `--effort` flag the invocation does not accept.
  const claudeCli: AiProviderConfig = {
    id: 'agent-claude',
    name: 'Primary Worker',
    kind: 'cli',
    command: 'claude',
    providerKindId: 'claude',
    effort: 'high',
  }

  it('drops a provider-level effort when the resolved model takes none', () => {
    const chosen = resolveStageAgent([claudeCli], { stage: 'issue', oneShot: { model: 'haiku' } })
    expect(chosen).toMatchObject({ model: 'haiku', effort: undefined })
  })

  it('drops an explicitly requested effort too, rather than passing a flag the model rejects', () => {
    const chosen = resolveStageAgent([claudeCli], {
      stage: 'issue',
      override: { model: 'haiku', effort: 'max' },
    })
    expect(chosen.effort).toBeUndefined()
  })

  it('still resolves an effort for a model that accepts one', () => {
    expect(resolveStageAgent([claudeCli], { stage: 'issue', oneShot: { model: 'opus' } }).effort).toBe('high')
  })

  it('leaves providers with no model catalog (API providers) alone', () => {
    const api = { ...makeProvider('agent-api'), effort: 'high' as const }
    expect(resolveStageAgent([api], { stage: 'issue' }).effort).toBe('high')
  })
})

describe('previewStageAgent', () => {
  it('mirrors resolveStageAgent for a configuration that resolves', () => {
    const params = { stage: 'pr' as AgentStage, previous: { stage: 'issue' as AgentStage, agentId: 'agent-a' } }
    expect(previewStageAgent([a, b], params)?.id).toBe(resolveStageAgent([a, b], params).id)
  })

  it('returns undefined instead of throwing, so a card can render before anything is configured', () => {
    expect(previewStageAgent([], { stage: 'issue' })).toBeUndefined()
    expect(previewStageAgent([makeProvider('agent-r', ['review'])], { stage: 'merge' })).toBeUndefined()
    expect(previewStageAgent([a], { stage: 'issue', override: { providerId: 'nobody' } })).toBeUndefined()
  })
})
