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
  describeUnusableProviderList,
  describeUnusableTaskQueue,
  describeUninspectableStore,
  findStoredQueueProblem,
  createGuardedStore,
  type MaoStoreSchema,
  type StoredValueBackend,
} from './store.ts'
import { canonicalRepoList } from './repo-registry.ts'
import { importProvidersFromFile } from './provider-import.ts'
import type { AiProviderConfig } from './ai/types.ts'
import type { QueuedTask, RepoRef } from './workflow-engine.ts'

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
 * The shapes a hand-edit can leave behind, and the phrase each must produce.
 *
 * Shared by all three fields' tables so none can end up covered for fewer shapes than its neighbours.
 * The object is issue #60's own repro; the rest are what `typeof` collapses or an editor produces.
 */
const DISCARDED_SHAPES: Array<[unknown, string]> = [
  [{ 'acme/widgets': { owner: 'acme', repo: 'widgets' } }, 'is an object'],
  ['acme/widgets', 'is a string'],
  [42, 'is a number'],
  [true, 'is a boolean'],
  [null, 'is null'],
]

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

describe('FileStore aiProviders read guard', () => {
  it('reads a stored list back unchanged, and says nothing about it', () => {
    const warn = captureWarnings()
    const { store } = storeHolding({ aiProviders: [claude] })

    expect(store.get('aiProviders')).toEqual([claude])
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps valid providers from a mixed list and reports only the invalid count', () => {
    const warn = captureWarnings()
    const leakedId = 'must-not-print-provider-id'
    const leakedKey = 'provider-key-must-not-print'
    const { store, filePath } = storeHolding({
      aiProviders: [
        claude,
        null,
        { id: leakedId, name: 'Broken', apiKey: leakedKey },
      ],
    })

    expect(store.get('aiProviders')).toEqual([claude])
    expect(store.problems().map((problem) => problem.field)).toEqual(['aiProviders'])
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain('2 invalid entries')
    expect(message).toContain('out of 3')
    expect(message).toContain(filePath)
    expect(message).toContain('maker-checker cannot select a distinct reviewer')
    expect(message).toContain('single-provider fallback may reuse that provider for review')
    expect(message).toContain('Global settings pane refuses to save its filtered view')
    expect(message).toContain('mao config import-providers')
    expect(message).not.toContain(leakedId)
    expect(message).not.toContain(leakedKey)
  })

  it('uses singular and plural grammar for invalid provider entries left on disk', () => {
    const single = describeUnusableProviderList([claude, null], '/tmp/config.json')!
    const multiple = describeUnusableProviderList([claude, null, null], '/tmp/config.json')!

    expect(single).toContain('The invalid entry is still in the file')
    expect(single).not.toContain('The invalid entries are')
    expect(single).not.toContain('those entries')
    expect(single).not.toContain('they contain')
    expect(multiple).toContain('The invalid entries are still in the file')
  })

  it('rejects the invalid list used by `config import-providers` before the durable value changes', () => {
    const { store, filePath } = storeHolding({ aiProviders: [claude] })

    expect(() => store.set('aiProviders', [null] as unknown as AiProviderConfig[])).toThrow(
      /1 invalid entry.*out of 1/,
    )

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([claude])
    expect(new FileStore(filePath).get('aiProviders')).toEqual([claude])
  })

  it('rejects a non-array prospective write before the durable provider list changes', () => {
    const { store, filePath } = storeHolding({ aiProviders: [claude] })

    expect(() => store.set('aiProviders', {} as unknown as AiProviderConfig[])).toThrow(
      /expected a JSON array, received an object.*Nothing was written/,
    )

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([claude])
  })

  it('rejects nested shape errors on write without printing provider contents', () => {
    const leakedModel = 'model-must-not-leak'
    const invalid = {
      ...claude,
      presets: [{ id: 'preset', model: leakedModel, effort: 'impossible' }],
    }
    const { store, filePath } = storeHolding({ aiProviders: [claude] })

    let message = ''
    try {
      store.set('aiProviders', [invalid] as unknown as AiProviderConfig[])
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }

    expect(message).toContain('1 invalid entry')
    expect(message).toContain(filePath)
    expect(message).not.toContain(leakedModel)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([claude])
  })

  it('rejects sparse top-level and nested arrays before JSON turns their holes into null', () => {
    const sparseProviders = Array<AiProviderConfig>(1)
    const sparseArgs = Array<string>(1)
    const providerWithSparseArgs = { ...claude, args: sparseArgs }
    const { store, filePath } = storeHolding({ aiProviders: [claude] })

    expect(() => store.set('aiProviders', sparseProviders)).toThrow(/1 invalid entry.*out of 1/)
    expect(() => store.set('aiProviders', [providerWithSparseArgs])).toThrow(
      /1 invalid entry.*out of 1/,
    )
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([claude])
  })

  it('reports every shape it discards, not only the keyed object', () => {
    // A shared spy would see only the first report (the guard dedups per field), so a regression that
    // made null, strings, numbers or booleans discard *silently* would pass a loop checking only the
    // returned value.
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

  it('returns a value the expression `mao config show` runs can consume', () => {
    // Copies cli/index.ts's redaction expression rather than driving commander. Before the rule this
    // threw `store.get(...).map is not a function`, so the one command an operator runs to find out what
    // state they are in was the command the broken state killed.
    captureWarnings()
    const { store } = storeHolding({ aiProviders: { claude } })

    const providers = store.get('aiProviders')

    expect(() =>
      providers.map((provider) => ({ ...provider, apiKey: provider.apiKey ? '[set]' : undefined })),
    ).not.toThrow()
    expect(providers).toEqual([])
  })

  it('names a recovery that needs no GitHub token, and does not claim automation is halted', () => {
    // The wording distinction from the queue's report, and it is a safety claim rather than style: an
    // empty provider list stops stages at selectAgent() before any GitHub write, so this field must not
    // tell the operator that unattended work has been halted — nothing halts for it.
    const message = describeUnusableProviderList({}, '/tmp/config.json')!

    expect(message).toContain('mao config import-providers')
    expect(message).toContain('apiKey')
    expect(message).not.toContain('halt')
    expect(message).not.toContain('confirm-queue-recovery')
  })
})

describe('FileStore workflowTasks read guard', () => {
  it('reads a stored queue back unchanged, and says nothing about it', () => {
    const warn = captureWarnings()
    const { store } = storeHolding({ workflowTasks: [pendingTask] })

    expect(store.get('workflowTasks')).toEqual([pendingTask])
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps valid tasks from a mixed list and reports only the invalid count', () => {
    const warn = captureWarnings()
    const leakedPrompt = 'prompt-must-not-print'
    const { store, filePath } = storeHolding({
      workflowTasks: [
        pendingTask,
        null,
        { ...pendingTask, id: 'broken', history: [{ prompt: leakedPrompt }] },
      ],
    })

    expect(store.get('workflowTasks')).toEqual([pendingTask])
    expect(store.problems().map((problem) => problem.field)).toEqual(['workflowTasks'])
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0]![0] as string
    expect(message).toContain('2 invalid queued tasks')
    expect(message).toContain('out of 3')
    expect(message).toContain(filePath)
    expect(message).not.toContain(leakedPrompt)
  })

  it('accepts the legacy missing-autoAdvance shape that restore migrates to true', () => {
    const warn = captureWarnings()
    const { autoAdvance: _oldField, ...legacyTask } = pendingTask
    const { store } = storeHolding({ workflowTasks: [legacyTask] })

    expect(store.get('workflowTasks')).toEqual([{ ...legacyTask, autoAdvance: true }])
    expect(store.problems()).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('validates task repository identity only and drops old registry settings on read', () => {
    const taskWithRegistrySettings = {
      ...pendingTask,
      repo: {
        owner: 'acme',
        repo: 'widgets',
        autoTrigger: 'not-task-state',
        pollIntervalMs: null,
      },
    }
    const { store } = storeHolding({ workflowTasks: [taskWithRegistrySettings] })

    expect(store.get('workflowTasks')).toEqual([
      { ...pendingTask, repo: { owner: 'acme', repo: 'widgets' } },
    ])
    expect(store.problems()).toEqual([])
  })

  it('rejects an empty repository identity even when every other task field is valid', () => {
    const invalid = { ...pendingTask, repo: { owner: '', repo: 'widgets' } }
    const { store, filePath } = storeHolding({ workflowTasks: [pendingTask] })

    expect(() => store.set('workflowTasks', [invalid] as QueuedTask[])).toThrow(/1 invalid entry.*out of 1/)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([pendingTask])
  })

  it('rejects an invalid task list before a queue write changes the durable value', () => {
    const { store, filePath } = storeHolding({ workflowTasks: [pendingTask] })

    expect(() => store.set('workflowTasks', [pendingTask, null] as unknown as QueuedTask[])).toThrow(
      /1 invalid entry.*out of 2/,
    )

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([pendingTask])
  })

  it('counts a sparse task-list hole as an invalid entry', () => {
    const sparseTasks = Array<QueuedTask>(1)
    const { store, filePath } = storeHolding({ workflowTasks: [pendingTask] })

    expect(() => store.set('workflowTasks', sparseTasks)).toThrow(/1 invalid entry.*out of 1/)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([pendingTask])
  })

  it('migrates missing autoAdvance on read but requires the current shape on new writes', () => {
    const { autoAdvance: _oldField, ...legacyTask } = pendingTask
    const { store, filePath } = storeHolding({ workflowTasks: [legacyTask] })

    expect(store.get('workflowTasks')).toEqual([{ ...legacyTask, autoAdvance: true }])
    expect(() => store.set('workflowTasks', [legacyTask] as unknown as QueuedTask[])).toThrow(
      /1 invalid entry.*out of 1/,
    )
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([legacyTask])
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

  it('says automation is halted and names the confirm command, not clear-completed', () => {
    // `mao workflow clear-completed` also emits `'change'`, so it is gated too — naming it would send
    // the operator at a command that now refuses. And it must point at the workflow-active label,
    // because the queue that recorded what was in flight is the thing that is gone.
    const message = describeUnusableTaskQueue([pendingTask, null], '/tmp/config.json')!

    expect(message).toContain('mao workflow confirm-queue-recovery')
    expect(message).toContain('workflow-active')
    expect(message).toContain('duplicate an issue, branch or PR')
    expect(message).toContain('half-finished')
    expect(message).toContain('refused')
    expect(message).not.toContain('clear-completed')
  })

  it('uses singular and plural grammar for invalid task entries left on disk', () => {
    const single = describeUnusableTaskQueue([pendingTask, null], '/tmp/config.json')!
    const multiple = describeUnusableTaskQueue([pendingTask, null, null], '/tmp/config.json')!

    expect(single).toContain('The invalid entry is still in /tmp/config.json')
    expect(single).not.toContain('The invalid entries are')
    expect(multiple).toContain('The invalid entries are still in /tmp/config.json')
  })

  it('prints no stored value, whatever the value was', () => {
    // config.json is one blob that also holds githubToken in plaintext, and a malformed field is exactly
    // the hand-edit that can leave a fragment of a neighbouring key inside it.
    const secretish = { token: 'ghp_liveSecretValue', nested: ['ghp_anotherSecret'] }

    for (const describe_ of [describeUnusableTaskQueue, describeUnusableProviderList, describeUnusableRepoList]) {
      const message = describe_(secretish, '/tmp/config.json')!
      expect(message).toContain('is an object')
      expect(message).not.toContain('ghp_liveSecretValue')
      expect(message).not.toContain('ghp_anotherSecret')
    }
  })

  it('survives a write to an unrelated field, which is what lets the next boot latch again', () => {
    // The whole no-new-persisted-state premise: FileStore.persist() rewrites this.data, whose
    // workflowTasks the guard never repaired, so only a write to *this* field heals it.
    captureWarnings()
    const corrupt = { 'task-1': pendingTask }
    const { store, filePath } = storeHolding({ workflowTasks: corrupt })

    store.get('workflowTasks')
    store.set('theme', 'dark')

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual(corrupt)
    expect(new FileStore(filePath).problems().map((p) => p.field)).toContain('workflowTasks')
  })

  it('hands back a fresh array rather than the shared default', () => {
    captureWarnings()
    const { store } = storeHolding({ workflowTasks: 7 })

    store.get('workflowTasks').push(pendingTask)

    expect(store.get('workflowTasks')).toEqual([])
    expect(MAO_STORE_DEFAULTS.workflowTasks).toEqual([])
  })
})

describe('findStoredQueueProblem', () => {
  it('picks out the queue problem and ignores the other guarded fields', () => {
    // The single lookup core/app.ts's latch and confirmQueueRecovery's postcondition both use, so they
    // cannot disagree about what counts as "the queue is unreadable".
    captureWarnings()
    const { store } = storeHolding({ githubRepos: 'x', aiProviders: 'y', workflowTasks: 'z' })

    const problems = store.problems()

    expect(problems.map((p) => p.field).sort()).toEqual(['aiProviders', 'githubRepos', 'workflowTasks'])
    expect(findStoredQueueProblem(problems)?.field).toBe('workflowTasks')
    expect(findStoredQueueProblem(problems.filter((p) => p.field !== 'workflowTasks'))).toBeUndefined()
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

  it('touches no field without a rule', () => {
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

describe('cli config import-providers', () => {
  function unreadableImportMessage(inputPath: string): string {
    const { store } = storeHolding({ aiProviders: [claude] })
    const log = vi.fn()
    let message = ''

    try {
      importProvidersFromFile(inputPath, store, log)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(log).not.toHaveBeenCalled()
    return message
  }

  it('keeps Windows path separators readable in a quoted rejection path', () => {
    const inputPath = String.raw`C:\Users\mao\missing-providers.json`
    const resolvedPath = path.resolve(inputPath)
    const message = unreadableImportMessage(inputPath)

    expect(message).toContain(`"${resolvedPath}"`)
    expect(message).not.toContain(JSON.stringify(resolvedPath))
  })

  it('keeps control characters, literal escapes and quoted backslashes distinct', () => {
    const newlinePath = path.resolve('providers\nlist.json')
    const literalEscapePath = path.resolve(String.raw`providers\nlist.json`)
    const percentEscapePath = path.resolve('providers%0Alist.json')
    const quotedBackslashPath = path.resolve(String.raw`providers\"draft.json`)

    const newlineMessage = unreadableImportMessage('providers\nlist.json')
    const literalEscapeMessage = unreadableImportMessage(String.raw`providers\nlist.json`)
    const percentEscapeMessage = unreadableImportMessage('providers%0Alist.json')
    const quotedBackslashMessage = unreadableImportMessage(String.raw`providers\"draft.json`)

    expect(newlineMessage).toContain(`"${newlinePath.replace('\n', '%0A')}"`)
    expect(newlineMessage).not.toContain('\n')
    expect(literalEscapeMessage).toContain(`"${literalEscapePath}"`)
    expect(newlineMessage).not.toBe(literalEscapeMessage)
    expect(percentEscapeMessage).toContain(`"${percentEscapePath.replace('%', '%25')}"`)
    expect(newlineMessage).not.toBe(percentEscapeMessage)
    expect(quotedBackslashMessage).toContain(`"${quotedBackslashPath.replace('"', '%22')}"`)
    expect(quotedBackslashMessage).not.toContain(`"${quotedBackslashPath}"`)
  })

  it('escapes the line separators that would split a one-line diagnostic', () => {
    // The only characters the escape set renders with the four-digit `%uXXXX` form, and the only ones
    // a terminal would treat as a line break inside what every other path keeps to a single line.
    for (const [separator, escape] of [
      ['\u2028', '%u2028'],
      ['\u2029', '%u2029'],
    ]) {
      const resolvedPath = path.resolve(`providers${separator}list.json`)
      const message = unreadableImportMessage(`providers${separator}list.json`)

      expect(message).toContain(`"${resolvedPath.replace(separator, escape)}"`)
      expect(message).not.toContain(separator)
    }
  })

  it('names the invalid input file, preserves the durable list and emits no success log', () => {
    const { store, filePath } = storeHolding({ aiProviders: [claude] })
    const inputPath = path.join(path.dirname(filePath), 'invalid-providers.json')
    fs.writeFileSync(inputPath, JSON.stringify([null]))
    const log = vi.fn()

    expect(() => importProvidersFromFile(inputPath, store, log)).toThrow(
      new RegExp(`Cannot import AI providers from .*${path.basename(inputPath)}.*1 invalid entry`),
    )

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([claude])
    expect(log).not.toHaveBeenCalled()
  })

  it('persists a valid list before logging its provider ids', () => {
    const { store, filePath } = storeHolding({ aiProviders: [] })
    const inputPath = path.join(path.dirname(filePath), 'valid-providers.json')
    fs.writeFileSync(inputPath, JSON.stringify([claude]))
    const log = vi.fn(() => {
      expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).aiProviders).toEqual([claude])
    })

    expect(importProvidersFromFile(inputPath, store, log)).toEqual([claude])
    expect(log).toHaveBeenCalledWith('Imported 1 AI provider(s): claude')
  })
})

/**
 * `MaoStore.inspect()` — one read answering both "what may I use" and "did the guard replace it".
 *
 * It exists because `get()` and `problems()` are two reads, and conf re-reads and re-parses the whole
 * config file on every `get`. `createMaoApp` decided the queue latch from one and restored from the
 * other, so a value changed between them left the host unlatched holding a coerced empty queue.
 */
describe('MaoStore.inspect', () => {
  it('answers value and problem from the same read, and says the read succeeded', () => {
    captureWarnings()
    const { store } = storeHolding({ workflowTasks: { 'task-1': pendingTask } })

    const observed = store.inspect('workflowTasks')

    expect(observed.readable).toBe(true)
    expect(observed.value).toEqual([])
    expect(observed.problem).toContain('"workflowTasks"')
  })

  it('reports no problem for a healthy value, and hands back what is stored', () => {
    const warn = captureWarnings()
    const { store } = storeHolding({ workflowTasks: [pendingTask] })

    const observed = store.inspect('workflowTasks')

    expect(observed.value).toEqual([pendingTask])
    expect(observed.problem).toBeUndefined()
    expect(observed.readable).toBe(true)
    // A witness is produced for a healthy value too — that is what makes a conditional write possible.
    expect(observed.witness).toBeTypeOf('string')
    expect(warn).not.toHaveBeenCalled()
  })

  it('filters a mixed queue but witnesses the complete raw value for conditional recovery', () => {
    captureWarnings()
    const raw = [pendingTask, null]
    const { store, filePath } = storeHolding({ workflowTasks: raw })

    const observed = store.inspect('workflowTasks')

    expect(observed.value).toEqual([pendingTask])
    expect(observed.problem).toContain('1 invalid queued task')
    // A different invalid entry is still a different raw durable value. If the witness came from the
    // filtered list, this external change would compare equal and recovery would overwrite it.
    fs.writeFileSync(filePath, JSON.stringify({ workflowTasks: [pendingTask, {}] }, null, 2))
    expect(store.setIfUnchanged('workflowTasks', observed.witness, [pendingTask])).toBe('superseded')
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([pendingTask, {}])
  })

  it('cannot disagree with itself when the backend changes between two reads', () => {
    // The regression for the second window review found. This backend flips from a healthy array to a
    // non-array on its SECOND read, which models conf re-reading the file while another process edits
    // it. Two reads (problems() then get()) would see "healthy" and then a coerced `[]`; one inspect()
    // cannot, because there is no second read to disagree with.
    captureWarnings()
    let reads = 0
    const flipping = fakeBackend({ workflowTasks: [pendingTask] })
    const store = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => {
          if (key !== 'workflowTasks') return flipping.backend.get(key)
          reads += 1
          return (reads === 1 ? [pendingTask] : { 'task-1': pendingTask }) as unknown as MaoStoreSchema[K]
        },
        set: flipping.backend.set,
      },
      '/tmp/config.json',
    )

    const observed = store.inspect('workflowTasks')

    // Whichever read it got, the verdict and the value describe the SAME one: either a healthy array
    // with no problem, or a coerced empty list WITH a problem. Never healthy-verdict + coerced value.
    expect(reads).toBe(1)
    if (observed.problem === undefined) expect(observed.value).toEqual([pendingTask])
    else expect(observed.value).toEqual([])
  })

  it('fails closed when the backend read throws, without quoting the error', () => {
    // `readable: false` is a third answer, not a flavour of "unusable": a caller about to WRITE must
    // refuse rather than assume the value is still the corrupt one it last saw.
    const store = createGuardedStore(
      {
        get: () => {
          throw new Error("EACCES: permission denied, open '/tmp/ghp_secretish/config.json'")
        },
        set: () => {},
      },
      '/tmp/config.json',
    )

    const observed = store.inspect('workflowTasks')

    expect(observed.readable).toBe(false)
    expect(observed.value).toEqual([])
    expect(observed.problem).toContain('could not read')
    expect(observed.problem).not.toContain('EACCES')
    expect(observed.problem).not.toContain('ghp_secretish')
  })

  it('warns once, exactly as get() does, so an observation and a read cannot differ', () => {
    const warn = captureWarnings()
    const { store } = storeHolding({ workflowTasks: 'task-1' })

    store.inspect('workflowTasks')
    store.get('workflowTasks')
    store.inspect('workflowTasks')

    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('describeUninspectableStore', () => {
  it('names the field and the file and nothing else', () => {
    const message = describeUninspectableStore('workflowTasks', '/tmp/config.json')

    expect(message).toContain('"workflowTasks"')
    expect(message).toContain('/tmp/config.json')
    expect(message).toContain('unusable')
  })
})

/**
 * `setIfUnchanged()` — the conditional write the recovery rests on, and `FileStore`'s freshness.
 *
 * Observing before writing is not the same as writing conditionally: a repair landing between the two is
 * destroyed by an unconditional `set` and reported as success. These pin the three parts that make the
 * difference — the comparison itself, refusing when it cannot be made, and reading what is on disk *now*
 * rather than what was there when the store was constructed.
 */
describe('MaoStore.setIfUnchanged', () => {
  it('writes when the stored value still matches the witness', () => {
    captureWarnings()
    const { store, filePath } = storeHolding({ workflowTasks: { 'task-1': pendingTask } })

    const observed = store.inspect('workflowTasks')
    expect(store.setIfUnchanged('workflowTasks', observed.witness, [])).toBe('written')

    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([])
  })

  it('rejects an invalid replacement before comparing or writing', () => {
    captureWarnings()
    const raw = [pendingTask, null]
    const { store, filePath } = storeHolding({ workflowTasks: raw })
    const observed = store.inspect('workflowTasks')

    expect(store.setIfUnchanged('workflowTasks', observed.witness, [null] as unknown as QueuedTask[])).toBe(
      'invalid',
    )
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual(raw)
  })

  it('returns invalid before reading fresh state or calling the backend write', () => {
    let freshReads = 0
    let writes = 0
    const store = createGuardedStore(
      {
        get: () => [pendingTask] as never,
        getFresh: <K extends keyof MaoStoreSchema>(_key: K) => {
          freshReads += 1
          return [pendingTask] as MaoStoreSchema[K]
        },
        set: () => {
          writes += 1
        },
      },
      '/tmp/config.json',
    )

    expect(store.setIfUnchanged('workflowTasks', 'unused-witness', [null] as unknown as QueuedTask[])).toBe(
      'invalid',
    )
    expect(freshReads).toBe(0)
    expect(writes).toBe(0)
  })

  it('refuses, and writes nothing, when the stored value moved since the observation', () => {
    captureWarnings()
    const { store, filePath } = storeHolding({ workflowTasks: { 'task-1': pendingTask } })
    const observed = store.inspect('workflowTasks')

    // Another process repairs the queue after the observation and before the write.
    fs.writeFileSync(filePath, JSON.stringify({ workflowTasks: [pendingTask] }, null, 2))

    expect(store.setIfUnchanged('workflowTasks', observed.witness, [])).toBe('superseded')
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual([pendingTask])
  })

  it('refuses when there is no witness to compare against', () => {
    // `witnessOf` answers undefined for a value it cannot serialize. Writing then would be a guess about
    // a value nobody established, which is the whole failure this member exists to prevent.
    captureWarnings()
    const { store, filePath } = storeHolding({ workflowTasks: { 'task-1': pendingTask } })

    expect(store.setIfUnchanged('workflowTasks', undefined, [])).toBe('unverifiable')
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).workflowTasks).toEqual({ 'task-1': pendingTask })
  })

  it('refuses when the file cannot be read, rather than treating it as unchanged', () => {
    captureWarnings()
    const { store, filePath } = storeHolding({ workflowTasks: { 'task-1': pendingTask } })
    const observed = store.inspect('workflowTasks')

    // Present but unparseable. `loadStrict` must throw for this, so the compare answers "unknown" — the
    // swallowing `load()` the constructor uses would read it as `{}` and could compare equal by accident.
    fs.writeFileSync(filePath, '{ "workflowTasks": [')

    expect(store.setIfUnchanged('workflowTasks', observed.witness, [])).toBe('unverifiable')
  })

  it('FileStore observes what is on disk now, not its constructor snapshot', () => {
    // The gap review named: `get` answers from the snapshot, so an `inspect` built on it would compare a
    // CLI recovery against a value taken at construction and miss a repair that had already landed.
    const warn = captureWarnings()
    const { store, filePath } = storeHolding({ workflowTasks: [pendingTask] })
    expect(store.inspect('workflowTasks').problem).toBeUndefined()

    fs.writeFileSync(filePath, JSON.stringify({ workflowTasks: { 'task-1': pendingTask } }, null, 2))

    // Fresh: the observation sees the corruption that landed after construction.
    expect(store.inspect('workflowTasks').problem).toContain('"workflowTasks"')
    // And `get` deliberately still answers from the snapshot — the fresh read is NOT written back, so a
    // recovery cannot change what every other reader in the process sees.
    expect(store.get('workflowTasks')).toEqual([pendingTask])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('FileStore reports an unreadable file as unobservable, not as empty', () => {
    captureWarnings()
    const { store, filePath } = storeHolding({ workflowTasks: [pendingTask] })

    fs.writeFileSync(filePath, 'not json at all')

    const observed = store.inspect('workflowTasks')
    expect(observed.readable).toBe(false)
    expect(observed.witness).toBeUndefined()
    expect(observed.problem).toContain('could not read')
  })
})

/**
 * The limit of `setIfUnchanged()`, pinned so it lives in the suite rather than only in a comment.
 *
 * Two revisions of this PR claimed the read-then-clobber window was closed. It is not: the comparison
 * narrows it to the compare -> write interval, and a repair landing *inside* that interval is still
 * overwritten. Asserting the real behaviour is what stops the claim drifting back — if someone later adds
 * a lock and genuinely closes it, this test fails and has to be rewritten deliberately.
 */
describe('setIfUnchanged — what it does not close', () => {
  it('is atomic against other callers in this process', () => {
    // The half that IS guaranteed, and the reason: nothing may be inserted between the compare and the
    // write, so no other JavaScript here can interleave. A backend that counts reads proves the pair runs
    // back to back with no second observation in between.
    const reads: string[] = []
    const data: Record<string, unknown> = { workflowTasks: { 'task-1': pendingTask } }
    const store = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => data[key] as MaoStoreSchema[K] | undefined,
        getFresh: <K extends keyof MaoStoreSchema>(key: K) => {
          reads.push(String(key))
          return data[key] as MaoStoreSchema[K] | undefined
        },
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          data[key] = value
        },
      },
      '/tmp/config.json',
    )
    captureWarnings()

    const observed = store.inspect('workflowTasks')
    reads.length = 0
    expect(store.setIfUnchanged('workflowTasks', observed.witness, [])).toBe('written')

    // Exactly one read — the compare — and then the write. No window for a same-process caller.
    expect(reads).toEqual(['workflowTasks'])
  })

  it('does NOT close the window against another OS process, and must not claim to', () => {
    // The honest residue. This backend repairs the value *after* the compare read has answered, which is
    // what another process doing it between our compare and our writeFileSync looks like from here. The
    // repair is overwritten and the result is still 'written'.
    //
    // Keeping this as an executable assertion rather than prose is the point: it is the exact scenario
    // review reproduced, and recording it stops the "window closed" wording coming back.
    const data: Record<string, unknown> = { workflowTasks: { 'task-1': pendingTask } }
    let repairAfterNextRead = false
    const store = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => data[key] as MaoStoreSchema[K] | undefined,
        getFresh: <K extends keyof MaoStoreSchema>(key: K) => {
          const value = data[key] as MaoStoreSchema[K] | undefined
          if (key === 'workflowTasks' && repairAfterNextRead) {
            repairAfterNextRead = false
            data.workflowTasks = [pendingTask]
          }
          return value
        },
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          data[key] = value
        },
      },
      '/tmp/config.json',
    )
    captureWarnings()

    const observed = store.inspect('workflowTasks')
    repairAfterNextRead = true

    expect(store.setIfUnchanged('workflowTasks', observed.witness, [])).toBe('written')
    // The repair is gone. Closing this needs an advisory lock both writers take, or O_EXCL + rename
    // keyed on a stored version — a primitive neither backend has. Tracked as issue #73.
    expect(data.workflowTasks).toEqual([])
  })
})
