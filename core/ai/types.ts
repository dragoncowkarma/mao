export type AiProviderKind = 'api' | 'cli'

export type AiEffort = 'low' | 'medium' | 'high'

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
