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

/** Lowest-to-highest dispatch effort; legacy stored spellings fold onto this ladder. */
export const REASONING_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningLevel = (typeof REASONING_LADDER)[number]

const REASONING_ALIASES: Record<string, ReasoningLevel> = {
  low: 'low', 낮음: 'low', light: 'low', medium: 'medium', 중간: 'medium',
  high: 'high', 높음: 'high', thinking: 'high', xhigh: 'xhigh',
  '매우 높음': 'xhigh', 매우높음: 'xhigh', 엑스트라: 'xhigh', 'extra high': 'xhigh',
  max: 'max', 최대: 'max', ultracode: 'max', ultra: 'ultra', 울트라: 'ultra',
}

/** Unknown labels resolve to medium; excessive requests clamp to the model's supported ceiling. */
export function resolveReasoning(reasoning: string, supported: readonly string[] = REASONING_LADDER): ReasoningLevel {
  const key = reasoning.toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim().replace(/^[.!?,;:()\[\]]+|[.!?,;:()\[\]]+$/g, '').trim()
  const wanted = Object.hasOwn(REASONING_ALIASES, key) ? REASONING_ALIASES[key] : 'medium'
  const allowed = REASONING_LADDER.filter((level) => supported.includes(level))
  const ceiling = REASONING_LADDER.indexOf(wanted)
  return [...allowed].reverse().find((level) => REASONING_LADDER.indexOf(level) <= ceiling) ?? allowed[0] ?? wanted
}

/** Shared flag construction: Codex reads reasoning from a config key, never an --effort flag. */
export function buildModelEffortArgs(command: string, model?: string, effort?: string, args: readonly string[] = []): string[] {
  const result: string[] = []
  const effectiveModel = command === 'agy' && model && effort
    ? `${model.replace(/-(low|medium|high)$/, '')}-${resolveReasoning(effort, REASONING_LADDER.slice(0, 3))}`
    : model
  if (effectiveModel && !args.includes('--model') && !args.includes('-m')) result.push('--model', effectiveModel)
  if (effort && command !== 'agy' && !args.includes('--effort')) {
    if (command === 'codex') {
      const hasConfig = args.some((arg) => /^model_reasoning_effort\s*=/.test(arg))
      if (!hasConfig) result.push('-c', `model_reasoning_effort=${resolveReasoning(effort,
        model === 'gpt-5.6-sol' || model === 'gpt-5.6-terra' ? REASONING_LADDER : REASONING_LADDER.slice(0, 5))}`)
    } else {
      result.push('--effort', command === 'claude' ? resolveReasoning(effort, REASONING_LADDER.slice(0, 5)) : effort)
    }
  }
  return result
}

const efforts = (levels: readonly AiEffort[]): EffortOption[] => levels.map((value) => ({ value, label: value }))

export const PROVIDER_OPTIONS: Record<ProviderKindId, ProviderOptions> = {
  antigravity: {
    models: ['gemini-4-argon', 'gemini-3.8-flash'].flatMap((stem) =>
      ['low', 'medium', 'high'].map((effort) => ({ value: `${stem}-${effort}`, label: `${stem} (${effort})`, noEffort: true }))),
    efforts: [], // agy encodes effort in its model slug
  },
  claude: {
    models: [
      ...['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'].map((value) => ({ value, label: value })),
      { value: 'haiku', label: 'Haiku (legacy)', noEffort: true },
    ],
    efforts: efforts(REASONING_LADDER.slice(0, 5)),
  },
  codex: {
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((value) => ({ value, label: value })),
    efforts: efforts(REASONING_LADDER),
  },
  custom: { models: [], efforts: efforts(REASONING_LADDER) },
}

/**
 * The tool identity worth showing next to a provider's name. A provider's `name` is operator-chosen
 * and needn't say which CLI it drives ("Primary Reviewer" tells you nothing about Codex), so cards
 * pair the two — but 'custom' (and an unset kind) adds nothing the name doesn't already say.
 */
export function providerToolKind(provider: { providerKindId?: ProviderKindId }): ProviderKindId | undefined {
  return provider.providerKindId && provider.providerKindId !== 'custom' ? provider.providerKindId : undefined
}

/** A provider's name paired with its tool, for single-string display. See `providerToolKind()`. */
export function providerToolLabel(provider: { name: string; providerKindId?: ProviderKindId }): string {
  const kind = providerToolKind(provider)
  return kind ? `${provider.name} · ${kind}` : provider.name
}

/** Returns model options for a given provider kind. Falls back to custom if unknown. */
export function getProviderOptions(kindId?: ProviderKindId): ProviderOptions {
  return kindId ? (PROVIDER_OPTIONS[kindId] ?? PROVIDER_OPTIONS.custom) : PROVIDER_OPTIONS.custom
}
