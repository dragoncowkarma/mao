import type { AiProvider, AiProviderConfig } from './types.ts'
import { ApiProvider } from './api-provider.ts'
import { CliProvider } from './cli-provider.ts'

export * from './types.ts'
export * from './provider-options.ts'

export function createAiProvider(config: AiProviderConfig): AiProvider {
  return config.kind === 'cli' ? new CliProvider(config) : new ApiProvider(config)
}
