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
  } catch (error) {
    // The store's own message is forwarded, not replaced. Every message `MaoStore.set` can throw is
    // value-free by contract — `describeInvalidStoredWrite` reports field, destination and counts, and
    // `describeRefusedStoredWrite` names the file, the cause and the remedy and says outright that the
    // contents are not shown — which is the same reason the `validateWrite` branch above already
    // forwards one verbatim. Replacing it cost this command the only per-cause explanation an operator
    // gets: once a write can be *refused* because the file could not be read, "the destination write
    // failed" tells them neither that nothing was written nor how to fix it, while every other write
    // path (`config set-theme`, `repos remove`, `workflow clear-completed`) prints it in full.
    const reported = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not import AI providers from ${displayedPath}: ${reported}`)
  }

  log(`Imported ${providers.length} AI provider(s): ${providers.map((provider) => provider.id).join(', ')}`)
  return providers
}
