import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FileStore,
  MAO_STORE_DEFAULTS,
  createStoredReadGuard,
  describeStoredProblems,
  describeUnusableRepoList,
  createGuardedStore,
  type MaoStoreSchema,
  type StoredValueBackend,
} from './store.ts'
import { canonicalRepoList } from './repo-registry.ts'
import type { RepoRef } from './workflow-engine.ts'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const widgets: RepoRef = { owner: 'acme', repo: 'widgets' }
const gadgets: RepoRef = { owner: 'acme', repo: 'gadgets' }

/**
 * A real `config.json` holding exactly `contents`, opened through a real `FileStore`.
 *
 * Written as raw JSON rather than through `store.set`, which cannot produce a value the schema forbids
 * — a hand-edited file, or one an older build wrote, can, and that is the whole subject here.
 */
function storeHolding(contents: unknown): { store: FileStore; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-store-test-'))
  tmpDirs.push(dir)
  const filePath = path.join(dir, 'config.json')
  fs.writeFileSync(filePath, JSON.stringify(contents, null, 2))
  return { store: new FileStore(filePath), filePath }
}

/** Captures the guard's report instead of letting it print, and keeps test output readable. */
function captureWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('FileStore githubRepos read guard', () => {
  it('reads a stored list back unchanged, and says nothing about it', () => {
    const warn = captureWarnings()
    const { store } = storeHolding({ githubRepos: [widgets, gadgets] })

    expect(store.get('githubRepos')).toEqual([widgets, gadgets])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports every shape it discards, not only the keyed object', () => {
    // A shared spy would see only the first report (the guard dedups per field), so a regression that
    // made null, strings, numbers or booleans discard *silently* would pass a loop that only checked the
    // returned value. Requirement 3 of issue #60 is that nothing is dropped without saying so, and it has
    // to be pinned for every shape a hand-edit can leave behind — the first is the issue's own repro.
    const shapes: Array<[unknown, string]> = [
      [{ 'acme/widgets': { owner: 'acme', repo: 'widgets' } }, 'is an object'],
      ['acme/widgets', 'is a string'],
      [42, 'is a number'],
      [true, 'is a boolean'],
      [null, 'is null'],
    ]

    for (const [githubRepos, expectedPhrase] of shapes) {
      const warn = captureWarnings()
      const { store, filePath } = storeHolding({ githubRepos })

      expect(store.get('githubRepos')).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      const message = warn.mock.calls[0]![0] as string
      expect(message).toContain(expectedPhrase)
      expect(message).toContain(filePath)

      warn.mockRestore()
    }
  })

  it('names the field, what the file actually holds, and the file itself', () => {
    // The message the operator used to get was `store.get(...).filter is not a function`, from which
    // neither the field, the file, nor the way out was recoverable. Requirement 2 of issue #60 is that
    // all three are.
    const warn = captureWarnings()
    const { store, filePath } = storeHolding({ githubRepos: { 'acme/widgets': widgets } })

    store.get('githubRepos')

    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain('"githubRepos"')
    expect(message).toContain('is an object')
    expect(message).toContain(filePath)
    // The unconditional recovery is named first: neither a removal nor the GUI's Reset registers
    // anything, so neither is preflighted, while `repos add` needs a working token — and a missing token
    // is a likely reason the operator was editing config.json in the first place.
    expect(message).toContain('mao repos remove')
    expect(message.indexOf('mao repos remove')).toBeLessThan(message.indexOf('mao repos add'))
    // Names the sidebar control that exists when the list is unusable. Remove lives in a project's
    // Settings tab, which needs a selected project — and an unusable list leaves no row to select.
    expect(message).toContain('Reset stored list')
  })

  it('reports once, however many times the list is read', () => {
    // Auto-trigger re-reads the list on every 5s tick and `mao run` runs for days, so a per-read report
    // would bury every other line of output. Once per process is what makes it non-silent without that.
    const warn = captureWarnings()
    const { store } = storeHolding({ githubRepos: { 'acme/widgets': widgets } })

    store.get('githubRepos')
    store.get('githubRepos')
    store.get('githubRepos')

    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('leaves every other field readable', () => {
    // A guard that disturbed the fields around it would trade one wedged app for another: `loadApp()`
    // reads githubToken, aiProviders and workflowTasks on the way to every command.
    captureWarnings()
    const { store } = storeHolding({ githubToken: 'ghp_x', theme: 'dark', githubRepos: 'nonsense' })

    expect(store.get('githubToken')).toBe('ghp_x')
    expect(store.get('theme')).toBe('dark')
    expect(store.get('githubRepos')).toEqual([])
  })

  it('does not repair the file — only a write does', () => {
    // Deliberately not a repair: a command that merely reads must leave the file as it found it, so the
    // operator keeps the chance to salvage what the unusable value named (issue #60 requirement 3).
    const warn = captureWarnings()
    const { store, filePath } = storeHolding({ githubRepos: { 'acme/widgets': widgets } })

    store.get('githubRepos')
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).githubRepos).toEqual({ 'acme/widgets': widgets })

    store.set('githubRepos', [widgets])

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).githubRepos).toEqual([widgets])
    // Reopened, because the recovery has to survive the process that performed it.
    const reopened = new FileStore(filePath)
    expect(reopened.get('githubRepos')).toEqual([widgets])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('survives a write to an unrelated field', () => {
    // What makes the report's "copy any repositories you still need out of <file> first" advice truthful.
    // `persist()` rewrites the whole blob on every `set`, so an unrelated field's write is the likeliest
    // way the unusable value would have been destroyed before the operator ever read the message.
    captureWarnings()
    const corrupt = { 'acme/widgets': widgets }
    const { store, filePath } = storeHolding({ githubRepos: corrupt })

    store.get('githubRepos')
    store.set('githubToken', 'ghp_x')

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).githubRepos).toEqual(corrupt)
  })

  it('hands back a fresh array for an absent field too, not the shared default', () => {
    // The other half of the same property, and the one that bites without any corruption at all: a
    // shallow spread of MAO_STORE_DEFAULTS copies each default's reference, so a caller that pushed into
    // the empty list it read leaked a phantom entry into the module default — which the next FileStore
    // in that process read back as a tracked repository, for auto-trigger to poll.
    const { store } = storeHolding({ githubToken: 'ghp_x' })

    store.get('githubRepos').push(widgets)

    expect(MAO_STORE_DEFAULTS.githubRepos).toEqual([])
    expect(storeHolding({}).store.get('githubRepos')).toEqual([])
  })

  it('hands back a fresh array rather than the shared default', () => {
    // `MAO_STORE_DEFAULTS.githubRepos` is one array instance for the whole process. Returning it would
    // let a single caller that pushes into what it read poison every later read of every field's default.
    captureWarnings()
    const { store } = storeHolding({ githubRepos: 7 })

    store.get('githubRepos').push(widgets)

    expect(store.get('githubRepos')).toEqual([])
    expect(MAO_STORE_DEFAULTS.githubRepos).toEqual([])
  })

  it('leaves element-level validity to repo-registry', () => {
    // The boundary PR #57 drew: `isRepoRef`/`canonicalRepoList` own which *entries* are usable, and they
    // need to see the junk to drop it. This guard owns the *container* only — the gap issue #60 found.
    captureWarnings()
    const { store } = storeHolding({ githubRepos: [null, widgets] })

    expect(store.get('githubRepos')).toEqual([null, widgets])
    expect(canonicalRepoList(store.get('githubRepos'), store.get('githubRepos'))).toEqual([widgets])
  })

  it('returns a value the expression auto-trigger runs per tick can consume', () => {
    // Deliberately named for what it checks and no more: it copies core/auto-trigger.ts's
    // `canonicalRepoList(repos, repos)` rather than driving the scheduler, so it would stay green if
    // auto-trigger stopped calling that. It is still the legible pin for issue #60's fourth symptom —
    // that expression threw `previous is not iterable` and, because `tick()` is called bare, took `mao
    // run` down as an unhandled rejection. Driving the real scheduler fails only through vitest's
    // unhandled-rejection reporter, which reads as a passing suite with a non-zero exit.
    captureWarnings()
    const { store } = storeHolding({ githubRepos: { 'acme/widgets': widgets } })

    const repos = store.get('githubRepos')

    expect(() => canonicalRepoList(repos, repos)).not.toThrow()
    expect(canonicalRepoList(repos, repos)).toEqual([])
  })
})

describe('MaoStore.problems', () => {
  it('reports nothing for a healthy store', () => {
    const { store } = storeHolding({ githubRepos: [widgets] })

    expect(store.problems()).toEqual([])
  })

  it('answers without needing the field to have been read first', () => {
    // The property the GUI depends on. The guard only learns about a field when something reads it, so
    // a list recorded as reads happen would answer "no problems" until `github:getRepos` had run — and
    // the renderer polls this over a *different* channel, so the order of two IPC calls would decide
    // whether the operator was ever told.
    const warn = captureWarnings()
    const { store, filePath } = storeHolding({ githubRepos: { 'acme/widgets': widgets } })

    const problems = store.problems()

    expect(problems).toHaveLength(1)
    expect(problems[0]!.field).toBe('githubRepos')
    expect(problems[0]!.source).toBe(filePath)
    expect(problems[0]!.message).toContain('is an object')
    // A query, not a read: it must not consume the guard's one report, or polling it would decide
    // whether the CLI's own stderr line ever appeared.
    expect(warn).not.toHaveBeenCalled()
  })

  it('stops reporting once a list write has replaced the value, and repairs nothing itself', () => {
    captureWarnings()
    const { store, filePath } = storeHolding({ githubRepos: 'acme/widgets' })

    expect(store.problems()).toHaveLength(1)
    // Still on disk — querying is not a repair, so the operator can still salvage from the file.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).githubRepos).toBe('acme/widgets')

    store.set('githubRepos', [])

    expect(store.problems()).toEqual([])
    expect(new FileStore(filePath).problems()).toEqual([])
  })
})

/**
 * A backend that behaves the way electron-store's does — a key the file does not hold comes back
 * `undefined`, not a schema default. `FileStore`'s own snapshot never does that, which is exactly the
 * divergence `createGuardedStore` exists to iron out, so the fake has to model the harder one.
 */
function fakeBackend(contents: Partial<Record<keyof MaoStoreSchema, unknown>> = {}) {
  const data: Record<string, unknown> = { ...contents }
  const backend: StoredValueBackend = {
    get: <K extends keyof MaoStoreSchema>(key: K) => data[key] as MaoStoreSchema[K] | undefined,
    set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
      data[key] = value
    },
  }
  return { backend, data }
}

describe('createGuardedStore', () => {
  it('reports from the raw stored value, not from what the guard already replaced', () => {
    // The whole GUI half of issue #60 rests on this distinction, and it is invisible to a source-text
    // check: hand `problems()` the *guarded* value and it sees the schema default the guard just
    // substituted, answers "nothing is wrong" for every corrupt store, and the packaged app goes blind
    // again with every other assertion still green.
    const { backend } = fakeBackend({ githubRepos: { 'acme/widgets': widgets } })
    const reports: string[] = []
    const store = createGuardedStore(backend, '/data/config.json', (message) => reports.push(message))

    expect(store.get('githubRepos')).toEqual([])
    expect(store.problems().map((problem) => problem.field)).toEqual(['githubRepos'])
    expect(store.problems()[0]!.source).toBe('/data/config.json')
    expect(reports).toHaveLength(1)
  })

  it('fills a key the backend does not have from the schema, and calls that no problem', () => {
    // conf merges `defaults` only when it first writes the file, so a key an operator deletes by hand
    // comes back `undefined` — which must read as "the default applies", not as a discarded value, or
    // the GUI shows a corruption card offering a destructive reset while the CLI reports clean.
    const { backend } = fakeBackend()
    const reports: string[] = []
    const store = createGuardedStore(backend, '/data/config.json', (message) => reports.push(message))

    expect(store.get('githubRepos')).toEqual([])
    expect(store.problems()).toEqual([])
    expect(reports).toEqual([])
    // And it is the caller's array, not the shared default.
    store.get('githubRepos').push(widgets)
    expect(MAO_STORE_DEFAULTS.githubRepos).toEqual([])
    expect(store.get('githubRepos')).toEqual([])
  })

  it('writes through, and a write is what clears the report', () => {
    const { backend, data } = fakeBackend({ githubRepos: 'acme/widgets' })
    const store = createGuardedStore(backend, '/data/config.json', () => {})

    expect(store.problems()).toHaveLength(1)
    store.set('githubRepos', [widgets])

    expect(data.githubRepos).toEqual([widgets])
    expect(store.get('githubRepos')).toEqual([widgets])
    expect(store.problems()).toEqual([])
  })
})

describe('describeStoredProblems', () => {
  it('reports the fields the schema cannot use, from whatever raw values it is handed', () => {
    // Driven by a raw reader rather than a store, because that is what lets the two backends share it:
    // FileStore hands it its in-memory snapshot, electron/store.ts hands it electron-store's live get.
    const raw = { ...structuredClone(MAO_STORE_DEFAULTS), githubRepos: 7 } as unknown as MaoStoreSchema

    const problems = describeStoredProblems((key) => raw[key], '/tmp/config.json')

    expect(problems.map((problem) => problem.field)).toEqual(['githubRepos'])
    expect(problems[0]!.source).toBe('/tmp/config.json')
    expect(describeStoredProblems((key) => structuredClone(MAO_STORE_DEFAULTS)[key], '/tmp/c.json')).toEqual([])
  })
})

describe('describeUnusableRepoList', () => {
  it('reports nothing for a list', () => {
    expect(describeUnusableRepoList([], '/tmp/config.json')).toBeNull()
    expect(describeUnusableRepoList([widgets], '/tmp/config.json')).toBeNull()
  })

  it('distinguishes null from an object', () => {
    // `typeof` prints `object` for both, and they are the two likeliest hand-edits — an operator told
    // "is an object" about a `null` would go looking for the wrong thing.
    expect(describeUnusableRepoList(null, '/tmp/config.json')).toContain('is null')
    expect(describeUnusableRepoList({}, '/tmp/config.json')).toContain('is an object')
    expect(describeUnusableRepoList('x', '/tmp/config.json')).toContain('is a string')
    expect(describeUnusableRepoList(undefined, '/tmp/config.json')).toContain('is absent')
  })
})

describe('createStoredReadGuard', () => {
  it('reports through the injected reporter', () => {
    const reports: string[] = []
    const guard = createStoredReadGuard('/tmp/config.json', (message) => reports.push(message))

    expect(guard('githubRepos', {} as unknown as RepoRef[])).toEqual([])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('/tmp/config.json')
  })

  it('touches no field but githubRepos', () => {
    const reports: string[] = []
    const guard = createStoredReadGuard('/tmp/config.json', (message) => reports.push(message))

    expect(guard('githubToken', 'ghp_x')).toBe('ghp_x')
    expect(guard('theme', 'dark')).toBe('dark')
    expect(reports).toEqual([])
  })
})

/**
 * The repository root, anchored to this file rather than to whatever directory vitest was started in —
 * a guard that fails with ENOENT because someone narrowed a run from a subdirectory is a guard people
 * learn to dismiss. Mirrors the anchoring in src/electron-api.test.ts.
 */
const REPO_ROOT = path.join((import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'), '..')

/** Comments may legitimately name the guard; only executable text should satisfy these assertions. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * The guard's one weakness, turned into a checked invariant.
 *
 * `MaoStore.get<K>(key): MaoStoreSchema[K]` is an assertion over unvalidated JSON, so a backend that
 * reads straight from its own storage compiles cleanly and then hands every caller a value of the wrong
 * shape — which is the bug, not a style slip. tsc cannot catch it, and the coupling ("both shipped
 * backends apply the same guard") is maintained by hand, so this asserts it the way
 * src/electron-api.test.ts asserts rule 6 and core/node-environment.test.ts asserts rule 8: by reading
 * the source. `FileStore` is covered by the behavioural tests above; Electron's backend cannot be, since
 * importing it from `core/` would break architecture rule 1 and `electron-store` needs a live Electron
 * app — so it is checked here as text instead.
 */
describe("electron/store.ts, the other MaoStore backend", () => {
  const source = withoutComments(fs.readFileSync(path.join(REPO_ROOT, 'electron', 'store.ts'), 'utf-8'))

  it("is core's composition and nothing else", () => {
    // What is left to check once the behaviour lives in `createGuardedStore` (covered above against a
    // fake that models conf's absent-key answer): that this file only composes, and never reaches for
    // the instance again. A second reference is the bypass — `backing.store[key]`, say, which is
    // tsc-clean, names no `get`, and would hand the renderer unvalidated values with nothing to flag it.
    const backend = source.match(/const\s+(\w+)\s*=\s*new Store</)?.[1]
    expect(backend, 'electron/store.ts must construct an electron-store instance').toBeTruthy()

    expect(source).toMatch(new RegExp(`createGuardedStore\\(\\s*${backend}\\s*,\\s*${backend}\\.path\\s*\\)`))
    // Three: where it is made, and the two arguments it is handed to core as.
    expect([...source.matchAll(new RegExp(`\\b${backend}\\b`, 'g'))]).toHaveLength(3)
  })

  it('exports only the guarded store, never the raw backend', () => {
    // Keeping the electron-store instance exported would leave the bypass one import away, and an
    // `ipcMain.handle` that reached for it would read past the guard with nothing to flag it.
    const exported = [...source.matchAll(/^export\s+(?:const|let|var|function|class)\s+(\w+)/gm)].map((m) => m[1])

    expect(exported).toEqual(['store'])
    expect(source).toMatch(/export const store: MaoStore\b/)
  })
})
