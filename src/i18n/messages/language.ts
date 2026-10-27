import type { UiLanguage } from '../../../core/ui-language'

/**
 * The language pickers themselves — the sidebar menu's and Global settings'. The languages' own names
 * are not here: they are `LANGUAGE_NAMES`, which stay the same whichever language is showing.
 */
const en = {
  label: 'Language',
  system: 'System',
  /** The sidebar's option for `'system'`, naming the language it currently resolves to. */
  systemResolved: (language: string) => `System (${language})`,
  hint: (language: string) =>
    `"System" follows your OS's preferred languages — currently ${language}. A language MAO has no ` +
    'translation for falls back to English.',
  saveFailed: (reason: string) =>
    `The language changed for this session, but the preference could not be saved: ${reason}`,
}

const ko: typeof en = {
  label: '언어',
  system: '시스템',
  systemResolved: (language) => `시스템 (${language})`,
  hint: (language) =>
    `"시스템"은 OS의 선호 언어를 따릅니다(현재 ${language}). MAO에 번역이 없는 언어는 영어로 표시됩니다.`,
  saveFailed: (reason) => `이번 세션의 언어는 바뀌었지만 설정을 저장하지 못했습니다: ${reason}`,
}

export const language: Record<UiLanguage, typeof en> = { en, ko }
