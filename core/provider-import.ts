import fs from 'node:fs'
import path from 'node:path'
import type { MaoStore } from './store.ts'
import type { AiProviderConfig } from './ai/types.ts'

export type ProviderImportLogger = (message: string) => void

function quotePathForDisplay(inputPath: string): string {
  const escaped = inputPath.replace(
    /[%"\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    (character) => {
      const codePoint = character.codePointAt(0)!
      const width = codePoint <= 0xff ? 2 : 4
      const prefix = codePoint <= 0xff ? '%' : '%u'
      return `${prefix}${codePoint.toString(16).toUpperCase().padStart(width, '0')}`
    },
  )
  return `"${escaped}"`
}

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
  // Percent-escape the delimiter, percent signs and control characters so the representation stays
  // reversible without doubling the backslashes an operator needs to copy from a Windows path.
  const displayedPath = quotePathForDisplay(inputPath)

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
