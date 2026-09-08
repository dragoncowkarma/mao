import { describe, expect, it, vi } from 'vitest'
import { assertReposRegistrable, reposNeedingCapabilityCheck, sameRepoRef } from './repo-registry.ts'
import { RepoCapabilityError, evaluateRepoCapability } from './repo-capabilities.ts'
import type { GithubService } from './github-service.ts'
import type { RepoRef } from './workflow-engine.ts'

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

  it('checks a repo that was removed and later re-added', () => {
    expect(reposNeedingCapabilityCheck([], [widgets])).toEqual([widgets])
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

  it('throws the actionable capability error so the caller never reaches its store write', async () => {
    const github = rejectingGithub('widgets')
    const stored: RepoRef[][] = []
    const persist = (next: RepoRef[]) => stored.push(next)

    await expect(
      assertReposRegistrable(github, [], [widgets]).then(() => persist([widgets])),
    ).rejects.toThrow(/acme\/widgets is missing permissions/)

    // The point of the guard: the store was never written.
    expect(stored).toEqual([])
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
