import { describe, expect, it, vi } from 'vitest'
import { WorkflowEngine, type QueuedTask, type RepoRef } from './workflow-engine.ts'
import type { AgentStage, AiProviderConfig } from './ai/types.ts'
import type { GithubService } from './github-service.ts'

vi.mock('./ai/index.ts', () => ({
  createAiProvider: (config: AiProviderConfig) => ({
    id: config.id,
    name: config.name,
    run: vi.fn(async () => `output-from-${config.id}`),
  }),
}))

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

function makeFakeGithub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
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
