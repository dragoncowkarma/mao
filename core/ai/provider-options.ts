import type { AiEffort, ProviderKindId } from './types.ts'

export interface ModelOption {
  value: string
  label: string
  /** If true, effort selection is not applicable for this model */
  noEffort?: boolean
}

export interface EffortOption {
  value: AiEffort
  label: string
}

export interface ProviderOptions {
  models: ModelOption[]
  efforts: EffortOption[]
}

export const PROVIDER_OPTIONS: Record<ProviderKindId, ProviderOptions> = {
  antigravity: {
    models: [
      { value: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash High' },
      { value: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash Medium' },
      { value: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash Low' },
      { value: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash High' },
      { value: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash Medium' },
      { value: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash Low' },
      { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro High' },
      { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro Low' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 Thinking' },
      { value: 'gpt-oss-120b-medium', label: 'GPT OSS 120B Medium' },
    ],
    // antigravity model strings already encode effort, so no separate effort dropdown
    efforts: [],
  },
  claude: {
    models: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku', noEffort: true },
    ],
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'X-High' },
      { value: 'max', label: 'Max' },
      { value: 'ultracode', label: 'Ultracode' },
    ],
  },
  codex: {
    models: [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { value: 'gpt-5.5', label: 'GPT-5.5' },
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    ],
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'extra high', label: 'Extra High' },
      { value: 'max', label: 'Max (5.6 only)' },
      { value: 'ultra', label: 'Ultra (Sol/Terra only)' },
    ],
  },
  custom: {
    models: [],
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'X-High' },
      { value: 'max', label: 'Max' },
    ],
  },
}

/** Returns model options for a given provider kind. Falls back to custom if unknown. */
export function getProviderOptions(kindId?: ProviderKindId): ProviderOptions {
  return kindId ? (PROVIDER_OPTIONS[kindId] ?? PROVIDER_OPTIONS.custom) : PROVIDER_OPTIONS.custom
}
