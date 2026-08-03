import { describe, expect, it, vi } from 'vitest'
import { parseTaskOverride, startAutoTrigger } from './auto-trigger.ts'
import type { GithubService } from './github-service.ts'
import type { WorkflowEngine } from './workflow-engine.ts'

describe('parseTaskOverride', () => {
  it('parses model and effort directives case-insensitively', () => {
    expect(parseTaskOverride('Please implement this.\n/MODEL claude-opus-5\n/effort HIGH')).toEqual({
      model: 'claude-opus-5',
      effort: 'high',
    })
  })

  it('does not mistake normal prose for a directive and rejects invalid effort', () => {
    expect(parseTaskOverride('The /model setting is documented elsewhere.')).toBeUndefined()
    expect(() => parseTaskOverride('/effort extreme')).toThrow(/Invalid \/effort directive/)
  })

  it('lets directives in the latest comment override directives in the issue body', async () => {
    const enqueueFromIssue = vi.fn()
    const github = {
      fetchTasks: vi.fn(async () => [{
        type: 'issue', state: 'open', labels: [], number: 7, url: 'https://example.test/issues/7', title: 'Task',
        body: '/model body-model\n/effort low',
      }]),
      fetchLatestIssueComment: vi.fn(async () => '/model comment-model\n/effort high'),
      addLabel: vi.fn(async () => {}),
    } as unknown as GithubService
    const autoTrigger = startAutoTrigger(github, { enqueueFromIssue } as unknown as WorkflowEngine, () => [], 60_000)

    await autoTrigger.pollNow({ owner: 'acme', repo: 'widgets' })
    clearInterval(autoTrigger.handle)

    expect(enqueueFromIssue).toHaveBeenCalledWith(
      7,
      'https://example.test/issues/7',
      'Task',
      { owner: 'acme', repo: 'widgets' },
      { model: 'comment-model', effort: 'high' },
    )
  })
})
