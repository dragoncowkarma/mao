/**
 * Pure, renderer-importable design system contract (Issue #108).
 *
 * Kept free of Node built-ins and of any runtime `core/` imports so both the Electron renderer
 * (`src/`) and the store/CLI (`core/store.ts`, `cli/index.ts`) share one canonical definition of
 * selectable design presets, default fallback behavior, preview swatches, and explored-only
 * design candidates.
 *
 * Design presets (`DesignId`: `'classic' | 'crimson' | 'console'`) orthogonalize visual language
 * (color palette, surface hierarchy, typography stack, and information density) from light/dark
 * mode (`ThemePreference`: `'light' | 'dark' | 'system'`). On `<html>`, `data-theme` controls
 * light/dark polarity while `data-design` selects the active design token set in `src/index.css`.
 */

export const DESIGN_IDS = ['classic', 'crimson', 'console'] as const

export type DesignId = (typeof DESIGN_IDS)[number]

export const DEFAULT_DESIGN_ID: DesignId = 'classic'

/**
 * Representative five-swatch preview of a design preset in either light or dark polarity.
 * Exact hex values match the CSS custom properties defined in `src/index.css` so the Global
 * Settings selector previews the real background, surface, primary text, brand accent, and
 * secondary highlight tokens before the operator switches.
 */
export interface DesignSwatches {
  bg: string
  surface: string
  text: string
  accent: string
  highlight: string
}

/**
 * Metadata for a selectable design preset shipped in the application.
 */
export interface DesignPresetMeta {
  id: DesignId
  name: string
  badge?: string
  summary: string
  description: string
  swatches: {
    light: DesignSwatches
    dark: DesignSwatches
  }
}

/**
 * Selectable design presets offered in Global Settings and `mao config set-design`.
 *
 * - `classic`: Preserves the original warm stone + vermilion editorial look as the default so
 *   existing workflows and visual expectations remain unchanged unless the user opts in.
 * - `crimson`: Implements the requested red/burgundy base + warm yellow/amber point language across
 *   both light and dark modes while keeping error, warning, running, and done states semantically
 *   distinct via dedicated status tokens and non-color indicators.
 * - `console`: High-density charcoal/slate technical workspace chosen from the candidate exploration
 *   for long-running queue monitoring, prompt inspection, and multi-repository kanban triage.
 */
export const DESIGN_PRESETS: readonly DesignPresetMeta[] = [
  {
    id: 'classic',
    name: 'Classic',
    badge: 'Default',
    summary: 'Warm stone surfaces with vermilion accents and bold geometric headings.',
    description:
      'Preserves the original MAO visual identity: warm neutral stone backgrounds, crisp 2px structural dividers, bold Archivo display headings, and high-visibility vermilion primary actions.',
    swatches: {
      light: {
        bg: '#f3f2f2',
        surface: '#eae9e9',
        text: '#201e1d',
        accent: '#ec3013',
        highlight: '#e15b47',
      },
      dark: {
        bg: '#1a1817',
        surface: '#262322',
        text: '#f3f2f2',
        accent: '#ff6a4a',
        highlight: '#ff8f78',
      },
    },
  },
  {
    id: 'crimson',
    name: 'Crimson Signal',
    badge: 'Red · Yellow',
    summary: 'Deep crimson & burgundy base paired with warm amber-gold actions and highlights.',
    description:
      'Built around a low-glare burgundy/oxide canvas and structural crimson framing, paired in both light and dark modes with warm yellow-amber primary actions, active selections, and focus rings. Brand crimson and gold highlights are separated from semantic error, warning, running, and done badges through dedicated status tokens, borders, and icon glyphs.',
    swatches: {
      light: {
        bg: '#f6eeee',
        surface: '#ede0e0',
        text: '#261214',
        accent: '#9e1b24',
        highlight: '#f5b82e',
      },
      dark: {
        bg: '#180c0e',
        surface: '#251317',
        text: '#f7ecec',
        accent: '#f5b82e',
        highlight: '#c92a3a',
      },
    },
  },
  {
    id: 'console',
    name: 'Developer Console',
    badge: 'High density',
    summary: 'Cool slate & charcoal workspace with crisp 1px borders and technical telemetry.',
    description:
      'Optimized for dense multi-agent queue monitoring and prompt log inspection. Pairs low-fatigue slate-charcoal surfaces with cyan/cobalt interactive accents, tabular monospace metadata, and compact 1px structural framing.',
    swatches: {
      light: {
        bg: '#eef1f5',
        surface: '#e2e7ee',
        text: '#111822',
        accent: '#0b6bcb',
        highlight: '#0891b2',
      },
      dark: {
        bg: '#0f1318',
        surface: '#171d24',
        text: '#e6edf3',
        accent: '#38bdf8',
        highlight: '#f59e0b',
      },
    },
  },
] as const

export type ExploredDesignCandidateId = 'minimal' | 'editorial'

/**
 * Metadata for design candidates evaluated during the Issue #108 exploration that are documented
 * for comparison in `docs/ui-design-system.md` but intentionally not exposed as runtime presets.
 * Keeping this catalog explicit in code prevents ambiguity between shipped selectable presets
 * (`DESIGN_PRESETS`) and explored-only reference directions (`EXPLORED_DESIGN_CANDIDATES`).
 */
export interface ExploredDesignCandidate {
  id: ExploredDesignCandidateId
  name: string
  summary: string
  disposition: string
  swatches: {
    light: DesignSwatches
    dark: DesignSwatches
  }
}

export const EXPLORED_DESIGN_CANDIDATES: readonly ExploredDesignCandidate[] = [
  {
    id: 'minimal',
    name: 'Minimal Workspace',
    summary: 'Achromatic paper-and-ink workspace with restrained monochrome hierarchy.',
    disposition:
      'Explored only — not shipped as a selectable preset because its low-chroma badges reduce at-a-glance stage differentiation across multi-column kanban boards compared to Classic and Developer Console.',
    swatches: {
      light: {
        bg: '#fafafa',
        surface: '#f1f1f1',
        text: '#171717',
        accent: '#262626',
        highlight: '#525252',
      },
      dark: {
        bg: '#121212',
        surface: '#1c1c1c',
        text: '#f5f5f5',
        accent: '#e5e5e5',
        highlight: '#a3a3a3',
      },
    },
  },
  {
    id: 'editorial',
    name: 'Editorial / Industrial',
    summary: 'High-contrast brutalist grid with heavy rules and oversized section headers.',
    disposition:
      'Explored only — not shipped as a selectable preset because heavy 2px–3px cell borders and oversized display headings consume vertical space needed by dense workflow history and prompt drawers.',
    swatches: {
      light: {
        bg: '#f4f1ea',
        surface: '#e9e4d8',
        text: '#141413',
        accent: '#141413',
        highlight: '#b84a1b',
      },
      dark: {
        bg: '#141413',
        surface: '#1f1e1c',
        text: '#f4f1ea',
        accent: '#f4f1ea',
        highlight: '#e06d3b',
      },
    },
  },
] as const

/**
 * Type guard checking whether an arbitrary value is one of the shipped selectable `DesignId`s.
 */
export function isDesignId(value: unknown): value is DesignId {
  return typeof value === 'string' && (DESIGN_IDS as readonly string[]).includes(value)
}

/**
 * Normalizes an unknown value (e.g. from unvalidated `config.json` or IPC input) to a valid
 * `DesignId`, falling back to `DEFAULT_DESIGN_ID` (`'classic'`) when the value is absent or
 * unrecognized.
 */
export function normalizeDesignId(value: unknown): DesignId {
  return isDesignId(value) ? value : DEFAULT_DESIGN_ID
}

/**
 * Returns the full preset metadata for a given `DesignId`.
 */
export function getDesignPreset(id: DesignId): DesignPresetMeta {
  return DESIGN_PRESETS.find((preset) => preset.id === id) ?? DESIGN_PRESETS[0]
}
