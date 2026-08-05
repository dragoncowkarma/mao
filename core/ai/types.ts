export type AiProviderKind = 'api' | 'cli'

/** Known CLI tool identifiers — used to drive model/effort option sets in the UI. */
export type ProviderKindId = 'antigravity' | 'claude' | 'codex' | 'custom'

export type AiEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultracode'
  | 'extra high'
  | 'ultra'

/** A single model + effort preset entry stored per provider. */
export interface ModelEffortPreset {
  id: string
  model: string
  /** undefined means this preset carries no effort flag */
  effort?: AiEffort
}

export interface AiProviderConfig {
  id: string
  name: string
  kind: AiProviderKind
  // api
  apiFormat?: 'anthropic' | 'openai'
  apiKey?: string
  baseUrl?: string
  model?: string
  // cli
  command?: string
  /** Identifies the CLI tool for model/effort option resolution. */
  providerKindId?: ProviderKindId
  args?: string[]
  /** Reasoning effort shown alongside this provider's work — informational only, not sent to every backend. */
  effort?: AiEffort
  /** Ordered list of model+effort presets available for this provider. */
  presets?: ModelEffortPreset[]
}

export interface AiRunOptions {
  /** Working directory for CLI providers (e.g. a local git checkout to edit). Ignored by API providers. */
  cwd?: string
  /** When true, CLI providers get real file/tool access instead of the default text-only sandboxing. */
  allowToolUse?: boolean
}

export interface AiProvider {
  readonly id: string
  readonly name: string
  run(prompt: string, options?: AiRunOptions): Promise<string>
}
