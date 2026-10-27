import fs from 'node:fs'
import path from 'node:path'
import esbuild from 'esbuild'
import ts from 'typescript'
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
 * ways, not reasoned about.
 *
 * `platform: 'neutral'` is the other load-bearing setting, and it replaced `'node'` after review. Under
 * `'node'` the Node built-ins are *external*, so they never appear among the metafile's `inputs` — and an
 * `import 'node:fs'` planted in `core/repo-registry.ts` left this suite green, which is the precise
 * violation the whole file exists to catch. Measured: a *used* `import fs from 'node:fs'` surfaces only
 * under an output's `imports` as `{ external: true }`, and a *bare* `import 'node:fs'` is dropped from
 * the bundle entirely and surfaces nowhere at all. Under `'neutral'` nothing is external, so every one of
 * those forms fails to resolve and the build throws — which is why a thrown build is read here as a
 * violation and reported by the specifier it could not resolve. Both the external `imports` list and the
 * resolve failures are checked, so neither route rests on a single mechanism.
 *
 * Asserting that every input is **within the allowlist** rather than that a module imports nothing:
 * `core/agent-selection.ts` legitimately value-imports `core/ai/provider-options.ts`, and both are on
 * the list. The rule enforced here is therefore "nothing outside the allowlist", which is stricter than
 * rule 6's prose — an npm package that is genuinely browser-safe would be reported too. None of the three
 * imports one, and loosening that is a decision for whoever first needs to.
 *
 * Paths are normalised to `/` before comparison: `path.relative()` yields backslashes on Windows, which
 * matches no allowlist entry, and `package.json` declares a Windows ZIP target — so without it this test
 * would fail on a supported platform rather than catch anything. CI runs Linux only, so nothing else
 * would have reported it.
 *
 * ## Why there is an AST pass as well
 *
 * An import graph only contains edges a bundler can *see*. `const s = 'node:fs'; import(s)` is not one:
 * measured, esbuild leaves `import(specifier)` in the output and records it among neither the inputs nor
 * the external imports, and emits no warning — so the graph check above returns clean for it, and
 * planting that edge in `core/repo-registry.ts` left every assertion here green. A computed `require()`
 * and a substituting template literal behave the same way. Those are real runtime edges in the shipped
 * renderer bundle, which is exactly what rule 6 forbids.
 *
 * So each subject is also parsed and rejected for any `import()` or `require()` whose specifier is not a
 * plain string literal. **Any** non-literal, not just ones that look like Node built-ins: a specifier the
 * check cannot read is a specifier it cannot vouch for, and failing closed is the whole point of the
 * file. The AST pass covers the entry it is given rather than the transitive graph — which is sufficient
 * here only because every allowlisted module is itself a subject of the same assertion.
 *
 * The whole measured pass costs about 30ms, and it needs no DOM and no vite plugin, so it sits in the
 * `core` project without touching architecture rule 8.
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

/**
 * Bundle options shared by the real modules and by every fixture below.
 *
 * Shared deliberately: a fixture checked under laxer options would prove nothing about the subjects.
 */
const PROBE = {
  bundle: true,
  write: false,
  metafile: true,
  logLevel: 'silent',
  // Nothing external — see the file comment. Under `platform: 'node'` a reach for `node:fs` was tolerated
  // as an external edge and never appeared among the metafile inputs at all.
  platform: 'neutral',
  format: 'esm',
  // Without this esbuild drops `import { type X } from './y.ts'` entirely and the check goes blind to the
  // very spelling that defeated the regex it replaced. It mirrors the repo's own tsconfig.
  tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
} as const

/** Repo-relative and `/`-separated, so the allowlist comparison holds on Windows too. */
function repoRelative(input: string): string {
  return path.relative(REPO_ROOT, path.resolve(process.cwd(), input)).split(path.sep).join('/')
}

/**
 * Why whatever `options` bundles is not safe for `src/` to value-import — empty when it is.
 *
 * Three routes, because no single one covers every spelling: a module bundled that is not on the
 * allowlist, a runtime edge esbuild kept as external, and a specifier that could not be resolved at all,
 * which is how a reach for a Node built-in surfaces once nothing is external.
 */
async function violationsOf(options: Record<string, unknown>, alsoAllowed: string[] = []): Promise<string[]> {
  let built: Awaited<ReturnType<typeof esbuild.build>>
  try {
    built = await esbuild.build({ ...PROBE, ...options } as Parameters<typeof esbuild.build>[0])
  } catch (failure) {
    const errors = (failure as { errors?: Array<{ text: string; location: { file: string } | null }> }).errors
    if (!errors?.length) throw failure
    // De-duplicated: one unresolvable specifier reached from three files is one fault to fix.
    return [...new Set(errors.map((error) => `${error.location?.file ?? '?'}: ${error.text}`))]
  }
  const allowed = [...RENDERER_IMPORTABLE, ...alsoAllowed]
  const bundled = Object.keys(built.metafile!.inputs).map(repoRelative)
  const external = Object.values(built.metafile!.outputs)
    .flatMap((output) => output.imports ?? [])
    .filter((imported) => imported.external)
  return [
    ...bundled.filter((input) => !allowed.includes(input)).map((input) => `bundles ${input}`),
    ...external.map((imported) => `imports ${imported.path} at runtime (${imported.kind})`),
  ]
}

/**
 * Any `import()` or `require()` in `source` whose specifier is not a plain string literal.
 *
 * A bundler records nothing for these, so the graph check cannot see them — see the file comment. A
 * no-substitution template literal counts as plain; one with a `${…}` in it does not.
 */
function computedImportViolations(source: string, label: string): string[] {
  const parsed = ts.createSourceFile(label, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const found: string[] = []
  const isPlainSpecifier = (node: ts.Node | undefined): boolean =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if ((dynamicImport || requireCall) && !isPlainSpecifier(node.arguments[0])) {
        found.push(`${label}: ${dynamicImport ? 'import' : 'require'}() with a non-literal specifier`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

/**
 * The same check, over a source fixture instead of a file, so nothing is planted under `core/`.
 *
 * The fixture itself is the bundle's entry, so `probe.ts` is allowed alongside the real allowlist —
 * otherwise every fixture would "fail" for being itself and the clean controls could never pass.
 */
async function violationsForSource(contents: string): Promise<string[]> {
  const graph = await violationsOf(
    { stdin: { contents, resolveDir: REPO_ROOT, sourcefile: 'probe.ts', loader: 'ts' } },
    ['probe.ts'],
  )
  return [...graph, ...computedImportViolations(contents, 'probe.ts')]
}

/** Both passes over one of the real modules, so a subject is judged exactly as a fixture is. */
async function violationsForModule(entry: string): Promise<string[]> {
  const graph = await violationsOf({ entryPoints: [path.join(REPO_ROOT, entry)] })
  const source = fs.readFileSync(path.join(REPO_ROOT, entry), 'utf-8')
  return [...graph, ...computedImportViolations(source, entry)]
}

describe('the core modules src/ may value-import', () => {
  it.each(RENDERER_IMPORTABLE)('%s reaches nothing outside the allowlist', async (entry) => {
    const built = await esbuild.build({ ...PROBE, entryPoints: [path.join(REPO_ROOT, entry)] })

    // The entry is in its own graph, so a probe that silently bundled nothing cannot read as a pass.
    expect(Object.keys(built.metafile!.inputs).map(repoRelative)).toContain(entry)
    expect(await violationsForModule(entry)).toEqual([])
  })

  it('rejects a reach for a Node built-in, in every form it survives review in', async () => {
    // The follow-up review's finding, as fixtures. Under the previous `platform: 'node'` these were
    // external rather than bundled, so `metafile.inputs` never named them — a planted `import 'node:fs'`
    // in core/repo-registry.ts left this suite green, blind to exactly the edge it forbids. Each form is
    // now a violation, including the bare side-effect import esbuild drops from the bundle altogether.
    const reaches: Record<string, string> = {
      'bare side-effect import': "import 'node:fs'",
      'default import, used': "import fs from 'node:fs'\nexport const read = fs.readFileSync",
      'named import, used': "import { readFileSync } from 'node:fs'\nexport const read = readFileSync",
      'dynamic import': "export const read = async () => (await import('node:fs')).readFileSync",
      electron: "import { app } from 'electron'\nexport const quit = () => app.quit()",
    }

    for (const [form, contents] of Object.entries(reaches)) {
      expect(await violationsForSource(contents), form).not.toEqual([])
    }
  })

  it('rejects a runtime import whose specifier a bundler cannot read', async () => {
    // The follow-up review's second finding. These leave nothing in the graph — no input, no external
    // import, not even a warning — so the esbuild pass returns clean and only the AST pass catches them.
    // Planting the first form in core/repo-registry.ts left all six assertions here green.
    const computed: Record<string, string> = {
      'computed dynamic import': "const specifier = 'node:fs'\nexport const load = () => import(specifier)",
      'computed require': "const specifier = 'node:fs'\nexport const load = () => require(specifier)",
      'substituting template': "const name = 'fs'\nexport const load = () => import(`node:${name}`)",
      'specifier from a parameter': 'export const load = (specifier: string) => import(specifier)',
    }

    for (const [form, contents] of Object.entries(computed)) {
      expect(await violationsForSource(contents), form).not.toEqual([])
    }
  })

  it('rejects a value import of a core module that is not on the allowlist', async () => {
    // The original subject, and the spellings the regex this replaced let through. Each must pull
    // `core/store.ts` — and with it `node:fs` — into the graph. Written through esbuild's stdin so no file
    // is planted in `core/`, where it would be collected as a module in its own right.
    const spellings: Record<string, string> = {
      'inline type, double quotes':
        'import { type MaoStore } from "./core/store.ts"\nvoid 0 as unknown as MaoStore',
      'multiline inline type':
        'import {\n  type MaoStore,\n} from "./core/store.ts"\nvoid 0 as unknown as MaoStore',
      'side-effect import': "import './core/store.ts'",
      'export-from re-export': "export { MAO_STORE_DEFAULTS } from './core/store.ts'",
      'dynamic import': "export const load = async () => (await import('./core/store.ts')).MAO_STORE_DEFAULTS",
    }

    for (const [spelling, contents] of Object.entries(spellings)) {
      expect(await violationsForSource(contents), spelling).not.toEqual([])
    }
  })

  it('does not call a clean type-only import a violation', async () => {
    // The other direction, so the guard cannot be satisfied by failing everything: the spelling the rule
    // actually prescribes has to come back clean, or every module above would be "in violation" and the
    // assertions would be meaningless.
    //
    // The specifier has to be one that really resolves. An elided `import type` is never resolved at all,
    // so an earlier draft whose fixture path was wrong passed for that reason instead of the intended one
    // — a test that would have gone on passing if the elision had stopped working.
    expect(
      await violationsForSource("import type { MaoStore } from './core/store.ts'\nvoid 0 as unknown as MaoStore"),
    ).toEqual([])
    // And reaching an allowlisted sibling is equally fine — that is what the allowlist is for.
    expect(await violationsForSource("export { PROVIDER_OPTIONS } from './core/ai/provider-options.ts'")).toEqual([])
    // A *literal* dynamic import of an allowlisted module is not a violation either: the AST pass
    // objects to specifiers it cannot read, not to dynamic import as such. Without this the pass could
    // be satisfied by rejecting every `import()`, which would make the fixtures above meaningless.
    expect(
      await violationsForSource("export const load = () => import('./core/ai/provider-options.ts')"),
    ).toEqual([])
  })
})
