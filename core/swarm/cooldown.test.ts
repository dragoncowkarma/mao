import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyProviderFailure, parseRetryAfter } from './cooldown.ts'

afterEach(() => vi.unstubAllEnvs())

describe('provider reset parsing', () => {
  it('uses the start day even when the process ends after midnight', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(parseRetryAfter('try again at 1:17 PM.', new Date('2026-11-03T12:00:00Z'))?.toISOString())
      .toBe('2026-11-03T13:18:00.000Z')
    expect(parseRetryAfter('try again at 00:15', new Date('2026-11-03T23:59:00Z'))?.toISOString())
      .toBe('2026-11-04T00:16:00.000Z')
  })

  it('accepts dates, ordinal suffixes, punctuation, and the final amendment', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(parseRetryAfter('try again at 1:17 PM. try again at Nov 3rd, 2026 2:32 PM.',
      new Date('2026-11-02T00:00:00Z'))?.toISOString()).toBe('2026-11-03T14:33:00.000Z')
  })

  it.each(['25:00', '1:99', '0:10 PM', '13:10 AM', 'Feb 30th, 2026 1:00 PM'])
  ('rejects invalid wall clock %s', (clock) => {
    expect(parseRetryAfter(`try again at ${clock}`, new Date())).toBeNull()
  })

  it('uses minute precision and preserves an explicitly dated past deadline for healing', () => {
    vi.stubEnv('TZ', 'UTC')
    expect(parseRetryAfter('try again at 12:00', new Date('2026-11-03T12:00:59Z'))?.toISOString())
      .toBe('2026-11-03T12:01:00.000Z')
    expect(parseRetryAfter('try again at Nov 2nd, 2026 12:00', new Date('2026-11-03T12:00:00Z'))
      ?.toISOString()).toBe('2026-11-02T12:01:00.000Z')
  })

  it('selects the second DST occurrence before rolling to tomorrow', () => {
    vi.stubEnv('TZ', 'America/New_York')
    expect(parseRetryAfter('try again at 1:30 AM', new Date('2026-11-01T05:45:00Z'))?.toISOString())
      .toBe('2026-11-01T06:31:00.000Z')
  })

  it('takes tomorrow own offset across a DST change', () => {
    vi.stubEnv('TZ', 'America/New_York')
    expect(parseRetryAfter('try again at 1:30 AM', new Date('2026-10-31T18:00:00Z'))?.toISOString())
      .toBe('2026-11-01T05:31:00.000Z')
  })
})

describe('failure classification', () => {
  const start = new Date('2026-11-03T12:00:00Z')
  it('uses a day for spend limits and an hour for rate limits', () => {
    expect(classifyProviderFailure('monthly spend limit', start, start)?.retryAfter.toISOString())
      .toBe('2026-11-04T12:00:00.000Z')
    expect(classifyProviderFailure('rate limit exceeded', start, start)?.retryAfter.toISOString())
      .toBe('2026-11-03T13:00:00.000Z')
  })
  it('prefers explicit reset over the spend fallback', () => {
    expect(classifyProviderFailure('hit your usage limit, resets in 1h2m3s', start, start)
      ?.retryAfter.toISOString()).toBe('2026-11-03T13:03:03.000Z')
  })
  it('distinguishes event retries and provider availability', () => {
    expect(classifyProviderFailure('timeout waiting for response', start, start)?.scope).toBe('event')
    expect(classifyProviderFailure('resource_exhausted', start, start)?.scope).toBe('provider')
    expect(classifyProviderFailure('syntax error', start, start)).toBeNull()
  })
})
