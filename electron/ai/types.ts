export type AiProviderKind = 'api' | 'cli'

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
}

export interface AiProvider {
  readonly id: string
  readonly name: string
  run(prompt: string): Promise<string>
}
