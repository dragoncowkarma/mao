import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertReposRegistrable, reposNeedingCapabilityCheck, sameRepoRef } from './repo-registry.ts'
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
