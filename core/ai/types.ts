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
  /** Default reasoning effort. Individual workflow tasks may override this. */
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
