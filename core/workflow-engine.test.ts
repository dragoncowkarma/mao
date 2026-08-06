import { describe, expect, it, vi } from 'vitest'
import { WorkflowEngine, type RepoRef } from './workflow-engine.ts'
import type { AiProviderConfig } from './ai/types.ts'
import type { GithubService } from './github-service.ts'

vi.mock('./ai/index.ts', () => ({
  createAiProvider: (config: AiProviderConfig) => ({
    id: config.id,
    name: config.name,
    run: vi.fn(async () => `output-from-${config.id}`),
  }),
}))

const repo: RepoRef = { owner: 'acme', repo: 'widgets' }

function makeProvider(id: string): AiProviderConfig {
  return { id, name: id, kind: 'api', apiFormat: 'anthropic', apiKey: 'test-key', model: `${id}-model` }
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

    // CI turns green — retrying the same stage should now succeed through to done.
    ;(github.getChecksStatus as ReturnType<typeof vi.fn>).mockResolvedValue('success')
    engine.retry(task.id)
    await waitFor(() => engine.getTasks().find((t) => t.id === task.id)?.status === 'done')

    current = engine.getTasks().find((t) => t.id === task.id)!
    expect(current.error).toBeUndefined()
    expect(github.mergePullRequest).toHaveBeenCalledTimes(1)
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
})
