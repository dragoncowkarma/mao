import { describe, expect, it } from 'vitest'
import {
  FALLBACK_UI_LANGUAGE,
  LANGUAGE_PREFERENCES,
  UI_LANGUAGES,
  isLanguagePreference,
  resolveUiLanguage,
  tagLanguage,
} from './ui-language.ts'

describe('isLanguagePreference', () => {
  it('accepts system and every shipped language', () => {
    for (const value of ['system', ...UI_LANGUAGES]) expect(isLanguagePreference(value), value).toBe(true)
  })

  it('rejects a case variant, a regional tag, an unshipped language and every non-string', () => {
    // `mao config set-language` validates with this, so it must be exact: the store holds what the CLI
    // accepted, and a `KO` or `ko-KR` written there would read back as "not a language" in the GUI.
    for (const value of ['', 'System', 'EN', 'Ko', 'ko-KR', 'fr', 42, null, undefined, {}, ['en']]) {
      expect(isLanguagePreference(value), JSON.stringify(value) ?? String(value)).toBe(false)
    }
  })

  it('lists system first, then each language exactly once', () => {
    expect(LANGUAGE_PREFERENCES).toEqual(['system', 'en', 'ko'])
  })
})

describe('tagLanguage', () => {
  it('names the shipped language a tag belongs to, by primary subtag', () => {
    for (const tag of ['ko', 'KO', 'ko-KR', 'ko_KR', 'ko-Kore-KR']) expect(tagLanguage(tag), tag).toBe('ko')
    for (const tag of ['en', 'en-GB', 'EN-us']) expect(tagLanguage(tag), tag).toBe('en')
  })

  it('names nothing for an unshipped language, a lookalike prefix or a non-string', () => {
    for (const tag of ['ja-JP', 'kok-IN', 'eng', '', 42, null, undefined]) {
      expect(tagLanguage(tag), String(tag)).toBeUndefined()
    }
  })
})

describe('resolveUiLanguage', () => {
  it('uses an explicitly chosen language whatever the OS prefers', () => {
    expect(resolveUiLanguage('en', ['ko-KR'])).toBe('en')
    expect(resolveUiLanguage('ko', ['en-US'])).toBe('ko')
    expect(resolveUiLanguage('ko', [])).toBe('ko')
  })

  it('follows the OS for system', () => {
    expect(resolveUiLanguage('system', ['ko-KR', 'en-US'])).toBe('ko')
    expect(resolveUiLanguage('system', ['en-US', 'ko-KR'])).toBe('en')
  })

  it('matches the primary subtag, ignoring case and region, with either separator', () => {
    for (const tag of ['ko', 'KO', 'ko-KR', 'KO-kr', 'ko_KR', 'ko-Kore-KR']) {
      expect(resolveUiLanguage('system', [tag]), tag).toBe('ko')
    }
  })

  it('does not match a tag that merely starts with a shipped language code', () => {
    // Konkani and an English-sounding private tag: a prefix match would hand both a catalog they did
    // not ask for. Korean is listed after each so the fallback alone cannot satisfy the assertion.
    expect(resolveUiLanguage('system', ['kok-IN', 'ko-KR'])).toBe('ko')
    expect(resolveUiLanguage('system', ['kok-IN'])).toBe(FALLBACK_UI_LANGUAGE)
    expect(resolveUiLanguage('system', ['eng', 'ko'])).toBe('ko')
  })

  it('takes the first supported language in the OS order, not only the first entry', () => {
    expect(resolveUiLanguage('system', ['ja-JP', 'ko-KR', 'en-US'])).toBe('ko')
    expect(resolveUiLanguage('system', ['ja-JP', 'zh-Hans-CN', 'en-GB', 'ko'])).toBe('en')
  })

  it('falls back to English when no preferred language has a catalog', () => {
    expect(FALLBACK_UI_LANGUAGE).toBe('en')
    expect(resolveUiLanguage('system', ['ja-JP', 'zh-Hans-CN'])).toBe('en')
    expect(resolveUiLanguage('system', [])).toBe('en')
    expect(resolveUiLanguage('system', [''])).toBe('en')
  })

  it('treats a stored value it cannot use as system rather than trusting it', () => {
    // config.json is unvalidated JSON. Each of these has to resolve exactly as 'system' does on this
    // OS: returning the raw value would hand the renderer a catalog key that does not exist.
    for (const stored of ['fr', 'KO', 'System', '', 42, null, undefined, { ko: true }, ['ko']]) {
      expect(resolveUiLanguage(stored, ['ko-KR']), JSON.stringify(stored) ?? String(stored)).toBe('ko')
    }
  })

  it('does not take a case variant or a regional tag as an explicit choice', () => {
    // The witness the Korean OS above cannot be: on an English OS, trusting `KO` or `ko-KR` as a choice
    // would render Korean, while treating it as 'system' — what the store's type says it is — renders
    // English. Only exact values are choices; `mao config set-language` writes nothing else.
    expect(resolveUiLanguage('KO', ['en-US'])).toBe('en')
    expect(resolveUiLanguage('ko-KR', ['en-US'])).toBe('en')
    expect(resolveUiLanguage('ko_KR', ['en-US'])).toBe('en')
  })
})
