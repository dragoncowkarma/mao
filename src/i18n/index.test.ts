import { describe, expect, it } from 'vitest'
import { MESSAGES, WordedError, messagesFor, wordIn } from '.'

describe('messagesFor', () => {
  it('puts the OS’s own regional tags for the language before the bare language', () => {
    expect(messagesFor('en', ['en-GB', 'ko-KR', 'en-AU']).dateLocales).toEqual(['en-GB', 'en-AU', 'en'])
    expect(messagesFor('ko', ['en-GB', 'ko-KR']).dateLocales).toEqual(['ko-KR', 'ko'])
  })

  it('is the plain catalog when the OS has no tag for the language', () => {
    // A Korean UI on an English OS formats dates the Korean way — the English tags are not its language.
    expect(messagesFor('ko', ['en-US', 'ja-JP'])).toBe(MESSAGES.ko)
    expect(MESSAGES.ko.dateLocales).toEqual(['ko'])
  })

  it('drops a tag Intl would reject, rather than let every date on the board throw', () => {
    // `ko_KR` names Korean to the resolver, but it is not BCP 47, and `toLocaleString(['ko_KR'])` throws.
    expect(messagesFor('ko', ['ko_KR', 'ko-KR']).dateLocales).toEqual(['ko-KR', 'ko'])
    expect(() => new Date(0).toLocaleString([...messagesFor('ko', ['ko_KR']).dateLocales])).not.toThrow()
  })

  it('changes nothing but the date locales', () => {
    const regional = messagesFor('en', ['en-GB'])
    expect({ ...regional, dateLocales: MESSAGES.en.dateLocales }).toEqual(MESSAGES.en)
  })
})

describe('wordIn', () => {
  it('shows text that arrived already worded exactly as it came, in any language', () => {
    expect(wordIn('disk is full', MESSAGES.en)).toBe('disk is full')
    expect(wordIn('disk is full', MESSAGES.ko)).toBe('disk is full')
  })

  it('words MAO’s own text in whichever catalog it is rendered with', () => {
    const wording = { word: (m: typeof MESSAGES.en) => m.sidebar.globalSettings }
    expect(wordIn(wording, MESSAGES.en)).toBe(MESSAGES.en.sidebar.globalSettings)
    expect(wordIn(wording, MESSAGES.ko)).toBe(MESSAGES.ko.sidebar.globalSettings)
  })
})

describe('WordedError', () => {
  it('carries its message in the language it was thrown in, and a wording for any other', () => {
    const error = new WordedError((m) => m.app.queueOutcome.restartRequired, MESSAGES.ko)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(MESSAGES.ko.app.queueOutcome.restartRequired)
    expect(wordIn(error.wording, MESSAGES.en)).toBe(MESSAGES.en.app.queueOutcome.restartRequired)
  })
})
