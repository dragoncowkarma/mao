import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * `satisfies` cannot see the channel *strings*. `ipcRenderer.invoke('app:storeProblms')` is a
 * perfectly good `string`, and `ipcMain.handle` is keyed by that same untyped string in a different
 * file — so a typo, a channel registered but never exposed, or one exposed but never registered all
 * compile cleanly and reject only at runtime, inside a `catch` in many cases. That is what these
 * tests are for, plus pinning the `satisfies` itself: delete that annotation and everything it was
 * checking goes quiet, which is the failure mode this file exists to prevent.
 *
 * Why it lives under `src/` when both files it reads are main-process code: `vitest.config.ts`
 * includes only `core/**` and `src/**`, so a test placed beside its subject in `electron/` would be
 * collected by neither project and would pass by never running — the exact silent-retirement hazard
 * architecture rule 8 is written against. `src/` is also where half the contract lives
 * (`src/electron.d.ts`), and reading source text needs no DOM, so the renderer project hosting it
 * costs nothing.
 */
const REPO_ROOT = join((import.meta as unknown as { dirname?: string }).dirname ?? join(process.cwd(), 'src'), '..')

/**
 * Comments legitimately contain channel names, method names and braces — `electron/ipc.ts` explains
 * several channels by naming them, and a JSDoc in the bridge contains `{ owner, repo }`. Only
 * executable text may satisfy these assertions, and only executable text may be scanned for structure.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function read(...segments: string[]): string {
  return withoutComments(readFileSync(join(REPO_ROOT, ...segments), 'utf-8'))
}

const IPC = read('electron', 'ipc.ts')
const PRELOAD = read('electron', 'preload.ts')

/**
 * Every channel `registerIpcHandlers` answers. `\s*` spans the line break because one registration
 * (`workflow:enqueueFromIssue`) puts its channel on the next line, and reformatting another one that
 * way must not quietly shrink this list.
 */
function handledChannels(): string[] {
  return [...IPC.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((match) => match[1])
}

/**
 * The bridge's top-level namespaces, each sliced out by brace matching rather than by indentation.
 * There is no autoformatter in this repo, so a guard that fails when someone rewraps a line is a
 * guard people learn to dismiss. `lastIndex` is pushed past each namespace's closing brace, so a
 * nested object inside one is not mistaken for a namespace of its own.
 */
function bridgeNamespaces(): Map<string, string> {
  const body = PRELOAD.slice(PRELOAD.indexOf('exposeInMainWorld'))
  const namespaces = new Map<string, string>()
  const opener = /(\w+)\s*:\s*\{/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(body)) !== null) {
    const start = opener.lastIndex - 1
    let depth = 0
    let end = start
    for (; end < body.length; end++) {
      if (body[end] === '{') depth += 1
      else if (body[end] === '}' && (depth -= 1) === 0) break
    }
    namespaces.set(match[1], body.slice(start, end))
    opener.lastIndex = end
  }
  return namespaces
}

/**
 * Each `invoke` in the bridge, paired with the namespace it sits in and the method that owns it.
 *
 * The owner is taken as the nearest preceding `name: (` rather than by parsing the object, which
 * keeps this independent of how a method's arguments and return type happen to be wrapped —
 * `workflow.enqueueFromIssue` spreads across six lines today.
 */
function bridgeCalls(): Array<{ namespace: string; method: string; channel: string }> {
  return [...bridgeNamespaces()].flatMap(([namespace, block]) =>
    [...block.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((call) => ({
      namespace,
      method: [...block.slice(0, call.index).matchAll(/(\w+)\s*:\s*\(/g)].pop()?.[1] ?? '<unknown>',
      channel: call[1],
    })),
  )
}

describe('the IPC surface', () => {
  /**
   * The guard on the guards, and the reason it is the first test in the file.
   *
   * Every assertion below compares two derived collections, so a regex that stops matching — a
   * rename, a reformat, a `handle` call written some new way — makes them both empty and every one of
   * them pass vacuously. That is the same silent-retirement shape as a vitest project whose `include`
   * matches nothing (architecture rule 8): green, and checking nothing. A lower bound rather than an
   * exact count, so adding a channel never has to touch this number; it only has to stay impossible
   * for the parsers to be reading nothing at all.
   */
  it('actually parses the surface it is about to compare', () => {
    expect(handledChannels().length).toBeGreaterThanOrEqual(20)
    expect(bridgeCalls().length).toBeGreaterThanOrEqual(20)
    expect([...bridgeNamespaces().keys()]).toEqual(expect.arrayContaining(['app', 'ai', 'github', 'workflow', 'ui']))
    // A method the owner regex failed to attribute would otherwise surface only as a confusing
    // mismatch in the naming test below, which reads as a convention violation rather than a broken
    // parser.
    expect(bridgeCalls().filter((call) => call.method === '<unknown>')).toEqual([])
  })

  it('exposes exactly the channels the main process registers', () => {
    // Set equality in both directions, which is the whole point: a channel handled but never exposed
    // is dead code the renderer cannot reach, and one exposed but never handled is an `invoke` that
    // rejects with "No handler registered" — the second is what a typo on either side produces, and
    // neither is visible to tsc because both sides are plain strings in separate files.
    const handled = handledChannels().sort()
    const exposed = bridgeCalls()
      .map((call) => call.channel)
      .sort()

    expect(exposed).toEqual(handled)
  })

  it('registers and exposes each channel exactly once', () => {
    // A duplicated `ipcMain.handle` throws at startup ("Attempted to register a second handler"), and
    // a duplicated `invoke` means two methods racing one channel. Both are copy-paste artefacts, and
    // the set comparison above would pass for either, since a duplicate changes no set.
    const duplicates = (channels: string[]) => channels.filter((c, i) => channels.indexOf(c) !== i)

    expect(duplicates(handledChannels())).toEqual([])
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
      .map((call) => `${call.namespace}.${call.method} invokes '${call.channel}'`)

    expect(misnamed).toEqual([])
  })

  it('keeps the bridge pinned to the renderer declaration tsc can check it against', () => {
    // Without this, every compile-time half of the lockstep can be switched off by deleting one
    // annotation, with no test anywhere going red — `contextBridge.exposeInMainWorld` takes `any`, so
    // the unannotated object type-checks against nothing at all. `satisfies` rather than a type
    // annotation is load-bearing too: an annotation widens each function to the declared type and
    // stops checking what `ipcRenderer.invoke` actually returns against it.
    expect(PRELOAD).toMatch(/\}\s*satisfies\s+Window\['electronAPI'\]\s*\)/)
  })
})
