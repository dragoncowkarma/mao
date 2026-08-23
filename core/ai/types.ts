export type AiProviderKind = 'api' | 'cli'

/** Known CLI tool identifiers — used to drive model/effort option sets in the UI. */
export type ProviderKindId = 'antigravity' | 'claude' | 'codex' | 'custom'

/**
 * Every accepted reasoning-effort value, as a runtime list so free-form input (e.g. an `[Effort: …]`
 * tag parsed out of a GitHub issue body — see core/assignment.ts) can be validated against the same
 * single definition the `AiEffort` type is derived from; adding a level here adds it to both at once.
 */
export const AI_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
  'extra high',
  'ultra',
] as const

export type AiEffort = (typeof AI_EFFORTS)[number]

/** A single model + effort preset entry stored per provider. */
export interface ModelEffortPreset {
  id: string
  model: string
  /** undefined means this preset carries no effort flag */
  effort?: AiEffort
}

/**
 * A stage in the MAO workflow pipeline. Defined here (alongside AiProviderConfig) so that
 * provider configs can reference stage names without creating a circular import with
 * workflow-engine.ts (which imports from this file). workflow-engine.ts re-exports this as
 * WorkflowStageName for backward compatibility.
 */
export type AgentStage = 'issue' | 'pr' | 'review' | 'merge'

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
  /**
   * Stages this provider is permitted to run. When absent or empty, the provider may handle any
   * stage. When set, the provider is only a candidate for stages listed here — maker-checker still
   * applies on top: even a stage-eligible provider is skipped if it handled the immediately
   * preceding stage and another eligible provider is available.
   */
  allowedStages?: AgentStage[]
  /** Ordered list of model+effort presets available for this provider. */
  presets?: ModelEffortPreset[]
  /** ID of the currently selected active preset from presets list. */
  selectedPresetId?: string
}

export interface AiRunOptions {
  /** Working directory for CLI providers (e.g. a local git checkout to edit). Ignored by API providers. */
  cwd?: string
  /** When true, CLI providers get real file/tool access instead of the default text-only sandboxing. */
  allowToolUse?: boolean
  /** Override model ID for this execution run. */
  model?: string
  /** Override reasoning effort for this execution run. */
  effort?: AiEffort
}

export interface AiProvider {
  readonly id: string
  readonly name: string
  run(prompt: string, options?: AiRunOptions): Promise<string>
}
