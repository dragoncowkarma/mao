import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESIGN_ID,
  DESIGN_IDS,
  DESIGN_PRESETS,
  EXPLORED_DESIGN_CANDIDATES,
  getDesignPreset,
  isDesignId,
  normalizeDesignId,
} from './design-system.ts'

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i

/**
 * Computes WCAG 2.1 relative luminance for a 6-digit hex color (`#rrggbb`).
 */
function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '')
  const channels = [0, 2, 4].map((offset) => {
    const sRgb = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255
    return sRgb <= 0.03928 ? sRgb / 12.92 : ((sRgb + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

/**
 * Computes the WCAG 2.1 contrast ratio (`1.0` to `21.0`) between two 6-digit hex colors.
 */
function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA)
  const lumB = relativeLuminance(hexB)
  const lighter = Math.max(lumA, lumB)
  const darker = Math.min(lumA, lumB)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('core/design-system', () => {
  it('defines classic as the default design preset and lists all selectable IDs in order', () => {
    expect(DESIGN_IDS).toEqual(['classic', 'crimson', 'console'])
    expect(DEFAULT_DESIGN_ID).toBe('classic')
    expect(DESIGN_PRESETS.map((preset) => preset.id)).toEqual([...DESIGN_IDS])
  })

  it('validates selectable design IDs via isDesignId and rejects explored-only or non-string values', () => {
    for (const id of DESIGN_IDS) {
      expect(isDesignId(id)).toBe(true)
    }

    for (const explored of EXPLORED_DESIGN_CANDIDATES) {
      expect(isDesignId(explored.id)).toBe(false)
    }

    for (const invalid of ['', 'Classic', 'CRIMSON', 'default', 'dark', null, undefined, 42, true, {}, []]) {
      expect(isDesignId(invalid)).toBe(false)
    }
  })

  it('normalizes unknown or malformed values to DEFAULT_DESIGN_ID (classic)', () => {
    expect(normalizeDesignId('classic')).toBe('classic')
    expect(normalizeDesignId('crimson')).toBe('crimson')
    expect(normalizeDesignId('console')).toBe('console')

    for (const invalid of ['minimal', 'editorial', 'unknown', '', null, undefined, 0, false, { id: 'crimson' }]) {
      expect(normalizeDesignId(invalid)).toBe('classic')
    }
  })

  it('provides complete light and dark hex swatches and descriptions for every selectable preset', () => {
    for (const id of DESIGN_IDS) {
      const preset = getDesignPreset(id)
      expect(preset.id).toBe(id)
      expect(preset.name.length).toBeGreaterThan(0)
      expect(preset.summary.length).toBeGreaterThan(0)
      expect(preset.description.length).toBeGreaterThan(0)

      for (const mode of ['light', 'dark'] as const) {
        const swatch = preset.swatches[mode]
        expect(swatch.bg).toMatch(HEX_COLOR_RE)
        expect(swatch.surface).toMatch(HEX_COLOR_RE)
        expect(swatch.text).toMatch(HEX_COLOR_RE)
        expect(swatch.accent).toMatch(HEX_COLOR_RE)
        expect(swatch.highlight).toMatch(HEX_COLOR_RE)
      }
    }
  })

  it('keeps explored-only candidates disjoint from selectable presets', () => {
    const selectableIds = new Set<string>(DESIGN_IDS)
    const exploredIds = EXPLORED_DESIGN_CANDIDATES.map((candidate) => candidate.id)

    expect(exploredIds).toEqual(['minimal', 'editorial'])
    for (const candidate of EXPLORED_DESIGN_CANDIDATES) {
      expect(selectableIds.has(candidate.id)).toBe(false)
      expect(candidate.name.length).toBeGreaterThan(0)
      expect(candidate.summary.length).toBeGreaterThan(0)
      expect(candidate.disposition.length).toBeGreaterThan(0)
      expect(candidate.swatches.light.bg).toMatch(HEX_COLOR_RE)
      expect(candidate.swatches.dark.bg).toMatch(HEX_COLOR_RE)
    }
  })

  it('maintains WCAG AAA (>= 7.0:1) body text contrast against bg and surface in light and dark modes', () => {
    for (const entry of [...DESIGN_PRESETS, ...EXPLORED_DESIGN_CANDIDATES]) {
      for (const mode of ['light', 'dark'] as const) {
        const swatch = entry.swatches[mode]
        expect(contrastRatio(swatch.text, swatch.bg)).toBeGreaterThanOrEqual(7)
        expect(contrastRatio(swatch.text, swatch.surface)).toBeGreaterThanOrEqual(7)
      }
    }

    const crimson = getDesignPreset('crimson')
    // Both light and dark crimson swatches pair crimson (#9e1b24 / #c92a3a) with warm yellow (#f5b82e)
    // and achieve > 8.9:1 contrast between primary text (#261214 / #180c0e) and yellow action fills (#f5b82e).
    expect(contrastRatio(crimson.swatches.light.text, crimson.swatches.light.highlight)).toBeGreaterThanOrEqual(8.5)
    expect(contrastRatio(crimson.swatches.dark.bg, crimson.swatches.dark.accent)).toBeGreaterThanOrEqual(8.5)
  })
})
