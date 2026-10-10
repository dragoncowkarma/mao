export const AI_PROVIDER_KINDS = ['api', 'cli'] as const
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

/** Known CLI tool identifiers — used to drive model/effort option sets in the UI. */
export const PROVIDER_KIND_IDS = ['antigravity', 'claude', 'codex', 'custom'] as const
export type ProviderKindId = (typeof PROVIDER_KIND_IDS)[number]

/** HTTP request formats understood by the built-in API provider. */
export const AI_API_FORMATS = ['anthropic', 'openai'] as const
export type AiApiFormat = (typeof AI_API_FORMATS)[number]

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
 * The canonical ordered stages in the MAO workflow pipeline. Defined here (alongside
 * AiProviderConfig) so provider configs can reference stage names without creating a circular import
 * with workflow-engine.ts (which derives its stage order from this list). workflow-engine.ts
 * re-exports the derived union as WorkflowStageName for backward compatibility.
 */
export const AGENT_STAGES = ['issue', 'pr', 'review', 'merge'] as const
export type AgentStage = (typeof AGENT_STAGES)[number]

export interface AiProviderConfig {
  id: string
  name: string
  kind: AiProviderKind
  // api
  apiFormat?: AiApiFormat
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
