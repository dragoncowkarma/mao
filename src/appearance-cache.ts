import { DEFAULT_DESIGN_ID, normalizeDesignId, type DesignId } from '../core/design-system'
import type { ThemePreference } from '../core/store'

const DESIGN_CACHE_KEY = 'mao:design'
const THEME_CACHE_KEY = 'mao:theme'

/** Normalizes any untrusted stored or cached theme string to a valid `ThemePreference`. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

/** Reads the cached design preset for synchronous first-paint framing before IPC answers. */
export function readCachedDesign(): DesignId {
  try {
    return normalizeDesignId(window.localStorage.getItem(DESIGN_CACHE_KEY))
  } catch {
    return DEFAULT_DESIGN_ID
  }
}

/** Mirrors the confirmed design preset into `localStorage` without failing if storage is blocked. */
export function writeCachedDesign(design: DesignId): void {
  try {
    window.localStorage.setItem(DESIGN_CACHE_KEY, design)
  } catch {
    // Ignore storage quota/privacy-mode errors; MaoStore remains the source of truth.
  }
}

/** Reads the cached theme preference for synchronous first-paint framing before IPC answers. */
export function readCachedTheme(): ThemePreference {
  try {
    return normalizeThemePreference(window.localStorage.getItem(THEME_CACHE_KEY))
  } catch {
    return 'system'
  }
}

/** Mirrors the confirmed theme preference into `localStorage` without failing if storage is blocked. */
export function writeCachedTheme(theme: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, theme)
  } catch {
    // Ignore storage quota/privacy-mode errors; MaoStore remains the source of truth.
  }
}

/** Applies the effective light or dark polarity to `document.documentElement` for CSS token overrides. */
export function applyEffectiveTheme(theme: ThemePreference, systemDark: boolean): void {
  const effective = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
  if (effective === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

/**
 * Primes `<html data-design>` and `<html data-theme>` from cached preferences before `createRoot`,
 * avoiding a pre-mount Classic/Light frame while Electron IPC is still resolving `MaoStore`.
 */
export function primeDocumentAppearance(): void {
  document.documentElement.setAttribute('data-design', readCachedDesign())
  const systemDark =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
  applyEffectiveTheme(readCachedTheme(), systemDark)
}
