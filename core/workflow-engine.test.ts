import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowEngine, type QueuedTask, type RepoRef } from './workflow-engine.ts'
import { RepoCapabilityError, evaluateRepoCapability } from './repo-capabilities.ts'
import type { AgentStage, AiProviderConfig } from './ai/types.ts'
import type { GithubService } from './github-service.ts'

/**
 * Hoisted so tests can assert the provider factory was never reached — "zero AI provider calls" is
 * one of the guarantees the repo-permission preflight has to deliver, and a spy created *inside* the
 * factory can only be inspected once the factory has already run.
 */
const ai = vi.hoisted(() => ({
  createAiProvider: vi.fn((config: { id: string; name: string }) => ({
    id: config.id,
    name: config.name,
    run: vi.fn(async () => `output-from-${config.id}`),
  })),
}))

vi.mock('./ai/index.ts', () => ({ createAiProvider: ai.createAiProvider }))

/** Mocked so the real-checkout `pr` path can assert that no clone or push happened. */
const git = vi.hoisted(() => ({
  ensureClone: vi.fn(async () => '/tmp/mao-test-clone'),
  checkoutBranch: vi.fn(async () => {}),
  hasChanges: vi.fn(async () => true),
  commitAndPush: vi.fn(async () => {}),
}))

vi.mock('./git-workspace.ts', () => git)

beforeEach(() => {
  ai.createAiProvider.mockClear()
  for (const fn of Object.values(git)) fn.mockClear()
})

const repo: RepoRef = { owner: 'acme', repo: 'widgets' }

function makeProvider(id: string, allowedStages?: AgentStage[]): AiProviderConfig {
  return {
    id,
    name: id,
    kind: 'api',
    apiFormat: 'anthropic',
    apiKey: 'test-key',
    model: `${id}-model`,
    ...(allowedStages ? { allowedStages } : {}),
  }
}

/** A passing preflight verdict — what GithubService returns for a repo with no known blocker. */
function makeCapability(owner = 'acme', repo = 'widgets') {
  return {
    owner,
    repo,
    ok: true,
    gaps: [],
    unverified: [],
    observed: {
      archived: false,
      disabled: false,
      hasIssues: true,
      push: true,
      private: false,
      credential: 'unknown' as const,
    },
  }
}

function makeFakeGithub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    // runStage() preflights every stage against this before it touches an AI provider, git, or
    // GitHub — a fake without it makes every stage fail (see the repo-permission preflight tests).
    assertRepoWorkflowWritable: vi.fn(async (owner: string, repo: string) => makeCapability(owner, repo)),
    createIssue: vi.fn(async () => ({ number: 1, html_url: 'https://github.com/acme/widgets/issues/1' })),
    addLabel: vi.fn(async () => {}),
    getDefaultBranch: vi.fn(async () => 'main'),
    createBranch: vi.fn(async () => ({ base: 'main' })),
    commitFile: vi.fn(async () => {}),
    createPullRequest: vi.fn(async () => ({ number: 2, html_url: 'https://github.com/acme/widgets/pull/2' })),
    reviewPullRequest: vi.fn(async () => {}),
    commentOnIssue: vi.fn(async () => {}),
    getChecksStatus: vi.fn(async () => 'success' as const),
    mergePullRequest: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GithubService
}

/** Polls until `predicate(engine)` is true or the timeout elapses — the engine's queue processing is async. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('WorkflowEngine', () => {
  it('runs a task through all four stages, alternating agents (maker-checker)', async () => {
    const github = makeFakeGithub()
    const engine = new WorkflowEngine(github)
    const providerA = makeProvider('agent-a')
    const providerB = makeProvider('agent-b')
    engine.setProviders([providerA, providerB])

    const task = engine.enqueue('Add feature X', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

    const finished = engine.getTasks().find((t) => t.id === task.id)!
    expect(finished.history).toHaveLength(4)
    expect(finished.history.map((h) => h.stage)).toEqual(['issue', 'pr', 'review', 'merge'])

    // No two consecutive stages should reuse the same agent.
    for (let i = 1; i < finished.history.length; i++) {
      expect(finished.history[i].agentId).not.toBe(finished.history[i - 1].agentId)
    }

    // Model is carried through from the provider config onto each history entry.
    expect(finished.history[0].model).toBe(`${finished.history[0].agentId}-model`)
    expect(finished.history[0].prompt).toContain('Add feature X')

    expect(github.createIssue).toHaveBeenCalledTimes(1)
    expect(github.createPullRequest).toHaveBeenCalledTimes(1)
    expect(github.reviewPullRequest).toHaveBeenCalledTimes(1)
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1)
  })

  it('blocks the merge stage until CI checks succeed, and retry() re-attempts the same stage', async () => {
    const github = makeFakeGithub({
      getChecksStatus: vi.fn(async () => 'pending' as const),
    })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature Y', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

    let current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('merge')
    expect(current.error).toMatch(/CI checks are still running/)
    expect(github.mergePullRequest).not.toHaveBeenCalled()
    expect(github.commentOnIssue).not.toHaveBeenCalled()

    // CI turns green — retrying the same stage should now succeed through to done.
    ;(github.getChecksStatus as ReturnType<typeof vi.fn>).mockResolvedValue('success')
    engine.retry(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.error).toBeUndefined()
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1)
    expect(github.commentOnIssue).toHaveBeenCalledTimes(1)
  })

  it('does not post the summary comment if mergePullRequest fails, and posts it once after retry succeeds', async () => {
    const mergePullRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error('mergePullRequest transient failure'))
      .mockResolvedValueOnce(undefined)
    const github = makeFakeGithub({ mergePullRequest })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature Z', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

    let current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('merge')
    expect(current.error).toMatch(/mergePullRequest transient failure/)
    expect(mergePullRequest).toHaveBeenCalledTimes(1)
    // Issue #38 regression: previously commentOnIssue was called before mergePullRequest,
    // leaving a duplicate comment if mergePullRequest failed and was retried.
    expect(github.commentOnIssue).not.toHaveBeenCalled()

    engine.retry(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.error).toBeUndefined()
    expect(mergePullRequest).toHaveBeenCalledTimes(2)
    expect(github.commentOnIssue).toHaveBeenCalledTimes(1)
  })

  it('completes the merge stage as done even if post-merge commentOnIssue fails', async () => {
    const commentOnIssue = vi.fn().mockRejectedValue(new Error('commentOnIssue failure'))
    const github = makeFakeGithub({ commentOnIssue })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature W', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

    const current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.status).toBe('done')
    expect(current.error).toBeUndefined()
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1)
    expect(commentOnIssue).toHaveBeenCalledTimes(1)
  })

  it('retrying a failed notes-only pr stage re-creates the branch without hitting "Reference already exists"', async () => {
    // commitFile fails on the first attempt (simulating a transient failure after createBranch already
    // succeeded), then succeeds on retry. createBranch is called again by the retried stage — with the
    // real GithubService that would previously reject with "Reference already exists" (issue #37); here
    // it's a fake that unconditionally succeeds, matching the now-idempotent real implementation, so this
    // asserts retry() correctly drives the stage back through to done rather than getting stuck.
    const commitFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('commitFile transient failure'))
      .mockResolvedValueOnce(undefined)
    const github = makeFakeGithub({ commitFile })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature V', repo, false)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused') // issue done
    let current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('pr') // next stage to run

    engine.advance(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error') // pr stage fails

    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('pr')
    expect(current.error).toMatch(/commitFile transient failure/)
    expect(github.createBranch).toHaveBeenCalledTimes(1)

    engine.retry(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('review')
    expect(current.error).toBeUndefined()
    expect(github.createBranch).toHaveBeenCalledTimes(2)
    expect(commitFile).toHaveBeenCalledTimes(2)
    expect(github.createPullRequest).toHaveBeenCalledTimes(1)
  })

  it('retrying a failed notes-only pr stage re-commits the note and reuses the PR after createPullRequest fails', async () => {
    // PR #46 review follow-up: the first regression only covered commitFile failing. This covers the
    // other post-branch failure the review flagged — createPullRequest fails once *after* commitFile
    // already succeeded, so the retry re-calls createBranch (idempotent, issue #37) and commitFile
    // (idempotent via the existing-sha lookup) for the same note before createPullRequest succeeds.
    const createPullRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error('createPullRequest transient failure'))
      .mockResolvedValueOnce({ number: 2, html_url: 'https://github.com/acme/widgets/pull/2' })
    const github = makeFakeGithub({ createPullRequest })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature U', repo, false)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused') // issue done
    let current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('pr') // next stage to run

    engine.advance(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error') // pr stage fails

    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('pr')
    expect(current.error).toMatch(/createPullRequest transient failure/)
    expect(github.createBranch).toHaveBeenCalledTimes(1)
    expect(github.commitFile).toHaveBeenCalledTimes(1)

    engine.retry(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('review')
    expect(current.error).toBeUndefined()
    expect(current.github.prNumber).toBe(2)
    expect(github.createBranch).toHaveBeenCalledTimes(2)
    expect(github.commitFile).toHaveBeenCalledTimes(2)
    expect(createPullRequest).toHaveBeenCalledTimes(2)
  })

  it('retry() rejects tasks that are not currently in an error state', () => {
    const engine = new WorkflowEngine(makeFakeGithub())
    engine.setProviders([makeProvider('agent-a')])
    const task = engine.enqueue('Add feature Z', repo)
    expect(() => engine.retry(task.id)).toThrow(/not in an error state/)
  })

  it('pauses after each stage when autoAdvance is false, and advance() resumes exactly one stage', async () => {
    const github = makeFakeGithub()
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature W', repo, false)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

    let current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('pr')
    expect(current.history).toHaveLength(1)

    expect(() => engine.advance('unknown-id')).toThrow(/Unknown task/)

    engine.advance(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')
    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('review')
    expect(current.history).toHaveLength(2)

    // Flip to auto-advance mid-flight and it should run the remaining stages unattended.
    engine.setAutoAdvance(task.id, true)
    engine.advance(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')
    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.history).toHaveLength(4)
  })

  it('throws when no AI providers are registered', async () => {
    const engine = new WorkflowEngine(makeFakeGithub())
    const task = engine.enqueue('Add feature V', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')
    const current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.error).toMatch(/No AI providers registered/)
  })

  it('enqueueFromIssue defaults to autoAdvance=true but honors an explicit false', async () => {
    const github = makeFakeGithub()
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    // Default (no 5th arg) preserves auto-trigger's existing unattended behavior.
    const auto = engine.enqueueFromIssue(1, 'https://github.com/acme/widgets/issues/1', 'Bug A', repo)
    expect(auto.stage).toBe('pr')
    expect(auto.autoAdvance).toBe(true)
    await waitFor(() => engine.getTasks().find((t) => t.id === auto.id)?.status === 'done')
    expect(github.createIssue).not.toHaveBeenCalled()
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1)

    // Explicit false pauses after the 'pr' stage instead of running through to merge.
    const paused = engine.enqueueFromIssue(2, 'https://github.com/acme/widgets/issues/2', 'Bug B', repo, false)
    expect(paused.autoAdvance).toBe(false)
    await waitFor(() => engine.getTasks().find((t) => t.id === paused.id)?.status === 'paused')
    const current = engine.getTasks().find((t) => t.id === paused.id)!
    expect(current.stage).toBe('review')
    expect(current.history).toHaveLength(1)
  })

  describe('provider override', () => {
    it('honors the preferred provider except when it would violate maker-checker, across all stages', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

      const task = engine.enqueue('Add feature P', repo, true, { providerId: 'agent-a' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

      const finished = engine.getTasks().find((t) => t.id === task.id)!
      expect(finished.history.map((h) => h.stage)).toEqual(['issue', 'pr', 'review', 'merge'])

      // Preference wins whenever honoring it wouldn't hand a stage back to the prior stage's agent;
      // maker-checker wins (falls back to the other provider) whenever it would.
      expect(finished.history.map((h) => h.agentId)).toEqual(['agent-a', 'agent-b', 'agent-a', 'agent-b'])

      // No two consecutive stages ever reuse the same agent, override or not.
      for (let i = 1; i < finished.history.length; i++) {
        expect(finished.history[i].agentId).not.toBe(finished.history[i - 1].agentId)
      }
    })

    it('applies model/effort overrides to the selected provider without mutating the saved provider config', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      const providerA = makeProvider('agent-a')
      const providerB = makeProvider('agent-b')
      engine.setProviders([providerA, providerB])

      const task = engine.enqueue('Add feature Q', repo, false, { model: 'custom-model', effort: 'high' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.history[0].model).toBe('custom-model')
      expect(current.history[0].effort).toBe('high')

      // The stored provider configs themselves must be untouched.
      expect(providerA.model).toBe('agent-a-model')
      expect(providerA.effort).toBeUndefined()
      expect(providerB.model).toBe('agent-b-model')
    })

    it('falls back to the sole registered provider when a providerId override has no stage-eligible alternative', async () => {
      // With only one provider registered, maker-checker relaxes for the override path too —
      // consistent with the no-override path which never errors in a single-provider setup.
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a')])

      const task = engine.enqueue('Add feature R', repo, true, { providerId: 'agent-a' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      // All four stages complete with agent-a (only provider available).
      expect(current.history).toHaveLength(4)
      expect(current.history.every((h) => h.agentId === 'agent-a')).toBe(true)
      expect(github.createPullRequest).toHaveBeenCalledTimes(1)
    })

    it('rejects an override that references an unregistered provider id', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

      const task = engine.enqueue('Add feature S', repo, true, { providerId: 'nonexistent' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.error).toMatch(/unknown provider/i)
    })

    it('resolves model and effort from selected preset when default model is unset', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      const providerWithPreset: AiProviderConfig = {
        id: 'agent-preset',
        name: 'agent-preset',
        kind: 'cli',
        command: 'claude',
        presets: [
          { id: 'preset-1', model: 'claude-3-7-sonnet', effort: 'high' },
        ],
        selectedPresetId: 'preset-1',
      }
      engine.setProviders([providerWithPreset, makeProvider('agent-b')])

      const task = engine.enqueue('Add feature Preset', repo, false, { providerId: 'agent-preset' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.history[0].model).toBe('claude-3-7-sonnet')
      expect(current.history[0].effort).toBe('high')
    })
  })

  describe('role assignment (swarm_orchestrator-style Worker/Reviewer/Maintainer pins)', () => {
    it('lets a Worker pin handle issue+pr with the same agent, and falls back to providerId for unpinned roles', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

      const task = engine.enqueue('Add feature T', repo, true, {
        providerId: 'agent-b',
        roles: { worker: 'agent-a' },
      })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

      const finished = engine.getTasks().find((t) => t.id === task.id)!
      expect(finished.history.map((h) => h.stage)).toEqual(['issue', 'pr', 'review', 'merge'])
      // Worker pin reuses itself across issue -> pr (same role, not a maker-checker violation); review
      // and merge have no role pin, so they fall back to providerId ('agent-b'), still maker-checker-guarded.
      expect(finished.history.map((h) => h.agentId)).toEqual(['agent-a', 'agent-a', 'agent-b', 'agent-a'])
    })

    it('assigns all three roles to distinct agents end to end', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

      const task = engine.enqueue('Add feature U', repo, true, {
        roles: { worker: 'agent-a', reviewer: 'agent-b', maintainer: 'agent-a' },
      })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

      const finished = engine.getTasks().find((t) => t.id === task.id)!
      expect(finished.history.map((h) => h.agentId)).toEqual(['agent-a', 'agent-a', 'agent-b', 'agent-a'])
    })

    it('still guards a Reviewer/Maintainer pin across a role boundary, falling back to another provider', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

      // Reviewer is pinned to the same agent as Worker — a real maker-checker conflict at the 'pr' ->
      // 'review' boundary — so it must be passed over for the other registered provider. Maintainer has
      // no pin, so 'merge' falls back to the default rotation, excluding review's agent ('agent-b').
      const task = engine.enqueue('Add feature V', repo, true, {
        roles: { worker: 'agent-a', reviewer: 'agent-a' },
      })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

      const finished = engine.getTasks().find((t) => t.id === task.id)!
      expect(finished.history.map((h) => h.agentId)).toEqual(['agent-a', 'agent-a', 'agent-b', 'agent-a'])
    })

    it('fails clearly when a Reviewer pin conflicts with the previous stage and no alternative provider exists', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a')])

      const task = engine.enqueue('Add feature W2', repo, true, {
        roles: { worker: 'agent-a', reviewer: 'agent-a' },
      })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      // issue + pr succeed under the Worker pin (same role, no guard needed)...
      expect(current.history).toHaveLength(2)
      expect(current.stage).toBe('review')
      // ...but review can't honor the Reviewer pin without a second provider, and fails clearly.
      expect(current.error).toMatch(/no other provider is registered/i)
    })

    it('rejects a role pin that references an unregistered provider id', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

      const task = engine.enqueue('Add feature X2', repo, true, { roles: { worker: 'nonexistent' } })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.error).toMatch(/unknown provider/i)
    })
  })

  it('snapshots the provider kind on each step, so a later provider edit cannot relabel a past run', async () => {
    const engine = new WorkflowEngine(makeFakeGithub())
    const claudeCli: AiProviderConfig = {
      id: 'agent-a',
      name: 'Primary Worker',
      kind: 'cli',
      command: 'claude',
      providerKindId: 'claude',
    }
    engine.setProviders([claudeCli, makeProvider('agent-b')])

    const task = engine.enqueue('Snapshot the tool', repo, false)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

    // ai:save replaces the provider list wholesale, and may do so mid-run. The recorded step must
    // keep describing the tool that actually ran, not whatever that id points at now.
    engine.setProviders([{ ...claudeCli, providerKindId: 'codex', command: 'codex' }, makeProvider('agent-b')])

    const current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.history[0]).toMatchObject({ agentId: 'agent-a', providerKindId: 'claude' })
  })

  describe('one-shot run override (card Tool/Model/Effort dropdowns)', () => {
    /** Runs `title` with autoAdvance off and parks it at the 'pr' stage, having run 'issue'. */
    async function pausedAtPr(engine: WorkflowEngine, title: string) {
      const task = engine.enqueue(title, repo, false)
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')
      return task.id
    }

    it('routes one stage to the picked provider, then rotates normally again', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b'), makeProvider('agent-c')])
      const id = await pausedAtPr(engine, 'One-shot A')

      // Default rotation would pick agent-b for 'pr' (first provider that isn't issue's agent-a).
      engine.advance(id, { providerId: 'agent-c' })
      await waitFor(() => engine.getTasks().find((t) => t.id === id)?.status === 'paused')
      const afterPr = engine.getTasks().find((t) => t.id === id)!
      expect(afterPr.history.map((h) => h.agentId)).toEqual(['agent-a', 'agent-c'])
      // Consumed by that single execution and gone before the stage even started.
      expect(afterPr.nextRunOverride).toBeUndefined()

      // The next stage falls back to plain maker-checker rotation, with no trace of the pick.
      engine.advance(id)
      await waitFor(() => engine.getTasks().find((t) => t.id === id)?.status === 'paused')
      const afterReview = engine.getTasks().find((t) => t.id === id)!
      expect(afterReview.history.map((h) => h.agentId)).toEqual(['agent-a', 'agent-c', 'agent-a'])
      expect(afterReview.providerOverride).toBeUndefined()
    })

    it('applies a one-shot model/effort to the selected provider without mutating its saved config', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      const providerA = makeProvider('agent-a')
      const providerB = makeProvider('agent-b')
      engine.setProviders([providerA, providerB])
      const id = await pausedAtPr(engine, 'One-shot B')

      engine.advance(id, { model: 'one-shot-model', effort: 'max' })
      await waitFor(() => engine.getTasks().find((t) => t.id === id)?.status === 'paused')

      const task = engine.getTasks().find((t) => t.id === id)!
      expect(task.history[1].model).toBe('one-shot-model')
      expect(task.history[1].effort).toBe('max')
      // ...and the stage after it goes back to the provider's own model with no effort.
      engine.advance(id)
      await waitFor(() => engine.getTasks().find((t) => t.id === id)?.status === 'paused')
      const after = engine.getTasks().find((t) => t.id === id)!
      expect(after.history[2].model).toBe('agent-a-model')
      expect(after.history[2].effort).toBeUndefined()
      // The saved provider configs are untouched by any of it.
      expect(providerA.effort).toBeUndefined()
      expect(providerB.model).toBe('agent-b-model')
    })

    it('does not overwrite the task-level providerOverride pin', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b'), makeProvider('agent-c')])
      const task = engine.enqueue('One-shot C', repo, false, { providerId: 'agent-b', model: 'pinned-model' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

      engine.advance(task.id, { providerId: 'agent-c', model: 'just-this-once' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.history[1]).toMatchObject({ agentId: 'agent-c', model: 'just-this-once' })
      // The durable pin survives untouched and reasserts itself on the following stage.
      expect(current.providerOverride).toEqual({ providerId: 'agent-b', model: 'pinned-model' })
      engine.advance(task.id)
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')
      const after = engine.getTasks().find((t) => t.id === task.id)!
      expect(after.history[2]).toMatchObject({ agentId: 'agent-b', model: 'pinned-model' })
    })

    it('lets a Worker re-pick itself across issue -> pr, but blocks it across a role boundary', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])
      const id = await pausedAtPr(engine, 'One-shot D')

      // issue -> pr is the same Worker role continuing, not a check on its own work.
      engine.advance(id, { providerId: 'agent-a' })
      await waitFor(() => engine.getTasks().find((t) => t.id === id)?.status === 'paused')
      expect(engine.getTasks().find((t) => t.id === id)!.history.map((h) => h.agentId)).toEqual([
        'agent-a',
        'agent-a',
      ])

      // pr -> review crosses into the Reviewer role, so agent-a may not check itself.
      expect(() => engine.advance(id, { providerId: 'agent-a' })).toThrow(/maker-checker requires a different/i)
      const current = engine.getTasks().find((t) => t.id === id)!
      // The rejected click leaves the task exactly as it was — still paused, still armed with nothing.
      expect(current.status).toBe('paused')
      expect(current.stage).toBe('review')
      expect(current.nextRunOverride).toBeUndefined()
    })

    it('allows picking the only registered provider even across a role boundary', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      engine.setProviders([makeProvider('agent-a')])
      const id = await pausedAtPr(engine, 'One-shot E')

      engine.advance(id, { providerId: 'agent-a' })
      await waitFor(() => engine.getTasks().find((t) => t.id === id)?.status === 'paused')
      // 'review' after 'pr' is a role boundary, but there is no one else to hand it to — the same
      // relaxation the no-preference path applies in a single-provider setup.
      engine.advance(id, { providerId: 'agent-a' })
      await waitFor(() => engine.getTasks().find((t) => t.id === id)?.status === 'paused')
      expect(engine.getTasks().find((t) => t.id === id)!.history.map((h) => h.agentId)).toEqual([
        'agent-a',
        'agent-a',
        'agent-a',
      ])
    })

    it('rejects an unknown provider, an unknown effort, and a stage-ineligible pick without touching the task', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b', ['review'])])
      const id = await pausedAtPr(engine, 'One-shot F')

      expect(() => engine.advance(id, { providerId: 'nobody' })).toThrow(/unknown provider/i)
      expect(() => engine.advance(id, { effort: 'turbo' as never })).toThrow(/unknown reasoning effort/i)
      expect(() => engine.advance(id, { providerId: 'agent-b' })).toThrow(/not configured to handle the "pr" stage/i)

      const current = engine.getTasks().find((t) => t.id === id)!
      expect(current.status).toBe('paused')
      expect(current.history).toHaveLength(1)
      expect(current.nextRunOverride).toBeUndefined()
    })

    it('carries a one-shot through retry() of a failed stage, and drops it once consumed', async () => {
      let failNext = true
      const github = makeFakeGithub({
        reviewPullRequest: vi.fn(async () => {
          if (failNext) {
            failNext = false
            throw new Error('reviewPullRequest transient failure')
          }
        }),
      })
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b'), makeProvider('agent-c')])

      const task = engine.enqueue('One-shot G', repo)
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')
      const failed = engine.getTasks().find((t) => t.id === task.id)!
      expect(failed.stage).toBe('review')

      // 'pr' ran as agent-b, so the default retry would pick agent-a; ask for agent-c instead.
      engine.retry(task.id, { providerId: 'agent-c', effort: 'high' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

      const done = engine.getTasks().find((t) => t.id === task.id)!
      expect(done.history.map((h) => h.agentId)).toEqual(['agent-a', 'agent-b', 'agent-c', 'agent-a'])
      expect(done.history[2].effort).toBe('high')
      // The merge stage that followed is untouched by the one-shot.
      expect(done.history[3].effort).toBeUndefined()
      expect(done.nextRunOverride).toBeUndefined()
    })

    it('treats an all-empty override as no override at all', async () => {
      const engine = new WorkflowEngine(makeFakeGithub())
      engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])
      const id = await pausedAtPr(engine, 'One-shot H')

      // What an untouched dropdown row posts.
      engine.advance(id, { providerId: undefined, model: undefined, effort: undefined })
      await waitFor(() => engine.getTasks().find((t) => t.id === id)?.status === 'paused')
      const current = engine.getTasks().find((t) => t.id === id)!
      expect(current.history.map((h) => h.agentId)).toEqual(['agent-a', 'agent-b'])
      expect(current.nextRunOverride).toBeUndefined()
    })
  })

  describe('allowedStages', () => {
    it('restricts a provider to only its allowed stages, routing other stages to an eligible provider', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      // agent-a may only run the review stage; agent-b handles everything else.
      engine.setProviders([makeProvider('agent-a', ['review']), makeProvider('agent-b')])

      const task = engine.enqueue('Add feature T', repo)
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

      const finished = engine.getTasks().find((t) => t.id === task.id)!
      expect(finished.history).toHaveLength(4)
      expect(finished.history.map((h) => h.stage)).toEqual(['issue', 'pr', 'review', 'merge'])

      // agent-a must only appear at the review stage.
      expect(finished.history.find((h) => h.stage === 'review')?.agentId).toBe('agent-a')
      expect(finished.history.filter((h) => h.agentId === 'agent-a')).toHaveLength(1)

      // Stages that are not review must be handled by agent-b (the only unrestricted provider).
      for (const step of finished.history.filter((h) => h.stage !== 'review')) {
        expect(step.agentId).toBe('agent-b')
      }

      // Maker-checker is best-effort when only one provider is eligible for a stage; what we can
      // assert is that stage-eligible selection is honoured: agent-a never appears outside review.
    })

    it('fails clearly when no provider is configured for the current stage', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      // agent-a is only allowed to run `issue`; no provider can handle `pr` onward.
      engine.setProviders([makeProvider('agent-a', ['issue'])])

      const task = engine.enqueue('Add feature U', repo)
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      // issue succeeds, pr fails because no provider is eligible.
      expect(current.history).toHaveLength(1)
      expect(current.stage).toBe('pr')
      expect(current.error).toMatch(/no ai provider is configured to handle the "pr" stage/i)
    })

    it('fails clearly when a provider override names a provider not eligible for the target stage', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      // agent-a is only for review; agent-b handles everything.
      engine.setProviders([makeProvider('agent-a', ['review']), makeProvider('agent-b')])

      // Explicitly request agent-a (review-only) for a task that starts at the issue stage.
      const task = engine.enqueue('Add feature V', repo, true, { providerId: 'agent-a' })
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.stage).toBe('issue')
      expect(current.error).toMatch(/not configured to handle the "issue" stage/i)
    })

    it('falls back to the only stage-eligible provider (via override) when stage restrictions leave no alternative', async () => {
      // Regression for P1 review finding: A(issue+pr) + B(review+merge), override:A.
      // At the pr stage, A already ran issue but is the only eligible provider for pr —
      // maker-checker should relax (same as single-eligible-provider fallback), not error.
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([
        makeProvider('agent-a', ['issue', 'pr']),
        makeProvider('agent-b', ['review', 'merge']),
      ])

      // autoAdvance:false so we can inspect state after each stage without racing past review.
      const task = engine.enqueue('Add feature Y2', repo, false, { providerId: 'agent-a' })

      // issue stage runs, task pauses at pr.
      await waitFor(() => {
        const t = engine.getTasks().find((t) => t.id === task.id)
        return t?.status === 'paused' && t.stage === 'pr'
      })

      // pr stage — A is the only eligible provider even though it just ran issue.
      engine.advance(task.id)
      await waitFor(() => {
        const t = engine.getTasks().find((t) => t.id === task.id)
        return t?.status === 'paused' && t.stage === 'review'
      })

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.error).toBeUndefined()
      expect(current.history).toHaveLength(2)
      expect(current.history.find((h) => h.stage === 'issue')?.agentId).toBe('agent-a')
      expect(current.history.find((h) => h.stage === 'pr')?.agentId).toBe('agent-a')
    })

    it('permits a provider with an empty allowedStages array to run any stage (same as absent)', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      // Empty array should behave identically to no restriction.
      engine.setProviders([makeProvider('agent-a', []), makeProvider('agent-b', [])])

      const task = engine.enqueue('Add feature W2', repo)
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

      const finished = engine.getTasks().find((t) => t.id === task.id)!
      expect(finished.history).toHaveLength(4)
      for (let i = 1; i < finished.history.length; i++) {
        expect(finished.history[i].agentId).not.toBe(finished.history[i - 1].agentId)
      }
    })
  })

  describe('runStage notify() guarding (regression for a throwing "change" listener)', () => {
    /** Simulates a persistence listener (like createMaoApp's store.set) — only records a snapshot when it doesn't throw. */
    function makeDurableStore() {
      let snapshot: QueuedTask[] | undefined
      return {
        listener: (queue: QueuedTask[]) => {
          snapshot = structuredClone(queue)
        },
        get: () => snapshot,
      }
    }

    it('lands the task in "error" instead of stuck "running" when the entry notify listener throws once transiently', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a')])
      const store = makeDurableStore()

      let calls = 0
      engine.on('change', (queue) => {
        calls++
        // Call 1 is enqueue()'s own notify() — let it through so the task actually gets queued.
        // Call 2 (runStage's entry notify) throws exactly once; every later call succeeds — this
        // models a one-off transient failure, not a permanently broken store.
        if (calls === 2) throw new Error('persistence boom')
        store.listener(queue)
      })

      const task = engine.enqueue('Add feature Boom', repo, false)
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.status).toBe('error')
      expect(current.error).toMatch(/persistence boom/)
      // The throw happened on runStage's entry notify, before any real work — no GitHub write, no history.
      expect(current.history).toHaveLength(0)
      expect(github.createIssue).not.toHaveBeenCalled()
      // The guarded retry notify must have actually reached the durable store, not just the
      // in-memory task — otherwise a restart could reload the stale pre-'error' snapshot.
      const persisted = store.get()?.find((t) => t.id === task.id)
      expect(persisted?.status).toBe('error')
      expect(engine.isPersistenceBroken()).toBe(false)
    })

    it('lands the task in "error" in the durable store (not a silently-lost advance) when the exit notify listener throws once transiently', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a')])
      const store = makeDurableStore()

      let calls = 0
      engine.on('change', (queue) => {
        calls++
        // Calls 1-3 are enqueue()'s notify() plus runStage's entry and active-set notify — let the
        // stage's real work (the GitHub issue creation) actually happen. Call 4 — the exit notify
        // fired after the stage already advanced in memory — throws exactly once; the guarded
        // retry (call 5) succeeds, modeling a transient failure rather than a broken store.
        if (calls === 4) throw new Error('persistence boom')
        store.listener(queue)
      })

      const task = engine.enqueue('Add feature Boom 2', repo, false)
      await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

      const current = engine.getTasks().find((t) => t.id === task.id)!
      expect(current.status).toBe('error')
      expect(current.error).toMatch(/persistence boom/)
      // The 'issue' stage's real GitHub write already succeeded and the task already advanced to
      // 'pr' in memory — that must not be silently discarded, nor re-run (which would duplicate the
      // GitHub write) — it should surface as a normal retryable error at the advanced stage, and
      // the guarded retry must land that 'error' in the durable store, not just in memory: a stale
      // durable snapshot at the pre-advance 'running'/'issue' state is exactly what would let a
      // restart with resume:true replay the GitHub write that already succeeded.
      expect(current.stage).toBe('pr')
      expect(current.history).toHaveLength(1)
      expect(github.createIssue).toHaveBeenCalledTimes(1)
      const persisted = store.get()?.find((t) => t.id === task.id)
      expect(persisted?.status).toBe('error')
      expect(persisted?.stage).toBe('pr')
      expect(engine.isPersistenceBroken()).toBe(false)
    })

    it('marks persistence as terminally broken — and stops processing further tasks — when notify() keeps throwing', async () => {
      const github = makeFakeGithub()
      const engine = new WorkflowEngine(github)
      engine.setProviders([makeProvider('agent-a')])

      let calls = 0
      engine.on('change', () => {
        calls++
        // Call 1 is enqueue()'s own notify() for the task below — let it through so the task
        // actually gets queued. Every notify() from inside runStage (call 2 onward) throws,
        // modeling a store that is permanently unable to persist (not a one-off blip).
        if (calls > 1) throw new Error('persistence boom')
      })

      const task1 = engine.enqueue('Add feature Boom 3', repo, false)
      await waitFor(() => engine.isPersistenceBroken())
      // Let the in-flight processQueue() fully settle (its `finally` clears `processing`) before
      // driving a fresh resumeProcessing() below.
      await new Promise((r) => setTimeout(r, 0))

      expect(engine.getPersistenceError()?.message).toMatch(/persistence boom/)
      const first = engine.getTasks().find((t) => t.id === task1.id)!
      expect(first.status).toBe('error')
      expect(github.createIssue).not.toHaveBeenCalled()

      // A second task queued directly into the live queue — bypassing enqueue()'s own notify(),
      // which is a separate, unguarded call outside the scope of this regression (see runStage) —
      // must be left completely untouched: processQueue() refuses to run any further stages once
      // persistence is confirmed broken.
      engine.getTasks().push({
        id: 'sentinel-task',
        title: 'Untouched sentinel',
        repo,
        stage: 'issue',
        history: [],
        status: 'pending',
        autoAdvance: false,
        github: {},
      })

      // A fresh attempt to resume processing must also be refused, not just the in-flight one.
      engine.resumeProcessing()
      await new Promise((r) => setTimeout(r, 20))
      expect(engine.getTasks().find((t) => t.id === 'sentinel-task')!.status).toBe('pending')
    })
  })
})

describe('WorkflowEngine repository permission preflight', () => {
  const readOnly = evaluateRepoCapability({
    owner: 'acme',
    repo: 'widgets',
    repository: { has_issues: true, permissions: { push: false } },
  })
  const writable = evaluateRepoCapability({
    owner: 'acme',
    repo: 'widgets',
    repository: { has_issues: true, permissions: { push: true } },
  })

  /** A fake whose preflight rejects with the same error GithubService would raise. */
  function unauthorizedGithub(overrides: Partial<Record<string, unknown>> = {}) {
    return makeFakeGithub({
      assertRepoWorkflowWritable: vi.fn(async () => {
        throw new RepoCapabilityError(readOnly)
      }),
      ...overrides,
    })
  }

  /** Every GitHub method that writes — none may be called when the preflight fails. */
  function expectNoGithubWrites(github: GithubService) {
    const writes = [
      'createIssue',
      'addLabel',
      'createBranch',
      'commitFile',
      'createPullRequest',
      'reviewPullRequest',
      'commentOnIssue',
      'mergePullRequest',
    ] as const
    for (const write of writes) {
      expect(github[write], `${write} must not run without permission`).not.toHaveBeenCalled()
    }
  }

  it('fails a directly enqueued task at its own stage without touching AI, git, or GitHub', async () => {
    const github = unauthorizedGithub()
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature X', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

    const current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('issue')
    expect(current.error).toMatch(/acme\/widgets is missing permissions/)
    expect(current.history).toHaveLength(0)
    expect(ai.createAiProvider).not.toHaveBeenCalled()
    expect(git.ensureClone).not.toHaveBeenCalled()
    expect(git.commitAndPush).not.toHaveBeenCalled()
    expectNoGithubWrites(github)
  })

  it('runs the preflight before agent selection, so an unauthorized repo reports permission even with no providers', async () => {
    // Ordering matters: reporting "No AI providers registered" here would send the operator to fix
    // the wrong thing entirely.
    const github = unauthorizedGithub()
    const engine = new WorkflowEngine(github)

    const task = engine.enqueue('Add feature X', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

    expect(engine.getTasks().find((t) => t.id === task.id)!.error).toMatch(/missing permissions/)
  })

  it('blocks the real-checkout pr path before any clone or force-push', async () => {
    const github = unauthorizedGithub()
    const engine = new WorkflowEngine(github)
    engine.setGithubToken('test-token')
    engine.setWorkspaceRoot('/tmp/mao-test-workspaces')
    engine.setProviders([
      { id: 'agent-cli', name: 'agent-cli', kind: 'cli', command: 'claude' },
      makeProvider('agent-b'),
    ])

    const task = engine.enqueueFromIssue(7, 'https://github.com/acme/widgets/issues/7', 'Fix it', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

    expect(engine.getTasks().find((t) => t.id === task.id)!.stage).toBe('pr')
    expect(git.ensureClone).not.toHaveBeenCalled()
    expect(git.checkoutBranch).not.toHaveBeenCalled()
    expect(git.commitAndPush).not.toHaveBeenCalled()
    expect(ai.createAiProvider).not.toHaveBeenCalled()
    expectNoGithubWrites(github)
  })

  it('preflights a task restored from a previous session before resuming it', async () => {
    const github = unauthorizedGithub()
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    engine.restore(
      [
        {
          id: 'restored-task',
          title: 'Left over',
          repo,
          stage: 'review',
          history: [],
          status: 'pending',
          autoAdvance: true,
          github: { issueNumber: 7, prNumber: 2 },
        },
      ],
      { resume: true },
    )
    await waitFor(() => engine.getTasks()[0].status === 'error')

    expect(engine.getTasks()[0].stage).toBe('review')
    expect(ai.createAiProvider).not.toHaveBeenCalled()
    expectNoGithubWrites(github)
  })

  it('blocks advance() on a paused task the same way', async () => {
    const assertRepoWorkflowWritable = vi
      .fn()
      .mockResolvedValueOnce(writable)
      .mockRejectedValue(new RepoCapabilityError(readOnly))
    const github = makeFakeGithub({ assertRepoWorkflowWritable })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature X', repo, false)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')
    expect(github.createIssue).toHaveBeenCalledTimes(1)

    engine.advance(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

    const current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.stage).toBe('pr')
    expect(current.history).toHaveLength(1)
    expect(github.createPullRequest).not.toHaveBeenCalled()
  })

  it('retries the same stage successfully once the permission is restored', async () => {
    const assertRepoWorkflowWritable = vi
      .fn()
      .mockRejectedValueOnce(new RepoCapabilityError(readOnly))
      .mockResolvedValue(writable)
    const github = makeFakeGithub({ assertRepoWorkflowWritable })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature X', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')
    expect(github.createIssue).not.toHaveBeenCalled()

    engine.retry(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

    const current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.error).toBeUndefined()
    expect(current.history.map((h) => h.stage)).toEqual(['issue', 'pr', 'review', 'merge'])
    expect(github.createIssue).toHaveBeenCalledTimes(1)
  })

  it('keeps the one-shot run override armed when the preflight rejects the run', async () => {
    // The override is the operator's choice for one execution. A run that never happened must not
    // consume it, or the retry after the grant is restored silently uses a different agent.
    const assertRepoWorkflowWritable = vi
      .fn()
      .mockResolvedValueOnce(writable)
      .mockRejectedValueOnce(new RepoCapabilityError(readOnly))
      .mockResolvedValue(writable)
    const github = makeFakeGithub({ assertRepoWorkflowWritable })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature X', repo, false)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'paused')

    engine.advance(task.id, { providerId: 'agent-b', effort: 'high' })
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

    const blocked = engine.getTasks().find((t) => t.id === task.id)!
    expect(blocked.stage).toBe('pr')
    expect(blocked.nextRunOverride).toEqual({ providerId: 'agent-b', model: undefined, effort: 'high' })

    engine.retry(task.id, { providerId: 'agent-b', effort: 'high' })
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.stage === 'review')

    const ran = engine.getTasks().find((t) => t.id === task.id)!
    expect(ran.history[1].agentId).toBe('agent-b')
    expect(ran.history[1].effort).toBe('high')
    // Consumed exactly once — the next stage rotates as if it never existed.
    expect(ran.nextRunOverride).toBeUndefined()
  })

  it('surfaces a transient preflight failure as a retryable task error rather than a hang', async () => {
    const assertRepoWorkflowWritable = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('GitHub request timed out after 60s'), { name: 'AbortError' }),
      )
      .mockResolvedValue(writable)
    const github = makeFakeGithub({ assertRepoWorkflowWritable })
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Add feature X', repo)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'error')

    expect(engine.getTasks().find((t) => t.id === task.id)!.error).toMatch(/timed out after 60s/)
    expect(github.createIssue).not.toHaveBeenCalled()

    engine.retry(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')
  })

  it('checks the task\'s own repository, including MAO\'s, with no exemption', async () => {
    const github = makeFakeGithub()
    const engine = new WorkflowEngine(github)
    engine.setProviders([makeProvider('agent-a'), makeProvider('agent-b')])

    const task = engine.enqueue('Self-hosted change', { owner: 'dragoncowkarma', repo: 'mao' })
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledWith('dragoncowkarma', 'mao')
    // Once per stage, so a grant revoked mid-pipeline stops the very next stage.
    expect(github.assertRepoWorkflowWritable).toHaveBeenCalledTimes(4)
  })
})
