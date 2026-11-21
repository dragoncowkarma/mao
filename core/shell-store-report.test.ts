import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The shell call sites that tell an operator what a repository-list write just healed, asserted as
 * source text.
 *
 * `cli/index.ts` calls `program.parseAsync(process.argv)` at module scope, so importing it runs the CLI
 * — these actions cannot be driven from a test at all. What the wording *says* is covered in
 * `core/store.test.ts` (`describeHealedStoredValue`); what this pins is that the shell still asks core
 * rather than spelling a sentence of its own, which is the drift that produced the bug: a hardcoded
 * "Replaced the unusable value" described a destructive whole-list write to an operator whose readable
 * repositories had in fact been kept.
 *
 * Text, for the same reason `core/store.test.ts` reads `electron/store.ts` as text and
 * `core/shell-queue-gate.test.ts` reads this same file: a hand-maintained coupling with no type to
 * enforce it is better pinned imprecisely than not at all.
 */
const REPO_ROOT = path.join(
  (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'),
  '..',
)

/** Comments stripped before anything is matched — only executable text may satisfy these assertions. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('cli repository-list writes report what they healed', () => {
  const source = withoutComments(fs.readFileSync(path.join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8'))
  const helper = source.slice(
    source.indexOf('function reportHealedFields('),
    source.indexOf(".command('add <owner> <repo>')"),
  )
  const addAction = source.slice(
    source.indexOf(".command('add <owner> <repo>')"),
    source.indexOf(".command('remove <owner> <repo>')"),
  )
  const removeAction = source.slice(
    source.indexOf(".command('remove <owner> <repo>')"),
    source.indexOf(".command('list')"),
  )

  it('asks core which kind of write happened instead of asserting a replacement', () => {
    expect(helper).toContain('describeHealedStoredValue(')
    // The hardcoded sentence this replaced. It is still correct for a wrong container — which is why a
    // regression here would be invisible until someone stored a partly readable list.
    expect(source).not.toContain('Replaced the unusable')
  })

  it('reports only the field these commands write', () => {
    // The helper walks the problems seen before the write, and both commands write `githubRepos` alone.
    // Unscoped, an `aiProviders` or `workflowTasks` value repaired by another process during the await
    // was credited to this command — a claim about a write that never happened.
    expect(helper).toContain("candidate.field === 'githubRepos'")
  })

  it('reports from both writing commands, not only the removal', () => {
    // `repos add` is a repository-list write too, so it drops the unusable entries exactly as a removal
    // does. Reporting only from `remove` left the likelier command silent about the same deletion.
    for (const action of [addAction, removeAction]) {
      expect(action).toContain('store.problems()')
      expect(action).toContain('reportHealedFields(store, problemsBefore)')
    }
  })
})

describe('cli set-design reports healed invalid stored design values', () => {
  const source = withoutComments(fs.readFileSync(path.join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8'))
  const start = source.indexOf(".command('set-design <design>')")
  const end = source.indexOf(".command('show')", start)
  const setDesignAction = source.slice(start, end)

  it('reads prior design problems before writing and conditionally logs describeHealedStoredValue after', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const problemsIndex = setDesignAction.indexOf('store.problems()')
    const designFieldIndex = setDesignAction.indexOf("'design'", problemsIndex)
    const setIndex = setDesignAction.indexOf("store.set('design',")

    expect(problemsIndex).toBeGreaterThan(-1)
    expect(designFieldIndex).toBeGreaterThan(problemsIndex)
    expect(setIndex).toBeGreaterThan(designFieldIndex)
    expect(setDesignAction.slice(setIndex)).toMatch(
      /if\s*\([^)]+\)\s*(?:\{[^}]*)?log\(\s*describeHealedStoredValue\(/,
    )
  })
})

describe('renderer entry bootstrap ordering', () => {
  const mainSource = withoutComments(fs.readFileSync(path.join(REPO_ROOT, 'src', 'main.tsx'), 'utf-8'))

  it('binds the preload bridge and primes document appearance strictly before createRoot', () => {
    const bridgeIndex = mainSource.indexOf('setElectronApi(window.electronAPI)')
    const primeIndex = mainSource.indexOf('primeDocumentAppearance()')
    const createRootIndex = mainSource.indexOf('createRoot(')

    expect(bridgeIndex).toBeGreaterThan(-1)
    expect(primeIndex).toBeGreaterThan(-1)
    expect(createRootIndex).toBeGreaterThan(-1)
    expect(bridgeIndex).toBeLessThan(createRootIndex)
    expect(primeIndex).toBeLessThan(createRootIndex)
  })
})
