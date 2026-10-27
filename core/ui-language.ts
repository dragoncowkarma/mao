/**
 * The language the Electron GUI renders in — the single definition of which languages exist.
 *
 * Renderer-importable (AGENTS.md rule 6): it is pure and imports nothing from `core/` at runtime, so
 * `src/` takes the list and the resolution rule from here instead of re-deriving them. Everything
 * else that names a language derives from `UI_LANGUAGES`: the persisted `language` field's type
 * (`core/store.ts`), `mao config set-language`'s validation, and the renderer's message catalogs,
 * which are typed `Record<UiLanguage, …>` — so a language added here without a catalog is a `tsc`
 * error rather than a blank screen.
 *
 * The CLI deliberately does not localize its own output. Like `theme`, this is a GUI preference the
 * CLI can set, not something the CLI reads.
 */

/** Languages the GUI ships a complete message catalog for. English is the fallback. */
export const UI_LANGUAGES = ['en', 'ko'] as const

export type UiLanguage = (typeof UI_LANGUAGES)[number]

/**
 * What the operator picked. `'system'` follows the OS's preferred-language list and is the default,
 * for the same reason `ThemePreference` defaults to `'system'`: it is the only option that does not
 * ask the operator to choose up front.
 */
export type LanguagePreference = 'system' | UiLanguage

/** Every accepted preference, in the order a picker lists them. */
export const LANGUAGE_PREFERENCES: readonly LanguagePreference[] = ['system', ...UI_LANGUAGES]

/** What `'system'` falls back to when none of the OS's languages has a catalog. */
export const FALLBACK_UI_LANGUAGE: UiLanguage = 'en'

function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value)
}

/** True for exactly the values `mao config set-language` accepts and the store's type declares. */
export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isUiLanguage(value)
}

/**
 * The shipped language an OS language tag names, if any. A tag matches on its primary subtag,
 * case-insensitively — `ko-KR`, `ko_KR` and `KO` all name `ko`, while `kok-IN` (Konkani) names none.
 * The one rule for "is this tag that language": `resolveUiLanguage()` uses it to pick a language, and
 * the renderer uses it to keep the OS's regional date format for the language it picked.
 */
export function tagLanguage(tag: unknown): UiLanguage | undefined {
  if (typeof tag !== 'string') return undefined
  const primary = tag.split(/[-_]/, 1)[0].toLowerCase()
  return isUiLanguage(primary) ? primary : undefined
}

/**
 * The language to render in.
 *
 * `preference` is `unknown` because it comes from `config.json`, which is unvalidated JSON: a
 * hand-edit can leave `"fr"` or `42` there, and treating anything that is not a shipped language as
 * `'system'` keeps the GUI readable instead of trusting the declared type.
 *
 * `preferredLanguages` is the OS's list, most preferred first (`navigator.languages` in the
 * renderer). Each tag is read with `tagLanguage()`, and the first one with a catalog wins, so
 * `['ja-JP', 'ko-KR']` resolves to Korean rather than skipping straight to the fallback.
 */
export function resolveUiLanguage(preference: unknown, preferredLanguages: readonly string[]): UiLanguage {
  if (isUiLanguage(preference)) return preference
  for (const tag of preferredLanguages) {
    const language = tagLanguage(tag)
    if (language) return language
  }
  return FALLBACK_UI_LANGUAGE
}
