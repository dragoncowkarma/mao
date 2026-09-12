import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAutoTrigger } from './auto-trigger.ts'
import { RepoCapabilityError, evaluateRepoCapability } from './repo-capabilities.ts'
import type { GithubService } from './github-service.ts'
import type { GithubTask } from './github-service.ts'
import type { RepoRef, WorkflowEngine } from './workflow-engine.ts'

const repo: RepoRef = { owner: 'acme', repo: 'widgets' }

/** startAutoTrigger owns a setInterval that would otherwise outlive the test and keep vitest alive. */
const handles: Array<ReturnType<typeof setInterval>> = []

afterEach(() => {
  while (handles.length) clearInterval(handles.pop()!)
  vi.restoreAllMocks()
})

function openIssue(number: number): GithubTask {
  return {
    id: number,
    number,
    title: `Issue ${number}`,
    type: 'issue',
    state: 'open',
    url: `https://github.com/acme/widgets/issues/${number}`,
    updatedAt: '2026-09-09T00:00:00Z',
    urgent: false,
    labels: [],
    body: '',
  }
}

/** The preflight verdict for this repo, writable or not. */
function verdict(push: boolean) {
  return evaluateRepoCapability({
    owner: 'acme',
    repo: 'widgets',
    repository: { has_issues: true, permissions: { push } },
  })
}

function makeGithub(overrides: Record<string, unknown> = {}) {
  return {
    assertRepoWorkflowWritable: vi.fn(async () => verdict(true)),
    fetchTasks: vi.fn(async () => [openIssue(7)]),
    addLabel: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GithubService
}

function makeEngine() {
  return { enqueueFromIssue: vi.fn() } as unknown as WorkflowEngine
}

/**
 * Drives exactly one poll. `getRepos` returns nothing so `startAutoTrigger`'s own immediate tick (and
 * its interval) never fire — each test controls precisely how many polls happen.
 */
async function pollOnce(github: GithubService, engine: WorkflowEngine) {
  const trigger = startAutoTrigger(github, engine, () => [])
  handles.push(trigger.handle)
  await trigger.pollNow(repo)
  return trigger
}

describe('auto-trigger repository preflight', () => {
  it('enqueues and labels an open issue when the repo passes the preflight', async () => {
    const github = makeGithub()
    const engine = makeEngine()

    await pollOnce(github, engine)

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledWith('acme', 'widgets')
    expect(engine.enqueueFromIssue).toHaveBeenCalledTimes(1)
    expect(github.addLabel).toHaveBeenCalledWith('acme', 'widgets', 7, 'workflow-active')
  })

  it('performs zero enqueues and zero label writes when the credential cannot write', async () => {
    const github = makeGithub({
      assertRepoWorkflowWritable: vi.fn(async () => {
        throw new RepoCapabilityError(verdict(false))
      }),
    })
    const engine = makeEngine()

    const trigger = await pollOnce(github, engine)

    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
    expect(github.addLabel).not.toHaveBeenCalled()
    // Checked before the listing too, so an unauthorized repo reports the missing capability rather
    // than the opaque 404 that listForRepo would have raised first.
    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(trigger.getStatus('acme', 'widgets').lastError).toMatch(/acme\/widgets is missing permissions/)
  })

  it('surfaces a transient lookup failure as the repo status error, still writing nothing', async () => {
    const github = makeGithub({
      assertRepoWorkflowWritable: vi.fn(async () => {
        throw new Error('GitHub request timed out after 60s')
      }),
    })
    const engine = makeEngine()

    const trigger = await pollOnce(github, engine)

    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
    expect(github.addLabel).not.toHaveBeenCalled()
    expect(trigger.getStatus('acme', 'widgets').lastError).toMatch(/timed out after 60s/)
  })

  it('logs only the message, never the error object that carries the authenticated request', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const github = makeGithub({
      assertRepoWorkflowWritable: vi.fn(async () => {
        throw Object.assign(new Error('Bad credentials'), {
          request: { headers: { authorization: 'token ghp_supersecretvalue' } },
        })
      }),
    })

    await pollOnce(github, makeEngine())

    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError.mock.calls[0]).toHaveLength(1)
    expect(String(consoleError.mock.calls[0][0])).not.toContain('ghp_supersecretvalue')
  })

  it('clears the recorded error once the permission is restored', async () => {
    const assertRepoWorkflowWritable = vi
      .fn()
      .mockRejectedValueOnce(new RepoCapabilityError(verdict(false)))
      .mockResolvedValue(verdict(true))
    const github = makeGithub({ assertRepoWorkflowWritable })
    const engine = makeEngine()

    const trigger = await pollOnce(github, engine)
    expect(trigger.getStatus('acme', 'widgets').lastError).toBeTruthy()

    await trigger.pollNow(repo)

    expect(trigger.getStatus('acme', 'widgets').lastError).toBeNull()
    expect(engine.enqueueFromIssue).toHaveBeenCalledTimes(1)
  })
})

describe('auto-trigger duplicate repositories', () => {
  /**
   * Runs the scheduler's own immediate tick against `repos` — not `pollNow`, because the tick is what
   * dedupes. Every collaborator is a resolved-promise mock, so draining the macrotask queue a few times
   * settles the whole chain; deliberately not `vi.waitFor` on a call count, which would pass a
   * "nothing was polled" assertion only by timing out.
   */
  async function tickOnce(github: GithubService, engine: WorkflowEngine, repos: RepoRef[]) {
    const trigger = startAutoTrigger(github, engine, () => repos)
    handles.push(trigger.handle)
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    return trigger
  }

  it('polls a repository once when the store holds it under two spellings', async () => {
    // The exact harm that motivated case-insensitive identity. A store written by an earlier build can
    // still hold the duplicate, and only a list write heals it — an unattended `mao run` never performs
    // one, so the scheduler has to stop double-polling on its own. Polling twice means two
    // enqueueFromIssue calls for one issue (the workflow-active label is written after the enqueue and
    // is best-effort), i.e. two branches and two PRs.
    const github = makeGithub()
    const engine = makeEngine()

    await tickOnce(github, engine, [repo, { owner: 'ACME', repo: 'Widgets' }])

    expect(github.fetchTasks).toHaveBeenCalledTimes(1)
    expect(engine.enqueueFromIssue).toHaveBeenCalledTimes(1)
  })

  it('does not poll a duplicated repository that either entry switched off', async () => {
    // Healing merges the two rows, and an explicit "do not poll this" wins from either side — the
    // scheduler must agree, or the repo is polled for as long as the duplicate survives on disk.
    const github = makeGithub()
    const engine = makeEngine()

    await tickOnce(github, engine, [{ ...repo, autoTrigger: false }, { owner: 'ACME', repo: 'Widgets' }])

    expect(github.fetchTasks).not.toHaveBeenCalled()
    expect(engine.enqueueFromIssue).not.toHaveBeenCalled()
  })
})
