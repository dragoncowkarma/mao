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
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { value: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
      { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'o3-mini', label: 'o3-mini' },
    ],
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
  claude: {
    models: [
      { value: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
      { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
      { value: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku', noEffort: true },
      { value: 'claude-3-opus', label: 'Claude 3 Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku', noEffort: true },
    ],
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ],
  },
  codex: {
    models: [
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
      { value: 'o1', label: 'o1' },
      { value: 'o3-mini', label: 'o3-mini' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    ],
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
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
