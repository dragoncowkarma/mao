import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * The half of the IPC lockstep that no type can reach.
 *
 * AGENTS.md requires three files to move together for every channel — `electron/ipc.ts`,
 * `electron/preload.ts`, `src/electron.d.ts` — and `src/test/electron-api-stub.ts` follows because it
 * is written with `satisfies ElectronApi`. Most of that is now enforced at compile time: the bridge
 * object in `electron/preload.ts` carries `satisfies Window['electronAPI']`, so a method missing from
 * either side, or a signature that disagrees, is a tsc error rather than a click that fails in
 * production.
 *
 * `satisfies` cannot see the channel *strings*, nor the global the bridge is installed under.
 * `ipcRenderer.invoke('app:storeProblms')` is a perfectly good `string`, and `ipcMain.handle` is keyed
 * by that same untyped string in a different file — so a typo, a channel registered but never exposed,
 * or one exposed but never registered all compile cleanly and reject only at runtime, inside a `catch`
 * in many cases. `contextBridge.exposeInMainWorld('electronAPI', …)` is worse still: its first argument
 * is the name `src/main.tsx` reads back off `window`, and getting it wrong removes the entire bridge
 * with nothing anywhere to say so. That is what these tests are for, plus pinning the `satisfies`
 * itself: delete that annotation and everything it was checking goes quiet.
 *
 * Read through the TypeScript AST rather than by regex, which is not a refactor but the fix for a
 * reported hole. Regex collectors recognised one spelling — an immediately-called, single-quoted
 * literal — and silently skipped anything else, so rewriting *both* sides of a channel as
 * `handle("ui:setTheme")` / `invoke("ui:setTheem")` removed the pair from both collections, left the
 * remaining channels above the sanity floor, and kept every assertion green over a bridge that was
 * broken at runtime. Reading the real grammar removes that whole class: quote style, template
 * literals, a quoted namespace key, an ES method shorthand and a multi-line call are all just syntax to
 * a parser, and anything it still cannot resolve statically now fails the suite by name and line
 * instead of disappearing (see 'leaves no handle or invoke call unread'). Comments need no stripping
 * either, which retires a regex that would have eaten real code between a channel containing an
 * open-comment sequence and the next close.
 *
 * Why it lives under `src/` when the files it reads are mostly main-process code: `vitest.config.ts`
 * includes only `core/**` and `src/**`, so a test placed beside its subject in `electron/` would be
 * collected by neither project and would pass by never running — the exact silent-retirement hazard
 * architecture rule 8 is written against. `src/` is also where half the contract lives
 * (`src/electron.d.ts`, `src/main.tsx`), and parsing source text needs no DOM, so the renderer project
 * hosting it costs nothing.
 */
const REPO_ROOT = join((import.meta as unknown as { dirname?: string }).dirname ?? join(process.cwd(), 'src'), '..')

/**
 * `setParentNodes: true` is load-bearing: `getStart()` walks the parent chain to skip leading trivia,
 * so without it every line number in a failure message points at the preceding comment block instead
 * of the code.
 */
function parse(...segments: string[]): ts.SourceFile {
  const path = join(REPO_ROOT, ...segments)
  return ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest, true)
}

/**
 * Every `electron/*.ts`, rather than `ipc.ts` and `preload.ts` by name.
 *
 * "The channels the main process registers" is the left-hand side of the comparison below, and naming
 * one file made that side quietly incomplete the moment a registration moved anywhere else — a
 * `ipcMain.handle` in `main.ts`, or a second bridge install in a helper, is invisible to a reader that
 * never opens the file. Enumerating the directory means splitting `ipc.ts` up is just a refactor
 * instead of a silent hole, and there is no list here to keep in sync.
 */
const MAIN_PROCESS = readdirSync(join(REPO_ROOT, 'electron'))
  .filter((entry) => entry.endsWith('.ts'))
  .sort()
  .map((entry) => parse('electron', entry))

const DECLARATION = parse('src', 'electron.d.ts')
const RENDERER_ENTRY = parse('src', 'main.tsx')

/** `file.ts:12`, so a failure names the line to open rather than only the thing that is wrong. */
function at(source: ts.SourceFile, node: ts.Node): string {
  return `${basename(source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
}

function descendants(root: ts.Node): ts.Node[] {
  const all: ts.Node[] = []
  const visit = (node: ts.Node) => {
    all.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return all
}

/** True for a call written exactly `<object>.<method>(…)`, e.g. `ipcMain.handle(…)`. */
function isCallTo(node: ts.Node, object: string, method: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === object &&
    node.expression.name.text === method
  )
}

function callsTo(root: ts.Node, object: string, method: string): ts.CallExpression[] {
  return descendants(root).filter((node): node is ts.CallExpression => isCallTo(node, object, method))
}

/** A call found somewhere in the main process, carrying the file it was found in for locations. */
interface Located {
  call: ts.CallExpression
  source: ts.SourceFile
}

function mainProcessCallsTo(object: string, method: string): Located[] {
  return MAIN_PROCESS.flatMap((source) => callsTo(source, object, method).map((call) => ({ call, source })))
}

const handleCalls = (): Located[] => mainProcessCallsTo('ipcMain', 'handle')
const invokeCalls = (): Located[] => mainProcessCallsTo('ipcRenderer', 'invoke')
const bridgeInstalls = (): Located[] => mainProcessCallsTo('contextBridge', 'exposeInMainWorld')

/**
 * The string a call's first argument names — or `null` when that argument is not a plain string
 * literal.
 *
 * `null` rather than "skip this call" is the entire difference between this file and the regex
 * collectors it replaced. A collector that silently drops what it cannot read shrinks *both* sides of
 * every comparison below by the same element, so a real mismatch cancels itself out and the suite stays
 * green. Returning `null` keeps the call in the collection and lets one test refuse it by name.
 *
 * Both quote styles are accepted because both produce the same statically known channel; a template
 * literal or a variable is refused even when its value would be knowable, because the point is that
 * every channel stays readable without evaluating anything.
 */
function literalArgument(call: ts.CallExpression, index = 0): string | null {
  const argument = call.arguments[index]
  return argument !== undefined && ts.isStringLiteral(argument) ? argument.text : null
}

/** Peels `satisfies`, `as` and parentheses off an expression to reach the literal underneath. */
function unwrap(expression: ts.Expression): ts.Expression {
  let inner = expression
  while (ts.isSatisfiesExpression(inner) || ts.isAsExpression(inner) || ts.isParenthesizedExpression(inner)) {
    inner = inner.expression
  }
  return inner
}

/**
 * A property's name, or `null` for a computed key — which nothing here can resolve, so it fails closed.
 *
 * An identifier (`ui:`), a string literal (`'ui':`) and a numeric key all name the same runtime
 * property. The regex this replaced saw only the first, so quoting one namespace key hid every channel
 * inside it from the comparison while the bridge kept working.
 */
function nameOf(property: ts.ObjectLiteralElementLike): string | null {
  const name = property.name
  if (name === undefined) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

/** The sole bridge install, with the file it lives in — `null` unless there is exactly one. */
function bridgeInstall(): Located | null {
  const installs = bridgeInstalls()
  return installs.length === 1 ? installs[0]! : null
}

/** The object literal the bridge installs, reached past its `satisfies` annotation. */
function bridgeObject(): ts.ObjectLiteralExpression | null {
  const second = bridgeInstall()?.call.arguments[1]
  if (second === undefined) return null
  const inner = unwrap(second)
  return ts.isObjectLiteralExpression(inner) ? inner : null
}

interface BridgeCall {
  namespace: string
  method: string
  channel: string | null
  where: string
}

/**
 * Every `ipcRenderer.invoke` the bridge makes, attributed to the namespace and method that own it by
 * walking the object literal.
 *
 * The regex version took the nearest preceding `name: (` in the source text, which could not see an ES
 * method shorthand and would silently credit a call to whichever earlier method still matched. Walking
 * the tree means a method is whatever property contains the call, however its arguments are wrapped —
 * and an `invoke` that sits outside every namespace is simply absent from this list, which is what the
 * accounting test below exists to notice.
 */
function bridgeCalls(): BridgeCall[] {
  const bridge = bridgeObject()
  const source = bridgeInstall()?.source
  if (bridge === null || source === undefined) return []
  return bridge.properties.flatMap((namespaceProperty) => {
    const namespace = nameOf(namespaceProperty)
    if (namespace === null || !ts.isPropertyAssignment(namespaceProperty)) return []
    const namespaceObject = unwrap(namespaceProperty.initializer)
    if (!ts.isObjectLiteralExpression(namespaceObject)) return []
    return namespaceObject.properties.flatMap((methodProperty) =>
      descendants(methodProperty)
        .filter((node): node is ts.CallExpression => isCallTo(node, 'ipcRenderer', 'invoke'))
        .map((call) => ({
          namespace,
          method: nameOf(methodProperty) ?? '<computed>',
          channel: literalArgument(call),
          where: at(source, call),
        })),
    )
  })
}

/**
 * The members of the `Window` interface `src/electron.d.ts` augments — the renderer's own statement of
 * what the preload script is expected to install.
 *
 * Taken from the declaration rather than hardcoded in this test, so the global name is pinned to the
 * file that defines it instead of to a literal here. A rename then has to happen on every side or the
 * suite says which side was missed.
 */
function declaredWindowMembers(): string[] {
  return descendants(DECLARATION)
    .filter(ts.isInterfaceDeclaration)
    .filter((declaration) => declaration.name.text === 'Window')
    .flatMap((declaration) => declaration.members.map((member) => (member.name === undefined ? '<computed>' : nameOf(member as ts.ObjectLiteralElementLike) ?? '<computed>')))
}

/** Every `window.<property>` the renderer entry point reads, which is the runtime half of that name. */
function rendererWindowReads(): string[] {
  return descendants(RENDERER_ENTRY)
    .filter(ts.isPropertyAccessExpression)
    .filter((access) => ts.isIdentifier(access.expression) && access.expression.text === 'window')
    .map((access) => access.name.text)
}

/** `Window['electronAPI']` as the name it indexes, or `null` for any other type. */
function indexedWindowMember(type: ts.TypeNode): string | null {
  if (!ts.isIndexedAccessTypeNode(type)) return null
  const { objectType, indexType } = type
  if (!ts.isTypeReferenceNode(objectType) || !ts.isIdentifier(objectType.typeName)) return null
  if (objectType.typeName.text !== 'Window') return null
  if (!ts.isLiteralTypeNode(indexType) || !ts.isStringLiteral(indexType.literal)) return null
  return indexType.literal.text
}

describe('the IPC surface', () => {
  /**
   * The guard on the guards, and the reason it is the first test in the file.
   *
   * Every assertion below compares two derived collections, so a parser that stops finding anything —
   * a rename, a moved file, a `createSourceFile` that silently produced an empty tree — makes them both
   * empty and every one of them pass vacuously. That is the same silent-retirement shape as a vitest
   * project whose `include` matches nothing (architecture rule 8): green, and checking nothing. Lower
   * bounds rather than exact counts, so adding a channel never has to touch these numbers; they only
   * have to stay impossible for the parsers to be reading nothing at all.
   */
  it('actually parses the surface it is about to compare', () => {
    expect(handleCalls().length).toBeGreaterThanOrEqual(20)
    expect(invokeCalls().length).toBeGreaterThanOrEqual(20)
    expect(bridgeCalls().length).toBeGreaterThanOrEqual(20)
    expect([...new Set(bridgeCalls().map((call) => call.namespace))]).toEqual(
      expect.arrayContaining(['app', 'ai', 'github', 'workflow', 'ui']),
    )
    expect(declaredWindowMembers().length).toBeGreaterThanOrEqual(1)
    expect(rendererWindowReads().length).toBeGreaterThanOrEqual(1)
  })

  /**
   * Fail closed: the test that makes every other one in this file trustworthy.
   *
   * The reported hole was not that the old collectors were regexes — it was that they *skipped* what
   * they could not parse. Both sides of a channel rewritten in an unrecognised spelling vanished
   * together, the set comparison below still balanced, the sanity floor above still cleared, and a
   * runtime-broken bridge shipped green. So every `ipcMain.handle` and `ipcRenderer.invoke` call the
   * parser finds must yield a statically readable channel, and every `invoke` in the file must be
   * attributable to a namespace and method. A channel moved into a constant, built from a template, or
   * reached through a helper is refused here by name and line — not because it would not work, but
   * because it would take this file's protection away without telling anyone.
   */
  it('leaves no handle or invoke call unread, so new syntax cannot hide a channel', () => {
    const unreadable = [
      ...handleCalls()
        .filter(({ call }) => literalArgument(call) === null)
        .map(({ call, source }) => `ipcMain.handle at ${at(source, call)} does not name its channel as a literal`),
      ...invokeCalls()
        .filter(({ call }) => literalArgument(call) === null)
        .map(({ call, source }) => `ipcRenderer.invoke at ${at(source, call)} does not name its channel as a literal`),
    ]

    expect(unreadable).toEqual([])

    // Attribution has to be total as well as readable: an `invoke` sitting outside every namespace
    // object is absent from `bridgeCalls()`, so it would quietly leave the comparison below.
    const unattributed = invokeCalls().length - bridgeCalls().length
    expect(
      unattributed === 0
        ? []
        : [`${unattributed} ipcRenderer.invoke call(s) are not inside any bridge namespace`],
    ).toEqual([])

    expect(bridgeCalls().filter((call) => call.method === '<computed>')).toEqual([])
  })

  /**
   * The name the whole bridge hangs on, which nothing else checks.
   *
   * `contextBridge.exposeInMainWorld` takes the global as an untyped string, and `src/main.tsx` reads
   * it back off `window` — so one character here (`electronApi` for `electronAPI`) leaves the renderer
   * calling methods on `undefined`, with tsc, the `satisfies` annotation and every comparison in this
   * file all still perfectly happy. Pinned against `src/electron.d.ts`'s own `Window` member and
   * against what the entry point actually reads, rather than against a literal in this test, so the
   * three have to be renamed together.
   *
   * Exactly one install, too: a second `exposeInMainWorld` for the same key is not additive — the
   * renderer gets one of them, and the rest of the bridge is gone.
   */
  it('installs the bridge under exactly the global the renderer reads', () => {
    const installs = bridgeInstalls()
    expect(installs.map(({ call, source }) => at(source, call))).toHaveLength(1)

    const declared = declaredWindowMembers()
    expect(declared).toHaveLength(1)

    expect(literalArgument(installs[0]!.call)).toBe(declared[0])
    expect(rendererWindowReads()).toContain(declared[0])
  })

  it('exposes exactly the channels the main process registers', () => {
    // Set equality in both directions, which is the whole point: a channel handled but never exposed
    // is dead code the renderer cannot reach, and one exposed but never handled is an `invoke` that
    // rejects with "No handler registered" — the second is what a typo on either side produces, and
    // neither is visible to tsc because both sides are plain strings in separate files.
    const handled = handleCalls()
      .map(({ call }) => literalArgument(call))
      .sort()
    const exposed = bridgeCalls()
      .map((call) => call.channel)
      .sort()

    expect(exposed).toEqual(handled)
  })

  it('registers and exposes each channel exactly once', () => {
    // A duplicated `ipcMain.handle` throws at startup ("Attempted to register a second handler"), and
    // a duplicated `invoke` means two methods racing one channel. Both are copy-paste artefacts, and
    // the set comparison above would pass for either, since a duplicate changes no set.
    const duplicates = (channels: Array<string | null>) => channels.filter((c, i) => channels.indexOf(c) !== i)

    expect(duplicates(handleCalls().map(({ call }) => literalArgument(call)))).toEqual([])
    expect(duplicates(bridgeCalls().map((call) => call.channel))).toEqual([])
  })

  it('names every channel after the bridge method that calls it', () => {
    // AGENTS.md's `<domain>:<camelCaseAction>` convention, stated as a check — and the one assertion
    // that localises a typo instead of only detecting it. A mismatched pair here says which method and
    // which channel disagree, where the set comparison can only report two sorted lists. It is also
    // what keeps the domain honest: a method dropped into the wrong namespace stops matching its own
    // channel, even when preload and the declaration agree with each other about it.
    const misnamed = bridgeCalls()
      .filter((call) => call.channel !== `${call.namespace}:${call.method}`)
      .map((call) => `${call.namespace}.${call.method} at ${call.where} invokes '${call.channel}'`)

    expect(misnamed).toEqual([])
  })

  it('keeps the bridge pinned to the renderer declaration tsc can check it against', () => {
    // Without this, every compile-time half of the lockstep can be switched off by deleting one
    // annotation, with no test anywhere going red — `contextBridge.exposeInMainWorld` takes `any`, so
    // the unannotated object type-checks against nothing at all. `satisfies` rather than a type
    // annotation is load-bearing too: an annotation widens each function to the declared type and
    // stops checking what `ipcRenderer.invoke` actually returns against it.
    //
    // Asserted on the argument node itself, not by matching the text anywhere in the file: the regex
    // this replaced could be satisfied by a decoy `} satisfies Window['electronAPI'])` elsewhere while
    // the real bridge went unannotated, and it could not tell `satisfies` from `as`.
    const argument = bridgeInstall()?.call.arguments[1]
    expect(argument !== undefined && ts.isSatisfiesExpression(argument)).toBe(true)
    expect(indexedWindowMember((argument as ts.SatisfiesExpression).type)).toBe(declaredWindowMembers()[0])
  })
})
