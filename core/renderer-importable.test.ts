import path from 'node:path'
import esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'

/**
 * Architecture rule 6's **renderer-importable** claim, as a checked invariant rather than a paragraph.
 *
 * The rule lets `src/` value-import exactly three `core/` modules, on the stated grounds that their own
 * `core/` imports are all `import type` — so nothing Node-side is pulled into the renderer bundle.
 * Nothing in the toolchain enforces that. Drop the `type` keyword from
 * `import type { MaoStore } from './store.ts'` in `core/repo-registry.ts` and it compiles cleanly, every
 * other test stays green, and `core/store.ts` — which reads `node:fs` — lands in the renderer bundle.
 *
 * It also pins the edge that runs the other way: `core/store.ts` **value**-imports `isRepoRef` from
 * `core/repo-registry.ts`, because a dropped-entry report has to count with the same predicate that
 * actually drops the entries (`canonicalRepoList()`, `github:getRepos`) or it tells an operator two
 * vanished while three did. That edge is safe *only* because the reverse one is erased at compile time;
 * make it a runtime import and the pair becomes a module-initialisation cycle, whose symptom is an
 * `undefined` in whichever of the two loads second.
 *
 * ## Why esbuild, and why `verbatimModuleSyntax`
 *
 * This asserts on the real **import graph**, not on source text. A regex over `import … from '…'` was
 * the first attempt and it was not fail-closed: it missed double-quoted specifiers, multiline clauses,
 * side-effect imports, `export … from` re-exports and dynamic `import()`. Measured, with
 * `import { type MaoStore } from "./store.ts"` planted in `core/repo-registry.ts`: the regex passed and
 * so did `tsc --noEmit`, while that form really does emit a runtime import under this repo's
 * `"verbatimModuleSyntax": true`.
 *
 * `tsconfigRaw` is passed explicitly and is load-bearing: **esbuild's default is to elide that import**,
 * so without it this check reports the planted mutation as clean — it was verified empirically both
 * ways, not reasoned about. `platform: 'node'` matters too: it leaves `node:*` external so a violation
 * comes back as a readable metafile naming the modules that were pulled in, instead of esbuild throwing
 * `Could not resolve "node:fs"` from eight places at once.
 *
 * Asserting that every input is **within the allowlist** rather than that a module imports nothing:
 * `core/agent-selection.ts` legitimately value-imports `core/ai/provider-options.ts`, and both are on
 * the list. The whole measured pass costs about 30ms, and it needs no DOM and no vite plugin, so it sits
 * in the `core` project without touching architecture rule 8.
 */

/** The repository root, anchored to this file rather than to wherever vitest was started. */
const REPO_ROOT = path.join(
  (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'),
  '..',
)

/**
 * The modules AGENTS.md rule 6 marks renderer-importable — the allowlist and the subjects at once.
 *
 * All three, not just the one this PR touched: the rule names three, and a guard that covered one would
 * leave the other two making the same promise with nothing behind it.
 */
const RENDERER_IMPORTABLE = [
  'core/repo-registry.ts',
  'core/agent-selection.ts',
  'core/ai/provider-options.ts',
]

/** Every module esbuild has to pull in to bundle `entry`, repo-relative, including `entry` itself. */
async function importGraphOf(entry: string): Promise<string[]> {
  const built = await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, entry)],
    bundle: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
    // Leaves `node:*` external, so a violation is a readable input list rather than a resolve error.
    platform: 'node',
    format: 'esm',
    // Without this esbuild drops `import { type X } from './y.ts'` entirely and the check goes blind to
    // the very spelling that defeated the regex it replaced. It mirrors the repo's own tsconfig.
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  })
  return Object.keys(built.metafile.inputs).map((input) =>
    path.relative(REPO_ROOT, path.resolve(process.cwd(), input)),
  )
}

describe('the core modules src/ may value-import', () => {
  it.each(RENDERER_IMPORTABLE)('%s pulls in nothing outside the allowlist', async (entry) => {
    const graph = await importGraphOf(entry)

    expect(graph).toContain(entry)
    expect(graph.filter((input) => !RENDERER_IMPORTABLE.includes(input))).toEqual([])
  })

  it('would catch a value import that the regex it replaced did not', async () => {
    // The guard is only worth having if it fails for the spellings that defeated the last one. Rather
    // than describing them, this bundles a fixture that uses each: an inline-type import with double
    // quotes (the form that passed the regex *and* `tsc`), a multiline inline-type clause, a
    // side-effect import, an `export … from` re-export, and a dynamic `import()`. Each must pull
    // `core/store.ts` into the graph. Written through esbuild's stdin so no file is planted in `core/`,
    // where it would be picked up as a module in its own right.
    const spellings = [
      'import { type MaoStore } from "./core/store.ts"\nvoid 0 as unknown as MaoStore',
      'import {\n  type MaoStore,\n} from "./core/store.ts"\nvoid 0 as unknown as MaoStore',
      "import './core/store.ts'",
      "export { MAO_STORE_DEFAULTS } from './core/store.ts'",
      "export const load = async () => (await import('./core/store.ts')).MAO_STORE_DEFAULTS",
    ]

    for (const spelling of spellings) {
      const built = await esbuild.build({
        stdin: { contents: spelling, resolveDir: REPO_ROOT, sourcefile: 'probe.ts', loader: 'ts' },
        bundle: true,
        write: false,
        metafile: true,
        logLevel: 'silent',
        platform: 'node',
        format: 'esm',
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      })
      const graph = Object.keys(built.metafile.inputs)

      expect(graph.some((input) => input.endsWith('core/store.ts')), spelling).toBe(true)
    }
  })

  it('does not call a clean type-only import a violation', async () => {
    // The other direction, so the guard cannot be satisfied by failing everything: the spelling the rule
    // actually prescribes has to come back clean, or every renderer-importable module would be "in
    // violation" and the assertion above would be meaningless.
    //
    // The specifier has to be one that really resolves. An elided `import type` is never resolved at
    // all, so while this fixture's path was wrong the control passed for that reason instead of the
    // intended one — a test that would have gone on passing if the elision had stopped working.
    const built = await esbuild.build({
      stdin: {
        contents: "import type { MaoStore } from './core/store.ts'\nvoid 0 as unknown as MaoStore",
        resolveDir: REPO_ROOT,
        sourcefile: 'probe.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      metafile: true,
      logLevel: 'silent',
      platform: 'node',
      format: 'esm',
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    })

    expect(Object.keys(built.metafile.inputs).some((input) => input.endsWith('core/store.ts'))).toBe(false)
  })
})
