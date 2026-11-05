const MINUTE = 60_000
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const RESET = /try\s+again\s+at\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+)?(\d{1,2}):(\d{2})(?!\d)(?:\s*([ap])\.?m\b)?/gi

/** Resolve local CLI wall-clock resets using the start day, including the repeated DST hour. */
export function parseRetryAfter(text: string, startedAt: Date, _now = new Date()): Date | null {
  const matches = [...text.matchAll(RESET)]
  const match = matches.at(-1)
  if (!match || !Number.isFinite(startedAt.getTime())) return null
  let hour = Number(match[4])
  const minute = Number(match[5])
  if (minute > 59 || hour > 23 || (match[6] && (hour < 1 || hour > 12))) return null
  if (match[6]) hour = hour % 12 + (match[6].toLowerCase() === 'p' ? 12 : 0)
  const year = match[3] ? Number(match[3]) : startedAt.getFullYear()
  const month = match[1] ? MONTHS.indexOf(match[1].toLowerCase()) : startedAt.getMonth()
  const day = match[2] ? Number(match[2]) : startedAt.getDate()
  let reset = new Date(year, month, day, hour, minute)
  if (reset.getFullYear() !== year || reset.getMonth() !== month || reset.getDate() !== day ||
      reset.getHours() !== hour || reset.getMinutes() !== minute) return null
  if (!match[3]) {
    const startMinute = Math.floor(startedAt.getTime() / MINUTE) * MINUTE
    if (reset.getTime() < startMinute) {
      // Offset changes need not be an hour (e.g. Lord Howe). Search the second occurrence.
      for (let delta = 1; delta <= 180; delta++) {
        const candidate = new Date(reset.getTime() + delta * MINUTE)
        if (candidate.getFullYear() === year && candidate.getMonth() === month &&
            candidate.getDate() === day && candidate.getHours() === hour &&
            candidate.getMinutes() === minute && candidate.getTime() >= startMinute) {
          reset = candidate
          break
        }
      }
    }
    if (reset.getTime() < startMinute) reset = new Date(year, month, day + 1, hour, minute)
  }
  return new Date(reset.getTime() + MINUTE)
}

/** Provider limits pause the provider; individual CLI timeouts consume the event retry budget. */
export function classifyProviderFailure(text: string, startedAt: Date, now = new Date()): {
  retryAfter: Date
  reason: string
  scope: 'provider' | 'event'
} | null {
  const lower = text.toLowerCase()
  const provider = ['individual quota reached', 'monthly spend limit', 'rate limit exceeded',
    'resource_exhausted', 'too many requests', 'hit your usage limit'].some((p) => lower.includes(p))
  const event = ['timeout waiting for response', 'no_tool_withdrawn'].some((p) => lower.includes(p))
  if (!provider && !event) return null
  const duration = /resets?\s+in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(text)
  let retryAfter: Date | null = null
  if (duration && duration.slice(1).some(Boolean)) {
    retryAfter = new Date(now.getTime() + (Number(duration[1] ?? 0) * 3600 +
      Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0) + 60) * 1000)
  } else {
    retryAfter = parseRetryAfter(text, startedAt, now)
  }
  const spend = /monthly spend limit|hit your usage limit/i.test(text)
  return {
    retryAfter: retryAfter ?? new Date(now.getTime() + (spend ? 24 : 1) * 3600_000),
    reason: provider ? 'provider-limit' : 'event-timeout',
    scope: provider ? 'provider' : 'event',
  }
}

/** Status prints the operator's local clock alongside the durable UTC deadline. */
export function describeRetryAfter(date: Date): string {
  return `${date.toLocaleString()} (${date.toISOString()})`
}
