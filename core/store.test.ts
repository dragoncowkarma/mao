import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStore, MAO_STORE_DEFAULTS, createStoredReadGuard, describeUnusableRepoList } from './store.ts'
import type { MaoStoreSchema } from './store.ts'
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
    // The unconditional recovery is named first: a removal registers nothing, so it is exempt from the
    // write-permission preflight, while `repos add` needs a working token — and a missing token is a
    // likely reason the operator was editing config.json in the first place.
    expect(message).toContain('mao repos remove')
    expect(message.indexOf('mao repos remove')).toBeLessThan(message.indexOf('mao repos add'))
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
  /**
   * A guard over a mutable bag standing in for a backend's own storage, so a test can change the
   * "file" under it — which is the only way to observe that `problems()` re-derives its answer rather
   * than replaying what an earlier read happened to see.
   */
  function guardOver(initial: Partial<MaoStoreSchema> & Record<string, unknown>) {
    const raw = { ...MAO_STORE_DEFAULTS, ...initial } as MaoStoreSchema
    const reports: string[] = []
    const guard = createStoredReadGuard('/tmp/config.json', (key) => raw[key], (message) => reports.push(message))
    return { guard, reports, raw }
  }

  it('reports through the injected reporter', () => {
    const { guard, reports } = guardOver({ githubRepos: {} as unknown as RepoRef[] })

    expect(guard.read('githubRepos')).toEqual([])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain('/tmp/config.json')
  })

  it('touches no field but githubRepos', () => {
    const { guard, reports } = guardOver({ githubToken: 'ghp_x', theme: 'dark' })

    expect(guard.read('githubToken')).toBe('ghp_x')
    expect(guard.read('theme')).toBe('dark')
    expect(guard.problems()).toEqual([])
    expect(reports).toEqual([])
  })

  it('answers problems() without a prior read, and without reporting again', () => {
    // The point of the query existing at all. `mao config show` builds one JSON object and the GUI polls
    // a channel; neither can be made to depend on some other call having read the field first, and
    // neither may turn a 30s poll into 30s of repeated stderr paragraphs.
    const { guard, reports } = guardOver({ githubRepos: 'acme/widgets' as unknown as RepoRef[] })

    expect(guard.problems()).toEqual([{ key: 'githubRepos', message: expect.stringContaining('is a string') }])
    expect(guard.problems()).toHaveLength(1)
    expect(reports).toEqual([])
  })

  it('stops reporting a problem once the stored value is usable again', () => {
    // A flag that latched would be worse than none: an operator who has just fixed `config.json` and
    // still sees the warning cannot tell a working fix from a failed one. `problems()` re-reads, so the
    // next poll after a healing list write says nothing.
    const { guard, raw } = guardOver({ githubRepos: null as unknown as RepoRef[] })
    expect(guard.problems()).toHaveLength(1)

    raw.githubRepos = [widgets]

    expect(guard.problems()).toEqual([])
    expect(guard.read('githubRepos')).toEqual([widgets])
  })

  it('reports exactly the fields it corrects', () => {
    // `read` and `problems` name the guarded field independently, so a change to one has to be a change
    // to both: a problem reported for a field nothing coerces is a warning about a non-problem, and a
    // coercion with no problem to report is issue #60's silence all over again. Every schema field is
    // given a value its declared type forbids so neither side can pass by ignoring the question.
    const corrupt = {
      githubToken: 1 as unknown as string,
      githubRepos: {} as unknown as RepoRef[],
      aiProviders: 'nope' as unknown as MaoStoreSchema['aiProviders'],
      workflowTasks: null as unknown as MaoStoreSchema['workflowTasks'],
      buildSha: [] as unknown as string,
      theme: 7 as unknown as MaoStoreSchema['theme'],
    } satisfies MaoStoreSchema
    const { guard } = guardOver(corrupt)

    const corrected = (Object.keys(corrupt) as Array<keyof MaoStoreSchema>).filter(
      (key) => guard.read(key) !== corrupt[key],
    )

    expect(guard.problems().map((problem) => problem.key)).toEqual(corrected)
    expect(corrected).toEqual(['githubRepos'])
  })

  it('never puts the stored value in the report', () => {
    // `githubToken` sits in plaintext in the same JSON blob, and this message now travels further than
    // stderr — into `mao config show`'s consumers, an IPC payload, and a sidebar an operator may be
    // screen-sharing. So the report names the value's *type*; echoing what it found is the one thing it
    // must never do, whatever an operator managed to paste into the field. Keys are as disclosing as
    // values here, which is why both halves are asserted — and why both are spelled distinctively
    // enough not to collide with the message's own prose, which does legitimately mention a token.
    const secretKey = 'pasted-credential-XYZZY'
    const secretValue = 'ghp_averyrealtokenshapedstring'
    const { guard } = guardOver({ githubRepos: { [secretKey]: secretValue } as unknown as RepoRef[] })

    const [problem] = guard.problems()

    expect(problem.message).toContain('is an object')
    expect(problem.message).not.toContain(secretValue)
    expect(problem.message).not.toContain(secretKey)
  })
})

describe('FileStore.problems()', () => {
  it('reports the unusable list it discarded on read', () => {
    captureWarnings()
    const { store, filePath } = storeHolding({ githubRepos: { 'acme/widgets': widgets } })

    expect(store.get('githubRepos')).toEqual([])
    expect(store.problems()).toEqual([{ key: 'githubRepos', message: expect.stringContaining(filePath) }])
  })

  it('reports nothing for a file it can read', () => {
    const { store } = storeHolding({ githubRepos: [widgets, gadgets] })

    expect(store.problems()).toEqual([])
  })

  it('goes quiet after the write that heals the file', () => {
    // The whole recovery story, end to end: the guard does not repair, so the unusable value survives
    // until something writes the list — and the diagnostic has to follow the file, not the process.
    captureWarnings()
    const { store } = storeHolding({ githubRepos: 'acme/widgets' })
    expect(store.problems()).toHaveLength(1)

    store.set('githubRepos', [widgets])

    expect(store.problems()).toEqual([])
    expect(store.get('githubRepos')).toEqual([widgets])
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

  it('routes its reads through core\'s guard', () => {
    const guard = source.match(/const\s+(\w+)\s*=\s*createStoredReadGuard\(/)?.[1]
    expect(guard, 'electron/store.ts must build a guard with createStoredReadGuard()').toBeTruthy()

    const backend = source.match(/const\s+(\w+)\s*=\s*new Store</)?.[1]
    expect(backend, 'electron/store.ts must construct an electron-store instance').toBeTruthy()

    // The guard now takes the backend's read once instead of a value per call, so "wrapped" stopped
    // being a property each call site has to get right: there is exactly one raw read in the file, and
    // tsc will not compile a `createStoredReadGuard` without one. Both exported readers are then stated
    // as delegations, which is what says that single raw read is the guard's and not a bypass. Matching
    // the returned expressions rather than the bodies keeps this independent of indentation — there is
    // no autoformatter here, and a guard that fails for a reformat is one people learn to dismiss.
    const raw = [...source.matchAll(new RegExp(`${backend}\\.get\\(`, 'g'))]
    expect(raw.length, `every ${backend}.get() must be the one handed to the guard`).toBe(1)

    expect(source).toMatch(new RegExp(`return\\s+${guard}\\.read\\(\\s*key\\s*\\)`))
    expect(source).toMatch(new RegExp(`return\\s+${guard}\\.problems\\(\\s*\\)`))
  })

  it("builds the guard with the backend's own resolved config path", () => {
    // Requirement 2 is an *actionable* message, and the only thing that makes it actionable in the GUI is
    // the real file path — a hand-written literal would name a file the operator does not have. The
    // backend's variable name is derived rather than hardcoded so a rename stays free.
    const backend = source.match(/const\s+(\w+)\s*=\s*new Store</)?.[1]
    expect(backend, 'electron/store.ts must construct an electron-store instance').toBeTruthy()

    expect(source).toMatch(new RegExp(`createStoredReadGuard\\(\\s*${backend}\\.path\\s*,`))
  })

  it('exports only the guarded store, never the raw backend', () => {
    // Keeping the electron-store instance exported would leave the bypass one import away, and an
    // `ipcMain.handle` that reached for it would read past the guard with nothing to flag it.
    const exported = [...source.matchAll(/^export\s+(?:const|let|var|function|class)\s+(\w+)/gm)].map((m) => m[1])

    expect(exported).toEqual(['store'])
    expect(source).toMatch(/export const store: MaoStore\b/)
  })
})
