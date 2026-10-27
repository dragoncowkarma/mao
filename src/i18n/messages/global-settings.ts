import type { AiApiFormat, AiEffort, AiProviderKind, ProviderKindId } from '../../../core/ai/types'
import type { ThemePreference } from '../../../core/store'
import type { UiLanguage } from '../../../core/ui-language'

/**
 * What `src/components/GlobalSettings.tsx` shows.
 *
 * The model names in the provider pickers and the effort names in each preset row's picker are not
 * here: they are core's `PROVIDER_OPTIONS` labels, shown as they come. Neither is the reason main gives
 * for refusing a save, which is core's own text (see `src/i18n/index.ts`).
 */
const en = {
  heading: 'Global settings',
  description: 'Applies across every registered project.',
  appearance: 'Appearance',
  /** The theme toggles, keyed like `ThemePreference`. */
  themeOptions: {
    light: 'Light',
    dark: 'Dark',
    system: 'System',
  } satisfies Record<ThemePreference, string>,
  /** Quotes `themeOptions.system` — keep the two in step. */
  themeSystemHint: '"System" follows your OS light/dark setting and updates automatically if it changes.',
  githubToken: 'GitHub token',
  /** A classic token's prefix: a format hint, so it is the same in every language. */
  githubTokenPlaceholder: 'ghp_...',
  aiProviders: 'AI Providers',
  addProvider: '+ Add provider',
  noProviders: 'No AI providers registered yet.',
  saveChanges: 'Save changes',
  saved: 'Saved',
  /**
   * Why Save was refused before anything reached the main process. Every one that applies is joined
   * with a space into a single line, so each has to be a complete sentence.
   */
  validation: {
    /** Stands in for a blank name in `apiKeyMissing` and `commandMissing`. */
    unnamedProvider: 'Unnamed provider',
    nameRequired: 'Every AI provider needs a name.',
    duplicateName: (name: string) => `Duplicate provider name: "${name}".`,
    apiKeyMissing: (provider: string) => `"${provider}" is an API provider but has no API key.`,
    commandMissing: (provider: string) => `"${provider}" is a CLI provider but has no command.`,
  },

  // One provider's card.
  providerNamePlaceholder: 'Name',
  /** How MAO reaches a provider, keyed like `AiProviderKind`. Technical terms, kept as written. */
  kindOptions: { api: 'API (BYOK)', cli: 'CLI' } satisfies Record<AiProviderKind, string>,
  /** The request format an API provider speaks, keyed like `AiApiFormat`. */
  apiFormatOptions: {
    anthropic: 'Anthropic',
    openai: 'OpenAI-compatible',
  } satisfies Record<AiApiFormat, string>,
  apiKeyPlaceholder: 'API key',
  commandPlaceholder: 'Command (e.g. claude)',
  /**
   * Which CLI a CLI provider drives, keyed like `ProviderKindId`. The picker lists these keys in the
   * order written here, so every language keeps it. Antigravity, Claude and Codex are product names and
   * stay as they are; only `custom` is a word.
   */
  toolOptions: {
    antigravity: 'Antigravity (agy)',
    claude: 'Claude',
    codex: 'Codex',
    custom: 'Custom',
  } satisfies Record<ProviderKindId, string>,
  /**
   * The card's model picker's empty choice: the provider names no model of its own, so core falls back
   * to its active preset's model, and only without one does the tool run its own default.
   */
  modelDefault: 'Model: default',
  modelPlaceholder: 'Model (optional)',
  /** The empty choice of the card's effort picker and of each preset row's: no effort is set. */
  effortUnset: 'Effort: —',
  /**
   * The card's own effort levels. Identical to English in every language on purpose: they mirror the
   * labels core's `PROVIDER_OPTIONS` gives each preset row's effort picker, which are shown as they come
   * and not localized anywhere, so translating these would name one level two ways on the same card.
   */
  effortOptions: {
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'X-High',
    max: 'Max',
  } satisfies Partial<Record<AiEffort, string>>,
  /** Removes the provider on its card, or the preset in its row. */
  remove: 'Remove',
  allowedStages: 'Allowed stages:',
  allStagesUnrestricted: '(all stages — unrestricted)',
  /** `stages` are names from `common.stages`, already in this language. */
  restrictedTo: (stages: string[]) => `restricted to: ${stages.join(', ')}`,
  /** The toggle that shows or hides the card's presets. */
  presets: 'Model / Effort presets',
  addPreset: '+ Add preset',
  /** Quotes `addPreset` — keep the two in step. */
  noPresets: 'No presets yet. Click "+ Add preset" to add one.',

  // One row of a card's presets.
  setActivePreset: 'Set as active preset',
  /** The row's model picker's empty choice. */
  selectModel: '— select model —',
  modelIdPlaceholder: 'Model ID (e.g. gpt-4o)',
  /** Shown in place of the effort picker when the chosen model takes no effort (`noEffort`). */
  noEffort: 'No effort',
}

const ko: typeof en = {
  heading: '전역 설정',
  description: '등록된 모든 프로젝트에 적용됩니다.',
  appearance: '화면 모드',
  themeOptions: {
    light: '라이트',
    dark: '다크',
    system: '시스템',
  },
  themeSystemHint: '"시스템"은 OS의 라이트/다크 설정을 따르며, 그 설정이 바뀌면 자동으로 함께 바뀝니다.',
  githubToken: 'GitHub 토큰',
  githubTokenPlaceholder: 'ghp_...',
  aiProviders: 'AI 프로바이더',
  addProvider: '+ 프로바이더 추가',
  noProviders: '아직 등록된 AI 프로바이더가 없습니다.',
  saveChanges: '변경 사항 저장',
  saved: '저장됨',
  validation: {
    unnamedProvider: '이름 없는 프로바이더',
    nameRequired: '모든 AI 프로바이더에는 이름이 있어야 합니다.',
    duplicateName: (name) => `프로바이더 이름이 중복됩니다: "${name}".`,
    apiKeyMissing: (provider) => `API 프로바이더 "${provider}"에 API 키가 없습니다.`,
    commandMissing: (provider) => `CLI 프로바이더 "${provider}"에 명령어가 없습니다.`,
  },

  providerNamePlaceholder: '이름',
  kindOptions: { api: 'API (BYOK)', cli: 'CLI' },
  apiFormatOptions: {
    anthropic: 'Anthropic',
    openai: 'OpenAI 호환',
  },
  apiKeyPlaceholder: 'API 키',
  commandPlaceholder: '명령어 (예: claude)',
  toolOptions: {
    antigravity: 'Antigravity (agy)',
    claude: 'Claude',
    codex: 'Codex',
    custom: '사용자 지정',
  },
  modelDefault: '모델: 기본값',
  modelPlaceholder: '모델 (선택 사항)',
  effortUnset: '추론 강도: —',
  /** The same object as English — see `en.effortOptions` for why. */
  effortOptions: en.effortOptions,
  remove: '제거',
  allowedStages: '허용 단계:',
  allStagesUnrestricted: '(모든 단계 — 제한 없음)',
  restrictedTo: (stages) => `${stages.join(', ')} 단계로 제한됨`,
  presets: '모델 / 추론 강도 프리셋',
  addPreset: '+ 프리셋 추가',
  noPresets: '아직 프리셋이 없습니다. "+ 프리셋 추가"를 클릭해 추가하십시오.',

  setActivePreset: '활성 프리셋으로 설정',
  selectModel: '— 모델 선택 —',
  modelIdPlaceholder: '모델 ID (예: gpt-4o)',
  noEffort: '추론 강도 없음',
}

export const globalSettings: Record<UiLanguage, typeof en> = { en, ko }
