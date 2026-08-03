export type AiProviderKind = 'api' | 'cli'

export type AiEffort = 'low' | 'medium' | 'high'

/** A one-task selection request, normally supplied by an issue directive. */
export interface AiAgentOverride {
  /** ID of a configured provider. When omitted, normal maker-checker selection still applies. */
  providerId?: string
  /** Model to use for this task without changing the saved provider configuration. */
  model?: string
  /** Reasoning effort to use for this task where the selected backend supports it. */
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
  args?: string[]
  /** Reasoning effort used by backends that support it and shown alongside this provider's work. */
  effort?: AiEffort
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
