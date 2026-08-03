export type AiProviderKind = 'api' | 'cli'

export type AiEffort = 'low' | 'medium' | 'high'

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
