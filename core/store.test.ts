import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileStore, MAO_STORE_DEFAULTS, createStoredReadGuard, describeUnusableStoredList } from './store.ts'
import type { MaoStoreSchema } from './store.ts'
import { canonicalRepoList } from './repo-registry.ts'
import { WorkflowEngine } from './workflow-engine.ts'
import { GithubService } from './github-service.ts'
import type { QueuedTask, RepoRef } from './workflow-engine.ts'
import type { AiProviderConfig } from './ai/types.ts'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const widgets: RepoRef = { owner: 'acme', repo: 'widgets' }
const gadgets: RepoRef = { owner: 'acme', repo: 'gadgets' }

const claude: AiProviderConfig = { id: 'claude', name: 'Claude', kind: 'cli', command: 'claude' }

const pendingTask: QueuedTask = {
  id: 'task-1',
  title: 'Pending task',
  repo: widgets,
  stage: 'issue',
  history: [],
  status: 'pending',
  autoAdvance: false,
  github: {},
}

/**
 * The shapes a hand-edit can leave behind, and the phrase each must produce. Shared by every field's
 * table so a field cannot be covered for fewer shapes than its neighbours — the object is issue #60's
 * own repro, and the rest are what `typeof` collapses or an editor's autocomplete produces.
 */
const DISCARDED_SHAPES: Array<[unknown, string]> = [
  [{ 'acme/widgets': { owner: 'acme', repo: 'widgets' } }, 'is an object'],
  ['acme/widgets', 'is a string'],
  [42, 'is a number'],
  [true, 'is a boolean'],
  [null, 'is null'],
]

/**
 * Every field the guard has to cover, discovered from `MAO_STORE_DEFAULTS` at runtime rather than typed
 * out here.
 *
 * `core/store.ts` derives the same set at the type level (`StoredListField`, a mapped type over
 * `MaoStoreSchema`), so tsc already refuses a new array-typed field that nobody wrote a recovery hint
 * for. This is the runtime half of that, and it is not redundant: `MAO_STORE_DEFAULTS` is the other file
 * a new field must be added to, so deriving from it means a field can be missed here only by being
 * missed there too — in which case `FileStore`'s `structuredClone(MAO_STORE_DEFAULTS)` would never fill
 * it in and the field has a bigger problem than this guard.
 */
const GUARDED_FIELDS = (Object.keys(MAO_STORE_DEFAULTS) as Array<keyof MaoStoreSchema>).filter((field) =>
  Array.isArray(MAO_STORE_DEFAULTS[field]),
)

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
    for (const [githubRepos, expectedPhrase] of DISCARDED_SHAPES) {
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

describe('every array-typed field is guarded', () => {
  it('coerces and reports for each of them, with no field left to throw', () => {
    // The regression that made this a table rather than one field: `githubRepos` was guarded and the
    // other two were not, so a hand-edit to either still took the app down — `workflowTasks` hardest of
    // all, since it threw inside `createMaoApp()` and left no `mao` command able to run at all.
    expect(GUARDED_FIELDS).toEqual(['githubRepos', 'aiProviders', 'workflowTasks'])

    for (const field of GUARDED_FIELDS) {
      const reports: string[] = []
      const guard = createStoredReadGuard('/tmp/config.json', (message) => reports.push(message))

      expect(guard(field, 'nonsense' as never)).toEqual([])
      expect(reports).toHaveLength(1)
      expect(reports[0]).toContain(`"${field}"`)
    }
  })

  it('gives each field its own recovery command, not a shared one', () => {
    // A hint is only actionable if it names the write that heals *this* field, and the three differ in
    // what gates them: `repos add` is blocked by the write-permission preflight, `workflow enqueue`
    // would heal the queue by running the whole unattended pipeline. So each field names the cheapest
    // unconditional, side-effect-free write instead, and a copy-pasted hint must fail here.
    const hintFor = (field: keyof MaoStoreSchema) =>
      describeUnusableStoredList(field, {}, '/tmp/config.json')!

    expect(hintFor('githubRepos')).toContain('mao repos remove')
    expect(hintFor('aiProviders')).toContain('mao config import-providers')
    expect(hintFor('workflowTasks')).toContain('mao workflow clear-completed')

    // And each names only its own, so a reader cannot be sent to another field's command.
    expect(hintFor('aiProviders')).not.toContain('mao repos')
    expect(hintFor('workflowTasks')).not.toContain('mao repos')
    expect(hintFor('githubRepos')).not.toContain('mao workflow')
  })
})

describe('FileStore aiProviders read guard', () => {
  it('reads a stored list back unchanged, and says nothing about it', () => {
    const warn = captureWarnings()
    const { store } = storeHolding({ aiProviders: [claude] })

    expect(store.get('aiProviders')).toEqual([claude])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports every shape it discards, not only the keyed object', () => {
    // A shared spy would see only the first report (the guard dedups per field), so a regression that
    // made null, strings, numbers or booleans discard *silently* would pass a loop that only checked
    // the returned value.
    for (const [aiProviders, expectedPhrase] of DISCARDED_SHAPES) {
      const warn = captureWarnings()
      const { store, filePath } = storeHolding({ aiProviders })

      expect(store.get('aiProviders')).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      const message = warn.mock.calls[0]![0] as string
      expect(message).toContain('"aiProviders"')
      expect(message).toContain(expectedPhrase)
      expect(message).toContain(filePath)

      warn.mockRestore()
    }
  })

  it("returns a value the expression `mao config show` runs can consume", () => {
    // Copies cli/index.ts's redaction expression rather than driving the command, which would need the
    // whole commander program. Before the guard this threw `store.get(...).map is not a function`, so
    // `mao config show` — the one command an operator runs to find out what state they are in — was the
    // command the broken state killed.
    captureWarnings()
    const { store } = storeHolding({ aiProviders: { claude } })

    const providers = store.get('aiProviders')

    expect(() =>
      providers.map((provider) => ({ ...provider, apiKey: provider.apiKey ? '[set]' : undefined })),
    ).not.toThrow()
    expect(providers).toEqual([])
  })

  it('names the recovery that needs no GitHub token', () => {
    // `import-providers` is unconditional — unlike `repos add`, nothing preflights it — which matters
    // because a provider list is exactly what an operator hand-edits when they have no working token.
    const warn = captureWarnings()
    const { store, filePath } = storeHolding({ aiProviders: 'claude' })

    store.get('aiProviders')

    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain('mao config import-providers')
    expect(message).toContain(filePath)
    // The apiKey warning: a provider config is the one stored list whose contents exist nowhere else.
    expect(message).toContain('apiKey')
  })

  it('does not repair the file — only a write does', () => {
    const warn = captureWarnings()
    const corrupt = { claude }
    const { store, filePath } = storeHolding({ aiProviders: corrupt })

    store.get('aiProviders')
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual(corrupt)

    store.set('aiProviders', [claude])

    expect(new FileStore(filePath).get('aiProviders')).toEqual([claude])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('hands back a fresh array rather than the shared default', () => {
    captureWarnings()
    const { store } = storeHolding({ aiProviders: 7 })

    store.get('aiProviders').push(claude)

    expect(store.get('aiProviders')).toEqual([])
    expect(MAO_STORE_DEFAULTS.aiProviders).toEqual([])
  })
})

describe('FileStore workflowTasks read guard', () => {
  it('reads a stored queue back unchanged, and says nothing about it', () => {
    const warn = captureWarnings()
    const { store } = storeHolding({ workflowTasks: [pendingTask] })

    expect(store.get('workflowTasks')).toEqual([pendingTask])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports every shape it discards, not only the keyed object', () => {
    for (const [workflowTasks, expectedPhrase] of DISCARDED_SHAPES) {
      const warn = captureWarnings()
      const { store, filePath } = storeHolding({ workflowTasks })

      expect(store.get('workflowTasks')).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      const message = warn.mock.calls[0]![0] as string
      expect(message).toContain('"workflowTasks"')
      expect(message).toContain(expectedPhrase)
      expect(message).toContain(filePath)

      warn.mockRestore()
    }
  })

  it('returns a value WorkflowEngine.restore() can consume', () => {
    // The throw this guard exists for, at the site that produced it: `restore()` does `tasks.map(...)`,
    // and it is called from `createMaoApp()` — so before the guard, a non-array `workflowTasks` failed
    // every `mao` command and made `registerIpcHandlers()` register nothing. `resume` is left off, so
    // this reaches no provider and no GitHub call.
    captureWarnings()
    const { store } = storeHolding({ workflowTasks: { 'task-1': pendingTask } })

    const engine = new WorkflowEngine(new GithubService())

    expect(() => engine.restore(store.get('workflowTasks'))).not.toThrow()
    expect(engine.getTasks()).toEqual([])
  })

  it('names the queue write that performs no GitHub write, and where the lost work went', () => {
    // `clear-completed` over `enqueue`: both heal the field, and only one of them does so without
    // running the pipeline. The label pointer is the other half — the coerced queue is empty, so the
    // one thing the operator has lost is any record of what was in flight.
    const warn = captureWarnings()
    const { store, filePath } = storeHolding({ workflowTasks: 'task-1' })

    store.get('workflowTasks')

    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain('mao workflow clear-completed')
    expect(message).toContain('workflow-active')
    expect(message).toContain(filePath)
  })

  it('does not repair the file — only a write does', () => {
    const warn = captureWarnings()
    const corrupt = { 'task-1': pendingTask }
    const { store, filePath } = storeHolding({ workflowTasks: corrupt })

    store.get('workflowTasks')
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual(corrupt)

    store.set('workflowTasks', [pendingTask])

    expect(new FileStore(filePath).get('workflowTasks')).toEqual([pendingTask])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('hands back a fresh array rather than the shared default', () => {
    captureWarnings()
    const { store } = storeHolding({ workflowTasks: 7 })

    store.get('workflowTasks').push(pendingTask)

    expect(store.get('workflowTasks')).toEqual([])
    expect(MAO_STORE_DEFAULTS.workflowTasks).toEqual([])
  })
})

describe('describeUnusableStoredList', () => {
  it('reports nothing for a list', () => {
    for (const field of GUARDED_FIELDS) {
      expect(describeUnusableStoredList(field, [], '/tmp/config.json')).toBeNull()
    }
    expect(describeUnusableStoredList('githubRepos', [widgets], '/tmp/config.json')).toBeNull()
    expect(describeUnusableStoredList('aiProviders', [claude], '/tmp/config.json')).toBeNull()
    expect(describeUnusableStoredList('workflowTasks', [pendingTask], '/tmp/config.json')).toBeNull()
  })

  it('reports nothing for a field that is not a list at all', () => {
    // `githubToken` is a string and `theme` a union of literals; a guard that described them as a
    // "JSON array of ..." would send the operator looking for a bug that is not there.
    expect(describeUnusableStoredList('githubToken', 'ghp_x', '/tmp/config.json')).toBeNull()
    expect(describeUnusableStoredList('githubToken', 42, '/tmp/config.json')).toBeNull()
    expect(describeUnusableStoredList('theme', 'dark', '/tmp/config.json')).toBeNull()
    expect(describeUnusableStoredList('buildSha', null, '/tmp/config.json')).toBeNull()
  })

  it('distinguishes null from an object, for every guarded field', () => {
    // `typeof` prints `object` for both, and they are the two likeliest hand-edits — an operator told
    // "is an object" about a `null` would go looking for the wrong thing.
    for (const field of GUARDED_FIELDS) {
      expect(describeUnusableStoredList(field, null, '/tmp/config.json')).toContain('is null')
      expect(describeUnusableStoredList(field, {}, '/tmp/config.json')).toContain('is an object')
      expect(describeUnusableStoredList(field, 'x', '/tmp/config.json')).toContain('is a string')
      expect(describeUnusableStoredList(field, undefined, '/tmp/config.json')).toContain('is absent')
    }
  })

  it('never prints the value, whatever the value was', () => {
    // `config.json` is one JSON blob that also holds `githubToken` in plaintext, and a malformed field
    // is exactly the hand-edit that can leave a fragment of a neighbouring key inside it. The report
    // therefore describes the shape and stops — a `String(value)` or a JSON dump would put a token in
    // the operator's terminal, their scrollback and any agent log reading it.
    const secretish = { token: 'ghp_liveSecretValue', nested: ['ghp_anotherSecret'] }

    for (const field of GUARDED_FIELDS) {
      const message = describeUnusableStoredList(field, secretish, '/tmp/config.json')!
      expect(message).toContain('is an object')
      expect(message).not.toContain('ghp_liveSecretValue')
      expect(message).not.toContain('ghp_anotherSecret')
    }
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

  it('touches no field that is not a guarded list', () => {
    const reports: string[] = []
    const guard = createStoredReadGuard('/tmp/config.json', (message) => reports.push(message))

    expect(guard('githubToken', 'ghp_x')).toBe('ghp_x')
    expect(guard('theme', 'dark')).toBe('dark')
    expect(guard('buildSha', 'abc123')).toBe('abc123')
    expect(reports).toEqual([])
  })

  it('dedups per field, so a file that broke two fields reports both', () => {
    // The dedup exists because reads are far more frequent than the problem, not because one report
    // per process is enough — each field names a different recovery command, so collapsing the two
    // would leave the operator healing one field and none the wiser about the other.
    const reports: string[] = []
    const guard = createStoredReadGuard('/tmp/config.json', (message) => reports.push(message))

    guard('githubRepos', {} as unknown as RepoRef[])
    guard('aiProviders', {} as unknown as AiProviderConfig[])
    guard('githubRepos', {} as unknown as RepoRef[])
    guard('aiProviders', {} as unknown as AiProviderConfig[])

    expect(reports).toHaveLength(2)
    expect(reports[0]).toContain('"githubRepos"')
    expect(reports[1]).toContain('"aiProviders"')
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

    // Stated as "every read of the raw backend is wrapped" rather than by matching the body of `get`,
    // which would make the assertion depend on this file's indentation — there is no autoformatter to
    // keep that stable, and a guard that fails for a reformat is a guard people learn to dismiss.
    const raw = [...source.matchAll(new RegExp(`${backend}\\.get\\(`, 'g'))]
    const wrapped = [...source.matchAll(new RegExp(`${guard}\\(\\s*key\\s*,\\s*${backend}\\.get\\(`, 'g'))]

    expect(raw.length).toBeGreaterThan(0)
    expect(wrapped.length).toBe(raw.length)
  })

  it("builds the guard with the backend's own resolved config path", () => {
    // Requirement 2 is an *actionable* message, and the only thing that makes it actionable in the GUI is
    // the real file path — a hand-written literal would name a file the operator does not have. The
    // backend's variable name is derived rather than hardcoded so a rename stays free.
    const backend = source.match(/const\s+(\w+)\s*=\s*new Store</)?.[1]
    expect(backend, 'electron/store.ts must construct an electron-store instance').toBeTruthy()

    expect(source).toMatch(new RegExp(`createStoredReadGuard\\(\\s*${backend}\\.path\\s*\\)`))
  })

  it('exports only the guarded store, never the raw backend', () => {
    // Keeping the electron-store instance exported would leave the bypass one import away, and an
    // `ipcMain.handle` that reached for it would read past the guard with nothing to flag it.
    const exported = [...source.matchAll(/^export\s+(?:const|let|var|function|class)\s+(\w+)/gm)].map((m) => m[1])

    expect(exported).toEqual(['store'])
    expect(source).toMatch(/export const store: MaoStore\b/)
  })
})
