import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { electronApi, setElectronApi, type ElectronApi } from './electron-api'

/**
 * `src/`, anchored to this file rather than to whatever directory vitest was started in — a guard
 * that can fail with `ENOENT: scandir 'src'` because someone narrowed a run from a subdirectory is a
 * guard people learn to dismiss. Vite supplies `import.meta.dirname`; `import.meta.url` is not a
 * `file:` URL under the jsdom environment, so `fileURLToPath` is not available as the anchor.
 */
const SRC = (import.meta as unknown as { dirname?: string }).dirname ?? join(process.cwd(), 'src')

/**
 * The three files that may name the bridge: the ambient declaration, the accessor, and the
 * composition root that binds the real one. Everything else in `src/` goes through `electronApi()`.
 */
const ALLOWED = new Set(['electron.d.ts', 'electron-api.ts', 'main.tsx'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Test code is not renderer code: a test may name the bridge, and the harness has to build one. */
function isTestCode(relativePath: string): boolean {
  return /\.test\.tsx?$/.test(relativePath) || relativePath.split(sep)[0] === 'test'
}

describe('electronApi', () => {
  it('returns the bound bridge', () => {
    const bridge = { platform: 'test' } as unknown as ElectronApi
    setElectronApi(bridge)
    expect(electronApi()).toBe(bridge)
  })

  it('throws a diagnosable error when nothing is bound', () => {
    // setup.ts unbinds after every test, so this is the state a component sees when preload failed.
    expect(() => electronApi()).toThrow(/preload bridge did not load/)
  })

  /**
   * The seam is only worth having if it is the *only* door. Nothing in the toolchain enforces that —
   * `window.electronAPI` type-checks everywhere, so a new component can reach past the accessor and be
   * untestable again without a single error. This is that enforcement.
   *
   * It matches the **identifier**, not `window.electronAPI`, because the member expression is only the
   * most obvious spelling. `const { electronAPI } = window`, `window['electronAPI']` and
   * `const w = window; w.electronAPI` all compile cleanly and all reintroduce exactly the problem the
   * seam exists to prevent, and a substring match on the dotted form waves every one of them through.
   *
   * The cost is that a comment merely *naming* the global fails too. That is the right trade at this
   * ratio — write `electronApi()`, which is what the code around the comment does anyway.
   */
  it('is the only door src/ opens to the preload bridge', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path))
      .filter((path) => !ALLOWED.has(path) && !isTestCode(path))
      .filter((path) => /\belectronAPI\b/.test(readFileSync(join(SRC, path), 'utf-8')))

    expect(offenders).toEqual([])
  })
})
