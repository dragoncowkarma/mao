import { describe, expect, it } from 'vitest'
import { MESSAGES } from '.'
import { KOREAN_CATALOG_LATIN, latinWords } from '../test/korean-latin'

/** The catalog's own tags, not text anyone reads. */
const TAG_FIELDS = new Set(['locale', 'dateLocales'])

/**
 * Every piece of text a catalog can produce, with its path. A message function is called with a stand-in
 * that reads as `§` whichever way the function uses it — interpolated, joined as a list, or compared — so
 * the words its template adds of its own are scanned too.
 */
function catalogTexts(value: unknown, path: string): [string, string][] {
  if (typeof value === 'string') return [[path, value]]
  if (typeof value === 'function') {
    const standIn = ['§']
    const output = (value as (...args: unknown[]) => unknown)(...Array(Math.max(1, value.length)).fill(standIn))
    return [[`${path}()`, String(output)]]
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => path !== 'ko' || !TAG_FIELDS.has(key))
      .flatMap(([key, entry]) => catalogTexts(entry, `${path}.${key}`))
  }
  return []
}

describe('the Korean catalog', () => {
  const texts = catalogTexts(MESSAGES.ko, 'ko')

  it('reaches every message, strings and functions alike', () => {
    // A walk that found nothing would pass the next test forever.
    expect(texts.length).toBeGreaterThan(150)
    expect(texts.some(([path]) => path === 'ko.common.activeCount()')).toBe(true)
  })

  it('leaves no English untranslated', () => {
    const untranslated = texts.flatMap(([path, text]) =>
      latinWords(text)
        .filter((word) => !KOREAN_CATALOG_LATIN.has(word))
        .map((word) => `${path}: ${word}`),
    )
    expect(untranslated).toEqual([])
  })

  it('still uses every Latin word it is allowed', () => {
    const used = new Set(texts.flatMap(([, text]) => latinWords(text)))
    expect([...KOREAN_CATALOG_LATIN].filter((word) => !used.has(word))).toEqual([])
  })
})
