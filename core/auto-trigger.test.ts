import { describe, expect, it } from 'vitest'
import { parseAgentOverride } from './auto-trigger.ts'

describe('parseAgentOverride', () => {
  it('parses provider, model, and effort directives case-insensitively', () => {
    expect(parseAgentOverride('Please fix this.\n/PROVIDER codex\n/model gpt-5.6\n/effort HIGH')).toEqual({
      providerId: 'codex', model: 'gpt-5.6', effort: 'high',
    })
  })

  it('returns undefined when there is no directive and rejects invalid effort', () => {
    expect(parseAgentOverride('No routing preference.')).toBeUndefined()
    expect(() => parseAgentOverride('/effort maximum')).toThrow(/Invalid \/effort directive/)
  })
})
