import fs from 'node:fs'
import path from 'node:path'
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
const REPO_ROOT = path.join(
  (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'),
  '..',
)

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

function parseHexRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '')
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ]
}

interface ParsedCssRule {
  selector: string
  declarations: Record<string, string>
  body: string
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function extractLayerBody(css: string, layerName: string): string {
  const matches = [...css.matchAll(new RegExp(`@layer\\s+${layerName}\\b`, 'g'))]
  expect(matches, `Expected exactly one @layer ${layerName} block in src/index.css`).toHaveLength(1)
  const start = matches[0]!.index!
  const braceStart = css.indexOf('{', start)
  if (braceStart === -1) throw new Error(`Missing opening brace for @layer ${layerName}`)
  let depth = 0
  for (let i = braceStart; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(braceStart + 1, i)
    }
  }
  throw new Error(`Unclosed @layer ${layerName} block`)
}

function parseDeclarations(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawDecl of body.split(';')) {
    const colon = rawDecl.indexOf(':')
    if (colon === -1) continue
    const prop = rawDecl.slice(0, colon).trim()
    const value = rawDecl.slice(colon + 1).trim()
    if (prop) result[prop] = value
  }
  return result
}

function parseTopLevelRules(layerBody: string): ParsedCssRule[] {
  const rules: ParsedCssRule[] = []
  let cursor = 0
  while (cursor < layerBody.length) {
    const open = layerBody.indexOf('{', cursor)
    if (open === -1) break
    const selector = layerBody.slice(cursor, open).replace(/\s+/g, ' ').trim()
    let depth = 1
    let scan = open + 1
    while (scan < layerBody.length && depth > 0) {
      if (layerBody[scan] === '{') depth += 1
      else if (layerBody[scan] === '}') depth -= 1
      scan += 1
    }
    if (depth !== 0) throw new Error(`Unclosed CSS block for selector "${selector}"`)
    const body = layerBody.slice(open + 1, scan - 1)
    rules.push({ selector, declarations: parseDeclarations(body), body })
    cursor = scan
  }
  return rules
}

function resolveCssToken(
  declarations: Record<string, string>,
  prop: string,
  fallback?: Record<string, string>,
): string {
  let value = declarations[prop] ?? fallback?.[prop]
  if (value === undefined) throw new Error(`Missing CSS token "${prop}"`)
  for (let hop = 0; hop < 10; hop += 1) {
    const varMatch = value.match(/^var\((--[a-z0-9-]+)\)$/i)
    if (!varMatch) return value.toLowerCase()
    const next = declarations[varMatch[1]] ?? fallback?.[varMatch[1]]
    if (next === undefined) throw new Error(`Unresolved CSS reference ${varMatch[1]} from ${prop}`)
    value = next
  }
  throw new Error(`Cyclic CSS var() reference for ${prop}`)
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

describe('CSS token parity and contrast verification against src/index.css', () => {
  const rawCss = fs.readFileSync(path.join(REPO_ROOT, 'src/index.css'), 'utf-8')
  const css = stripCssComments(rawCss)
  const baseBody = extractLayerBody(css, 'base')
  const componentsBody = extractLayerBody(css, 'components')
  const baseRules = parseTopLevelRules(baseBody)
  const componentRules = parseTopLevelRules(componentsBody)

  const TOKEN_BLOCK_SELECTORS = [
    { id: 'classic', mode: 'light', selector: ":root, :root[data-design='classic']" },
    { id: 'classic', mode: 'dark', selector: ":root[data-theme='dark'], :root[data-design='classic'][data-theme='dark']" },
    { id: 'crimson', mode: 'light', selector: ":root[data-design='crimson']" },
    { id: 'crimson', mode: 'dark', selector: ":root[data-design='crimson'][data-theme='dark']" },
    { id: 'console', mode: 'light', selector: ":root[data-design='console']" },
    { id: 'console', mode: 'dark', selector: ":root[data-design='console'][data-theme='dark']" },
    { id: 'minimal', mode: 'light', selector: ":root[data-design='minimal']" },
    { id: 'minimal', mode: 'dark', selector: ":root[data-design='minimal'][data-theme='dark']" },
    { id: 'editorial', mode: 'light', selector: ":root[data-design='editorial']" },
    { id: 'editorial', mode: 'dark', selector: ":root[data-design='editorial'][data-theme='dark']" },
  ] as const

  function blockFor(selector: string): ParsedCssRule {
    const rule = baseRules.find((candidate) => candidate.selector === selector)
    if (!rule) throw new Error(`Expected token block "${selector}" in src/index.css`)
    return rule
  }

  it('defines all 6 selectable + 4 explored token blocks with 1:1 swatch parity against DESIGN_PRESETS and EXPLORED_DESIGN_CANDIDATES', () => {
    const catalog = [...DESIGN_PRESETS, ...EXPLORED_DESIGN_CANDIDATES]
    expect(TOKEN_BLOCK_SELECTORS).toHaveLength(10)

    for (const entry of TOKEN_BLOCK_SELECTORS) {
      const rule = blockFor(entry.selector)
      const design = catalog.find((candidate) => candidate.id === entry.id)
      expect(design, `Missing catalog entry for ${entry.id}`).toBeDefined()
      const swatch = design!.swatches[entry.mode]

      expect(resolveCssToken(rule.declarations, '--color-bg'), `${entry.id}:${entry.mode}:bg`).toBe(
        swatch.bg.toLowerCase(),
      )
      expect(resolveCssToken(rule.declarations, '--color-surface'), `${entry.id}:${entry.mode}:surface`).toBe(
        swatch.surface.toLowerCase(),
      )
      expect(resolveCssToken(rule.declarations, '--color-text'), `${entry.id}:${entry.mode}:text`).toBe(
        swatch.text.toLowerCase(),
      )
      expect(resolveCssToken(rule.declarations, '--color-accent'), `${entry.id}:${entry.mode}:accent`).toBe(
        swatch.accent.toLowerCase(),
      )
      expect(resolveCssToken(rule.declarations, '--color-highlight'), `${entry.id}:${entry.mode}:highlight`).toBe(
        swatch.highlight.toLowerCase(),
      )
    }
  })

  it('keeps every commit-graph lane color readable as branch-label text on every preset surface', () => {
    // The lanes are defined only in the two Classic blocks and inherited by every other preset, so each
    // mode's palette has to clear AA (11px regular labels) against every block of that mode.
    const lanes = (selector: string) => {
      const decl = blockFor(selector).declarations
      return Array.from({ length: 6 }, (_, i) => resolveCssToken(decl, `--graph-lane-${i}`))
    }
    const palettes = {
      light: lanes(TOKEN_BLOCK_SELECTORS[0].selector),
      dark: lanes(TOKEN_BLOCK_SELECTORS[1].selector),
    }
    for (const entry of TOKEN_BLOCK_SELECTORS) {
      const decl = blockFor(entry.selector).declarations
      for (const surface of ['--color-bg', '--color-surface', '--color-bg-subtle']) {
        const surfaceHex = resolveCssToken(decl, surface)
        palettes[entry.mode].forEach((lane, i) => {
          expect(lane, `--graph-lane-${i}`).toMatch(HEX_COLOR_RE)
          expect(
            contrastRatio(lane, surfaceHex),
            `${entry.id}:${entry.mode} --graph-lane-${i} vs ${surface}`,
          ).toBeGreaterThanOrEqual(4.5)
        })
      }
    }
  })

  it('meets WCAG contrast requirements across all parsed CSS token blocks', () => {
    for (const entry of TOKEN_BLOCK_SELECTORS) {
      const decl = blockFor(entry.selector).declarations
      const label = `${entry.id}:${entry.mode}`

      const bg = resolveCssToken(decl, '--color-bg')
      const surface = resolveCssToken(decl, '--color-surface')
      const subtle = resolveCssToken(decl, '--color-bg-subtle')
      const text = resolveCssToken(decl, '--color-text')
      const muted = resolveCssToken(decl, '--color-text-muted')
      const accent = resolveCssToken(decl, '--color-accent')
      const highlight = resolveCssToken(decl, '--color-highlight')
      const activeBorder = resolveCssToken(decl, '--color-active-border')
      const actionIndicator = resolveCssToken(decl, '--color-action-indicator')
      const border = resolveCssToken(decl, '--color-border')
      const focus = resolveCssToken(decl, '--color-focus')
      const actionBg = resolveCssToken(decl, '--color-action-bg')
      const actionHover = resolveCssToken(decl, '--color-action-hover')
      const actionText = resolveCssToken(decl, '--color-action-text')
      const accent100 = resolveCssToken(decl, '--color-accent-100')
      const accent800 = resolveCssToken(decl, '--color-accent-800')
      const dangerBg = resolveCssToken(decl, '--color-danger-bg')
      const dangerText = resolveCssToken(decl, '--color-danger-text')
      const warnBg = resolveCssToken(decl, '--color-warn-bg')
      const warnText = resolveCssToken(decl, '--color-warn-text')
      const successBg = resolveCssToken(decl, '--color-success-bg')
      const successText = resolveCssToken(decl, '--color-success-text')
      const badgeActiveBg = resolveCssToken(decl, '--color-badge-active-bg')
      const badgeActiveText = resolveCssToken(decl, '--color-badge-active-text')

      for (const hex of [
        bg,
        surface,
        subtle,
        text,
        muted,
        accent,
        highlight,
        activeBorder,
        actionIndicator,
        border,
        focus,
        actionBg,
        actionHover,
        actionText,
        accent100,
        accent800,
        dangerBg,
        dangerText,
        warnText,
        successBg,
        successText,
        badgeActiveBg,
        badgeActiveText,
      ]) {
        expect(hex, `${label} hex`).toMatch(HEX_COLOR_RE)
      }

      // Primary body text >= 7.0:1, muted >= 4.5:1, focus >= 3.0:1, danger text >= 4.5:1 across surfaces
      for (const [surfaceName, surfaceHex] of [
        ['bg', bg],
        ['surface', surface],
        ['bg-subtle', subtle],
      ] as const) {
        expect(contrastRatio(text, surfaceHex), `${label} text vs ${surfaceName}`).toBeGreaterThanOrEqual(7)
        expect(contrastRatio(muted, surfaceHex), `${label} muted vs ${surfaceName}`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(focus, surfaceHex), `${label} focus vs ${surfaceName}`).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(dangerText, surfaceHex), `${label} dangerText vs ${surfaceName}`).toBeGreaterThanOrEqual(
          4.5,
        )

        if (entry.id === 'crimson' || entry.id === 'console') {
          expect(contrastRatio(accent, surfaceHex), `${label} accent vs ${surfaceName}`).toBeGreaterThanOrEqual(4.5)
        }
      }

      // --color-highlight contrast checks (crimson light uses yellow #f5b82e as high-contrast action fill;
      // dark crimson, console, minimal, and editorial use --color-highlight directly against bg/surface)
      if (entry.id === 'crimson' && entry.mode === 'light') {
        expect(highlight).toBe(actionBg)
        expect(contrastRatio(highlight, actionText), `${label} highlight fill vs actionText`).toBeGreaterThanOrEqual(8.5)
        expect(contrastRatio(highlight, activeBorder), `${label} highlight fill vs activeBorder`).toBeGreaterThanOrEqual(
          4,
        )
      } else if (
        (entry.id === 'crimson' && entry.mode === 'dark') ||
        entry.id === 'console' ||
        entry.id === 'minimal' ||
        entry.id === 'editorial'
      ) {
        expect(contrastRatio(highlight, bg), `${label} highlight vs bg`).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(highlight, surface), `${label} highlight vs surface`).toBeGreaterThanOrEqual(3)
        if (
          entry.id === 'console' ||
          entry.id === 'minimal' ||
          (entry.id === 'editorial' && entry.mode === 'dark')
        ) {
          expect(contrastRatio(highlight, bg), `${label} highlight vs bg (AA)`).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(highlight, surface), `${label} highlight vs surface (AA)`).toBeGreaterThanOrEqual(4.5)
        } else if (entry.id === 'editorial' && entry.mode === 'light') {
          expect(contrastRatio(highlight, bg), `${label} highlight vs bg (AA)`).toBeGreaterThanOrEqual(4.5)
        }
      } else if (entry.id === 'classic' && entry.mode === 'dark') {
        expect(contrastRatio(highlight, bg), `${label} highlight vs bg (AA)`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(highlight, surface), `${label} highlight vs surface (AA)`).toBeGreaterThanOrEqual(4.5)
      }

      // --color-action-indicator vs --color-action-bg >= 3.0:1 across ALL 10 blocks
      expect(
        contrastRatio(actionIndicator, actionBg),
        `${label} action-indicator vs action-bg`,
      ).toBeGreaterThanOrEqual(3)

      // Active badge text vs bg >= 4.5:1 across ALL 10 blocks
      expect(
        contrastRatio(badgeActiveText, badgeActiveBg),
        `${label} badge-active text vs bg`,
      ).toBeGreaterThanOrEqual(4.5)

      if (entry.id !== 'classic') {
        // Non-classic active borders, control borders, and semantic warn/success badges
        expect(contrastRatio(activeBorder, bg), `${label} active-border vs bg`).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(activeBorder, surface), `${label} active-border vs surface`).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(border, bg), `${label} border vs bg`).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(border, surface), `${label} border vs surface`).toBeGreaterThanOrEqual(3)
        expect(warnBg, `${label} warn-bg hex`).toMatch(HEX_COLOR_RE)
        expect(contrastRatio(warnText, warnBg), `${label} warn text vs bg`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(successText, successBg), `${label} success text vs bg`).toBeGreaterThanOrEqual(4.5)
      }

      if (entry.id === 'console') {
        expect(contrastRatio(actionText, actionBg), `${label} action`).toBeGreaterThanOrEqual(4.5)
      }
      if (entry.id === 'crimson') {
        expect(contrastRatio(actionText, actionBg), `${label} action`).toBeGreaterThanOrEqual(8.5)
      }

      expect(contrastRatio(dangerText, dangerBg), `${label} danger`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(accent800, accent100), `${label} accent-800 vs accent-100`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(text, accent100), `${label} update-banner text vs accent-100`).toBeGreaterThanOrEqual(4.5)

      if (entry.id === 'classic' && entry.mode === 'light') {
        // Classic Light preserves main's #f3f2f2 on #ec3013 (3.76:1) and #dd2b0f hover (4.25:1) verbatim.
        expect(contrastRatio(actionText, actionBg), `${label} action-text vs action-bg`).toBeGreaterThanOrEqual(3.75)
        expect(contrastRatio(actionText, actionHover), `${label} action-text vs action-hover`).toBeGreaterThanOrEqual(
          4.24,
        )
        expect(contrastRatio(actionText, actionHover)).toBeGreaterThan(contrastRatio(actionText, actionBg))
      } else {
        expect(contrastRatio(actionText, actionHover), `${label} action-text vs action-hover`).toBeGreaterThanOrEqual(
          4.5,
        )
      }

      if (entry.id === 'crimson' && entry.mode === 'dark') {
        // Ensure danger text is visibly distinct from near-white body text (#f7ecec)
        expect(contrastRatio(dangerText, text), 'crimson dark danger vs body text contrast').toBeGreaterThanOrEqual(2)
        const [dr, dg, db] = parseHexRgb(dangerText)
        const [tr, tg, tb] = parseHexRgb(text)
        expect(Math.abs(dr - tr) + Math.abs(dg - tg) + Math.abs(db - tb)).toBeGreaterThanOrEqual(150)
        expect(dr - dg).toBeGreaterThanOrEqual(80)
      }
    }
  })

  it('enforces structural, high-density console, highlight, focus-visible, and Classic isolation guards in src/index.css', () => {
    // 1. Sharp corners (--radius-md: 0px), zero hardcoded hexes in @layer components, and semantic active badge variables
    const classicTokens = blockFor(":root, :root[data-design='classic']").declarations
    expect(classicTokens['--radius-md']).toBe('0px')
    expect(componentsBody).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(componentsBody).toContain('var(--color-highlight)')

    const designActiveTagRule = componentRules.find((rule) => rule.selector === '.design-option .tag-success')
    expect(designActiveTagRule).toBeDefined()
    expect(designActiveTagRule!.declarations.background).toBe('var(--color-badge-active-bg)')
    expect(designActiveTagRule!.declarations.color).toBe('var(--color-badge-active-text)')
    expect(designActiveTagRule!.declarations.border).toBe('1px solid var(--color-badge-active-border)')
    const designActiveGlyphRule = componentRules.find(
      (rule) => rule.selector === '.design-option .tag-success::before',
    )
    expect(designActiveGlyphRule?.declarations.content).toBe("'✓ '")

    // 2. Console defines denser spacing (--space-3: 8px), smaller body font-size (13px), and scoped input/btn density
    const consoleTokens = blockFor(":root[data-design='console']").declarations
    expect(classicTokens['--space-3']).toBe('12px')
    expect(consoleTokens['--space-3']).toBe('8px')

    const baseBodyRule = baseRules.find((rule) => rule.selector === 'body')
    const consoleBodyRule = baseRules.find((rule) => rule.selector === ":root[data-design='console'] body")
    expect(baseBodyRule?.declarations['font-size']).toBe('15px')
    expect(consoleBodyRule?.declarations['font-size']).toBe('13px')

    const consoleInputRule = componentRules.find(
      (rule) => rule.selector === ":root[data-design='console'] .input:not(.input-sm)",
    )
    expect(consoleInputRule).toBeDefined()
    expect(componentRules.find((rule) => rule.selector === ":root[data-design='console'] .input")).toBeUndefined()

    const consoleBtnRule = componentRules.find((rule) => rule.selector === ":root[data-design='console'] .btn")
    const consoleBtnPaddingRule = componentRules.find(
      (rule) => rule.selector === ":root[data-design='console'] .btn:not(.btn-ghost)",
    )
    expect(consoleBtnRule?.declarations['font-size']).toBe('12px')
    expect(consoleBtnRule?.declarations.padding).toBeUndefined()
    expect(consoleBtnPaddingRule?.declarations.padding).toBe('5px 10px')

    // 3. :focus-visible covers all interactive elements including disclosures, checkboxes, radios, and summary
    const focusRule = componentRules.find((rule) => rule.selector.includes(':focus-visible'))
    expect(focusRule).toBeDefined()
    const focusSelectors = focusRule!.selector.split(',').map((s) => s.trim())
    for (const required of [
      "input[type='checkbox']:focus-visible",
      "input[type='radio']:focus-visible",
      'summary:focus-visible',
      '.btn:focus-visible',
      '.btn-disclosure:focus-visible',
      '.input:focus-visible',
      '.tab:focus-visible',
      '.sidebar-item:focus-visible',
      '.link-button:focus-visible',
      '.design-option:focus-visible',
      ".card[role='button']:focus-visible",
      'button.tag:focus-visible',
      'a:focus-visible',
    ]) {
      expect(focusSelectors, `Missing focus-visible selector ${required}`).toContain(required)
    }
    expect(focusRule!.declarations.outline).toBe('2px solid var(--color-focus)')
    expect(focusRule!.declarations['outline-offset']).toBe('2px')

    // 4. Non-Classic visual enhancements and status glyphs are scoped under :not([data-design='classic'])
    for (const target of [
      '.text-muted',
      '.card-meta',
      '.sidebar-item.active',
      '.card',
      '.card-subtle',
      '.code-block',
      '.agent-badge-meta',
      '.tab.active',
      '.design-option-active',
      '.preset-row-active',
    ]) {
      const scoped = componentRules.find(
        (rule) => rule.selector === `:root[data-design]:not([data-design='classic']) ${target}`,
      )
      expect(scoped, `Missing :not([data-design='classic']) rule for ${target}`).toBeDefined()
    }

    const sidebarActiveRule = componentRules.find(
      (rule) => rule.selector === ":root[data-design]:not([data-design='classic']) .sidebar-item.active",
    )
    expect(sidebarActiveRule?.declarations['box-shadow']).toBe('inset 3px 0 0 var(--color-action-indicator)')

    const sidebarFooterRule = componentRules.find((rule) => rule.selector === '.sidebar-footer')
    expect(sidebarFooterRule?.declarations['border-top']).toBe(
      'var(--border-structural-width) solid var(--color-divider)',
    )

    const pulseRule = componentRules.find((rule) => rule.selector === '@keyframes card-active-pulse')
    expect(pulseRule?.body).toContain('var(--color-active-border)')
    const classicDarkTokens = blockFor(
      ":root[data-theme='dark'], :root[data-design='classic'][data-theme='dark']",
    ).declarations
    expect(classicTokens['--color-active-border']).toBe('var(--color-accent-2)')
    expect(resolveCssToken(classicTokens, '--color-active-border')).toBe('#e15b47')
    expect(classicDarkTokens['--color-active-border']).toBe('var(--color-accent-2)')
    expect(resolveCssToken(classicDarkTokens, '--color-active-border')).toBe('#ff8f78')

    const statusGlyphRules = componentRules.filter(
      (rule) =>
        !rule.selector.startsWith('.design-option ') &&
        (rule.declarations.content === "'✕ '" ||
          rule.declarations.content === "'⚠ '" ||
          rule.declarations.content === "'✓ '"),
    )
    expect(statusGlyphRules).toHaveLength(3)
    for (const glyphRule of statusGlyphRules) {
      expect(glyphRule.selector).toContain(":not([data-design='classic'])")
    }

    const baseCardRule = componentRules.find((rule) => rule.selector === '.card')
    expect(baseCardRule).toBeDefined()
    expect(baseCardRule!.declarations.border).toBeUndefined()

    const nonClassicCardRule = componentRules.find(
      (rule) => rule.selector === ":root[data-design]:not([data-design='classic']) .card",
    )
    expect(nonClassicCardRule?.declarations.border).toBe('1px solid var(--color-border)')

    for (const control of ['.btn-secondary', '.input']) {
      const expectedSelector = `:root[data-design]:not([data-design='classic']) ${control}`
      const controlRule = componentRules.find((rule) =>
        rule.selector
          .split(',')
          .map((s) => s.trim())
          .includes(expectedSelector),
      )
      expect(controlRule, `Missing non-Classic border rule for ${control}`).toBeDefined()
      expect(controlRule!.declarations['border-color']).toBe('var(--color-border)')
    }

    const cardSubtleRules = componentRules.filter((rule) => rule.selector.includes('.card-subtle'))
    expect(cardSubtleRules.length).toBeGreaterThan(0)
    for (const rule of cardSubtleRules) {
      expect(rule.selector).toContain(":not([data-design='classic'])")
    }

    const codeBlockRules = componentRules.filter((rule) => rule.selector.includes('.code-block'))
    expect(codeBlockRules.length).toBeGreaterThan(0)
    for (const rule of codeBlockRules) {
      expect(rule.selector).toContain(":not([data-design='classic'])")
    }
  })
})
