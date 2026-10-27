/**
 * The Latin-script words the Korean catalog keeps on purpose. Anything else in Latin script inside a
 * Korean string is English nobody translated — which neither `tsc` nor the hardcoded-text guard can
 * see, because the key exists and the text came from the catalog.
 *
 * Every entry has a reason a reviewer can check: a product or tool name, a name GitHub itself uses (its
 * permission names, the `workflow-active` label), an example the operator types (`claude`, `gpt-4o`,
 * `ghp_`), or a term Korean developer UIs keep in Latin (PR, AI, API, CLI, ID, OS). The effort levels are
 * here because `PROVIDER_OPTIONS` shows them untranslated beside the catalog's copy of them.
 *
 * `src/i18n/catalog.test.ts` holds both directions: no Latin word outside this list, and no entry here
 * the catalog no longer uses — a stale allowance is one a future leak could hide behind.
 */
export const KOREAN_CATALOG_LATIN: ReadonlySet<string> = new Set([
  // Product, tool and vendor names.
  'MAO',
  'GitHub',
  'Claude',
  'Codex',
  'Antigravity',
  'agy',
  'Anthropic',
  'OpenAI',
  // GitHub's own names: a fine-grained token's permissions, and the label MAO puts on an issue.
  'Issues',
  'Contents',
  'Pull',
  'requests',
  'workflow-active',
  // Examples of what the operator types.
  'claude',
  'gpt-4o',
  'ghp',
  // Abbreviations Korean developer UIs keep in Latin.
  'PR',
  'AI',
  'API',
  'BYOK',
  'CLI',
  'ID',
  'OS',
  // Effort levels, mirroring core's untranslated PROVIDER_OPTIONS labels.
  'Low',
  'Medium',
  'High',
  'X-High',
  'Max',
])

const LATIN_WORD = /[A-Za-z][A-Za-z0-9]*(?:[-_.'][A-Za-z0-9]+)*/g

/** The Latin-script words in a text, as the catalog and sweep tests count them. */
export function latinWords(text: string): string[] {
  return text.match(LATIN_WORD) ?? []
}
