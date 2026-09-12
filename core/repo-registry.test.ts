import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertReposRegistrable,
  canonicalRepoList,
  createRepoRegistrar,
  repoRefKey,
  reposNeedingCapabilityCheck,
  sameRepoRef,
} from './repo-registry.ts'
import { RepoCapabilityError, evaluateRepoCapability } from './repo-capabilities.ts'
import { FileStore } from './store.ts'
import type { GithubService } from './github-service.ts'
import type { RepoRef } from './workflow-engine.ts'

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

/** A real on-disk store, so "the stored list is unchanged" is asserted against actual persistence. */
function makeRealStore(): FileStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-registry-test-'))
  tmpDirs.push(dir)
  return new FileStore(path.join(dir, 'config.json'))
}

const widgets: RepoRef = { owner: 'acme', repo: 'widgets' }
const gadgets: RepoRef = { owner: 'acme', repo: 'gadgets' }
/** The same repository as `widgets` — GitHub resolves owner/repo without regard to case. */
const widgetsShouted: RepoRef = { owner: 'ACME', repo: 'Widgets' }

function passingGithub() {
  return {
    assertRepoWorkflowWritable: vi.fn(async (owner: string, repo: string) =>
      evaluateRepoCapability({ owner, repo, repository: { has_issues: true, permissions: { push: true } } }),
    ),
  } as unknown as Pick<GithubService, 'assertRepoWorkflowWritable'>
}

function rejectingGithub(failing: string) {
  return {
    assertRepoWorkflowWritable: vi.fn(async (owner: string, repo: string) => {
      const capability = evaluateRepoCapability(
        repo === failing
          ? { owner, repo, repository: { has_issues: true, permissions: { push: false } } }
          : { owner, repo, repository: { has_issues: true, permissions: { push: true } } },
      )
      if (!capability.ok) throw new RepoCapabilityError(capability)
      return capability
    }),
  } as unknown as Pick<GithubService, 'assertRepoWorkflowWritable'>
}

describe('sameRepoRef', () => {
  it('compares the owner/repo pair only', () => {
    expect(sameRepoRef(widgets, { ...widgets, autoTrigger: false, pollIntervalMs: 90_000 })).toBe(true)
    expect(sameRepoRef(widgets, gadgets)).toBe(false)
  })

  it('ignores case, because GitHub does', () => {
    expect(sameRepoRef(widgets, widgetsShouted)).toBe(true)
    expect(repoRefKey(widgetsShouted)).toBe(repoRefKey(widgets))
    expect(sameRepoRef(widgetsShouted, gadgets)).toBe(false)
  })
})

describe('canonicalRepoList', () => {
  it('rewrites a differently cased entry to the spelling already stored', () => {
    // The stored spelling is the one the preflight vouched for, so it is the only one safe to keep.
    expect(canonicalRepoList([widgets], [{ ...widgetsShouted, autoTrigger: false }])).toEqual([
      { ...widgets, autoTrigger: false },
    ])
  })

  it('keeps the spelling of a repository that is not registered yet', () => {
    expect(canonicalRepoList([], [widgetsShouted])).toEqual([widgetsShouted])
  })

  it('collapses two spellings of one repository into a single entry', () => {
    const collapsed = canonicalRepoList([], [widgets, { ...widgetsShouted, pollIntervalMs: 90_000 }])
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].pollIntervalMs).toBe(90_000)
  })

  it('lets the last occurrence win, settings and position alike', () => {
    // Matches `mao repos add`'s documented "adds or replaces its entry", and is what lets the GUI's
    // add path select the entry it just registered at the end of the stored list.
    const previous = [widgets, gadgets]
    const list = canonicalRepoList(previous, [...previous, { ...widgetsShouted, autoTrigger: false }])
    expect(list).toEqual([gadgets, { ...widgets, autoTrigger: false }])
  })

  it('heals a store that already holds one repository twice', () => {
    // The duplicate this fix prevents could already have been written by an earlier build; the next
    // list write folds it away rather than requiring the operator to notice and remove it.
    const healed = canonicalRepoList([widgets, widgetsShouted], [widgets, widgetsShouted])
    expect(healed).toHaveLength(1)
    expect(sameRepoRef(healed[0], widgets)).toBe(true)
  })

  it('leaves an ordinary list untouched', () => {
    expect(canonicalRepoList([widgets], [widgets, gadgets])).toEqual([widgets, gadgets])
  })
})

describe('reposNeedingCapabilityCheck', () => {
  it('returns a first-time registration', () => {
    expect(reposNeedingCapabilityCheck([], [widgets])).toEqual([widgets])
  })

  it('returns only the newly added entry when an existing one is kept', () => {
    expect(reposNeedingCapabilityCheck([widgets], [widgets, gadgets])).toEqual([gadgets])
  })

  it('does not re-check a settings edit on an already-tracked repo', () => {
    // The case that keeps a revoked repo manageable: turning polling off must not require the
    // credential the repo just lost. Same guarantee for `mao repos add --no-auto-trigger`, which is
    // the CLI's only settings editor and therefore goes through this same rule.
    const edited = { ...widgets, autoTrigger: false, pollIntervalMs: 120_000 }
    expect(reposNeedingCapabilityCheck([widgets], [edited])).toEqual([])
  })

  it('does not check a removal', () => {
    expect(reposNeedingCapabilityCheck([widgets, gadgets], [gadgets])).toEqual([])
  })

  it('does not check a reorder', () => {
    expect(reposNeedingCapabilityCheck([widgets, gadgets], [gadgets, widgets])).toEqual([])
  })

  it('treats a differently cased spelling of a tracked repo as already registered', () => {
    expect(reposNeedingCapabilityCheck([widgets], [widgetsShouted])).toEqual([])
  })

  it('checks a differently cased spelling of an untracked repo, as typed', () => {
    // Nothing has vouched for this repository yet, so the pair about to be stored is the one checked.
    expect(reposNeedingCapabilityCheck([gadgets], [gadgets, widgetsShouted])).toEqual([widgetsShouted])
  })

  it('checks one repository once when a list names it twice', () => {
    expect(reposNeedingCapabilityCheck([], [widgets, widgetsShouted])).toHaveLength(1)
  })

  it('re-checks a repo that was removed and is later added again', () => {
    // Model the actual sequence: the removal leaves it out of `previous`, so the second add is a
    // genuine registration again rather than an exempt settings edit.
    const afterRemoval = reposNeedingCapabilityCheck([widgets, gadgets], [gadgets])
    expect(afterRemoval).toEqual([])
    expect(reposNeedingCapabilityCheck([gadgets], [gadgets, widgets])).toEqual([widgets])
  })
})

describe('assertReposRegistrable', () => {
  it('checks each newly added repo and returns the passing verdicts', async () => {
    const github = passingGithub()
    const checked = await assertReposRegistrable(github, [widgets], [widgets, gadgets])

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledTimes(1)
    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledWith('acme', 'gadgets')
    expect(checked.map((c) => c.repo)).toEqual(['gadgets'])
  })

  it('makes no GitHub call at all when nothing is newly registered', async () => {
    const github = passingGithub()
    await assertReposRegistrable(github, [widgets], [{ ...widgets, autoTrigger: false }])
    expect(github.assertRepoWorkflowWritable).not.toHaveBeenCalled()
  })

  it('leaves a real on-disk store untouched when a registration is refused', async () => {
    // Both shells run guard-then-`store.set('githubRepos', next)`. Asserting that against a real
    // FileStore (rather than a lambda defined in the test) is what actually proves issue #48's
    // "store unchanged on registration failure" criterion — vitest cannot reach either shell.
    const store = makeRealStore()
    store.set('githubRepos', [gadgets])
    const github = rejectingGithub('widgets')
    const next = [gadgets, widgets]

    await expect(
      assertReposRegistrable(github, store.get('githubRepos'), next).then(() =>
        store.set('githubRepos', next),
      ),
    ).rejects.toThrow(/acme\/widgets is missing permissions/)

    expect(store.get('githubRepos')).toEqual([gadgets])
    // And durably so — re-reading the file, not just the in-memory copy.
    expect(new FileStore((store as unknown as { filePath: string }).filePath).get('githubRepos')).toEqual([
      gadgets,
    ])
  })

  it('persists the full list once every new entry passes', async () => {
    const store = makeRealStore()
    store.set('githubRepos', [gadgets])
    const github = passingGithub()
    const next = [gadgets, widgets]

    await assertReposRegistrable(github, store.get('githubRepos'), next)
    store.set('githubRepos', next)

    expect(store.get('githubRepos')).toEqual(next)
  })

  it('aborts on the first failure rather than checking the rest', async () => {
    const github = rejectingGithub('widgets')
    await expect(assertReposRegistrable(github, [], [widgets, gadgets])).rejects.toThrow(RepoCapabilityError)
    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledTimes(1)
  })

  it('propagates a transient lookup failure instead of reporting it as a permission problem', async () => {
    const github = {
      assertRepoWorkflowWritable: vi.fn(async () => {
        throw Object.assign(new Error('GitHub request timed out after 60s'), { name: 'AbortError' })
      }),
    } as unknown as Pick<GithubService, 'assertRepoWorkflowWritable'>

    await expect(assertReposRegistrable(github, [], [widgets])).rejects.toThrow(/timed out after 60s/)
  })
})

describe('createRepoRegistrar', () => {
  /**
   * A preflight the test can hold mid-flight. `release()` also opens every *later* call, because a
   * queued update does not even reach its preflight until the one ahead of it finishes.
   */
  function deferredGithub() {
    let open = false
    const waiting: Array<() => void> = []
    const github = {
      assertRepoWorkflowWritable: vi.fn(
        (owner: string, repo: string) =>
          new Promise((resolve) => {
            const settle = () =>
              resolve(
                evaluateRepoCapability({ owner, repo, repository: { has_issues: true, permissions: { push: true } } }),
              )
            if (open) settle()
            else waiting.push(settle)
          }),
      ),
    } as unknown as Pick<GithubService, 'assertRepoWorkflowWritable'>
    return { github, release: () => { open = true; waiting.splice(0).forEach((settle) => settle()) } }
  }

  it('does not resurrect a repo removed while its registration was still being preflighted', async () => {
    // The regression the review asked for, in the shape the GUI actually produces: the renderer sends
    // the whole list each time, computed from what it is optimistically showing. Before serialization
    // the removal (no new entries, so no preflight) completed first, and the slow add then wrote the
    // list it was handed at request time — putting widgets back after the operator removed it. The
    // store kept a repository the sidebar no longer showed, and auto-trigger went on polling it.
    const store = makeRealStore()
    store.set('githubRepos', [gadgets])
    const { github, release } = deferredGithub()
    const updateRepos = createRepoRegistrar(github, store)

    const adding = updateRepos(() => [gadgets, widgets])
    const removing = updateRepos(() => [gadgets])

    release()
    await adding
    await removing

    expect(store.get('githubRepos')).toEqual([gadgets])
    expect(new FileStore((store as unknown as { filePath: string }).filePath).get('githubRepos')).toEqual([gadgets])
  })

  it('applies each update to the list read inside its own turn, not to a stale snapshot', async () => {
    const store = makeRealStore()
    store.set('githubRepos', [])
    const { github, release } = deferredGithub()
    const updateRepos = createRepoRegistrar(github, store)

    const first = updateRepos((previous) => [...previous, gadgets])
    const second = updateRepos((previous) => [...previous, widgets])

    release()
    await first
    await second

    // The second update never saw the empty list, so it added to gadgets rather than replacing it.
    expect(store.get('githubRepos')).toEqual([gadgets, widgets])
  })

  it('preflights only what is new relative to the fresh read, and persists once it passes', async () => {
    const store = makeRealStore()
    store.set('githubRepos', [gadgets])
    const github = passingGithub()
    const updateRepos = createRepoRegistrar(github, store)

    const checked = await updateRepos((previous) => [...previous, widgets])

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledTimes(1)
    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledWith('acme', 'widgets')
    expect(checked.map((c) => c.repo)).toEqual(['widgets'])
    expect(store.get('githubRepos')).toEqual([gadgets, widgets])
  })

  it('leaves the store untouched on a refused registration and keeps serving later updates', async () => {
    // A rejected update must reach its own caller and must not wedge the queue behind it.
    const store = makeRealStore()
    store.set('githubRepos', [gadgets])
    const updateRepos = createRepoRegistrar(rejectingGithub('widgets'), store)

    await expect(updateRepos((previous) => [...previous, widgets])).rejects.toThrow(
      /acme\/widgets is missing permissions/,
    )
    expect(store.get('githubRepos')).toEqual([gadgets])

    // Removal still works afterwards — the queue is not stuck on the failure above.
    await updateRepos((previous) => previous.filter((r) => !sameRepoRef(r, gadgets)))
    expect(store.get('githubRepos')).toEqual([])
  })

  it('never stores an owner/repo pair it did not preflight or already have', async () => {
    // The invariant the whole module exists for, asserted against the store rather than through one
    // scenario: making identity case-insensitive must not let an unchecked spelling reach disk. A
    // naive lower-cased comparison inside sameRepoRef(), with no canonicalisation of what gets
    // written, passes almost every other test here and fails this one.
    const store = makeRealStore()
    const previous = [widgets, gadgets]
    store.set('githubRepos', previous)
    const github = passingGithub()
    const updateRepos = createRepoRegistrar(github, store)

    await updateRepos(() => [gadgets, widgetsShouted, { owner: 'Acme', repo: 'Sprockets' }])

    const vouchedFor = new Set([
      ...previous.map((r) => `${r.owner}/${r.repo}`),
      ...(github.assertRepoWorkflowWritable as unknown as { mock: { calls: string[][] } }).mock.calls.map(
        ([owner, repo]) => `${owner}/${repo}`,
      ),
    ])
    for (const stored of store.get('githubRepos')) {
      expect(vouchedFor).toContain(`${stored.owner}/${stored.repo}`)
    }
  })

  it('does not register a second entry for a repo respelled in another case', async () => {
    // `mao repos add ACME Widgets` (or the same typed into the GUI's Add form) against a tracked
    // acme/widgets. Two entries meant startAutoTrigger polled one repository twice, and because it
    // enqueues before writing the best-effort workflow-active label, both pollers could enqueue the
    // same issue and open two branches and PRs for it.
    const store = makeRealStore()
    store.set('githubRepos', [widgets])
    const github = passingGithub()
    const updateRepos = createRepoRegistrar(github, store)

    await updateRepos((previous) => [
      ...previous.filter((r) => !sameRepoRef(r, widgetsShouted)),
      widgetsShouted,
    ])

    expect(store.get('githubRepos')).toHaveLength(1)
  })

  it('applies the settings of a differently cased re-add without preflighting it again', async () => {
    // The stored spelling survives, so the pair on disk stays one the preflight vouched for — and the
    // settings-edit exemption still holds, keeping a repo manageable after its access is revoked.
    const store = makeRealStore()
    store.set('githubRepos', [widgets])
    const github = passingGithub()
    const updateRepos = createRepoRegistrar(github, store)

    await updateRepos((previous) => [
      ...previous.filter((r) => !sameRepoRef(r, widgetsShouted)),
      { ...widgetsShouted, autoTrigger: false },
    ])

    expect(github.assertRepoWorkflowWritable).not.toHaveBeenCalled()
    expect(store.get('githubRepos')).toEqual([{ ...widgets, autoTrigger: false }])
  })

  it('preflights a first-time registration under the spelling it stores', async () => {
    const store = makeRealStore()
    store.set('githubRepos', [])
    const github = passingGithub()
    const updateRepos = createRepoRegistrar(github, store)

    await updateRepos(() => [widgetsShouted])

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledWith('ACME', 'Widgets')
    expect(store.get('githubRepos')).toEqual([widgetsShouted])
  })

  it('removes a repository whatever case the caller spells it in', async () => {
    // `mao repos remove ACME Widgets` against a tracked acme/widgets, in the update shape the CLI
    // actually passes. Before this it matched nothing and the entry stayed, still being polled.
    const store = makeRealStore()
    store.set('githubRepos', [widgets, gadgets])
    const updateRepos = createRepoRegistrar(passingGithub(), store)

    await updateRepos((previous) => previous.filter((r) => !sameRepoRef(r, widgetsShouted)))

    expect(store.get('githubRepos')).toEqual([gadgets])
  })

  it('folds away a duplicate an earlier build already stored, without preflighting it', async () => {
    const store = makeRealStore()
    store.set('githubRepos', [widgets, widgetsShouted])
    const github = passingGithub()
    const updateRepos = createRepoRegistrar(github, store)

    // Any list write heals it — here a settings edit that touches the other repository entirely.
    await updateRepos((previous) => [...previous, gadgets])

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledTimes(1)
    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledWith('acme', 'gadgets')
    expect(store.get('githubRepos')).toHaveLength(2)
    expect(store.get('githubRepos').filter((r) => sameRepoRef(r, widgets))).toHaveLength(1)
  })
})
