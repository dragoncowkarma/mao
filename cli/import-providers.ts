import fs from 'node:fs'
import path from 'node:path'
import type { MaoStore } from '../core/store.ts'
import type { AiProviderConfig } from '../core/ai/types.ts'

export type ProviderImportLogger = (message: string) => void

/**
 * Imports a provider list without ever persisting unvalidated input.
 *
 * Rejections name the input file the operator must repair, but deliberately omit the parser/backend
 * error and every provider value: either may contain an API key or another credential. Success is
 * logged only after the guarded store write returns.
 */
export function importProvidersFromFile(
  file: string,
  store: MaoStore,
  log: ProviderImportLogger,
): AiProviderConfig[] {
  const inputPath = path.resolve(file)
  const displayedPath = JSON.stringify(inputPath)

  let source: string
  try {
    source = fs.readFileSync(inputPath, 'utf-8')
  } catch {
    throw new Error(`Could not read provider import file ${displayedPath}. Nothing was written.`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error(
      `Cannot import AI providers from ${displayedPath}: the file is not valid JSON. Nothing was written.`,
    )
  }

  const validationProblem = store.validateWrite('aiProviders', parsed as AiProviderConfig[])
  if (validationProblem !== undefined) {
    throw new Error(`Cannot import AI providers from ${displayedPath}: ${validationProblem}`)
  }

  const providers = parsed as AiProviderConfig[]
  try {
    store.set('aiProviders', providers)
  } catch {
    throw new Error(
      `Could not import AI providers from ${displayedPath}: the destination write failed. Inspect the ` +
        'stored config before retrying; no provider value, token or API key is shown.',
    )
  }

  log(`Imported ${providers.length} AI provider(s): ${providers.map((provider) => provider.id).join(', ')}`)
  return providers
}
