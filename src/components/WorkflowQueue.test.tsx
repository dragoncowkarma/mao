import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import WorkflowQueue from './WorkflowQueue'
import { createElectronApiStub } from '../test/electron-api-stub'
import type { QueuedTask, RepoRef } from '../../core/workflow-engine'

const repo: RepoRef = { owner: 'acme', repo: 'widgets' }

/** A finished task, because the Clear completed button only renders when there is something to clear. */
const finishedTask: QueuedTask = {
  id: 'done-1',
  title: 'Finished task',
  repo,
  stage: 'merge',
  history: [],
  status: 'done',
  autoAdvance: false,
  github: {},
}

/**
 * The refusals issue #68's queue latch introduced have to be *visible*.
 *
 * `startWorkflow`, `toggleAutoAdvance` and `clearCompleted` had no `catch` at all — only `retry` and
 * `advance` were routed through `runStage`, which does. That was survivable while nothing else rejected;
 * now the latch refuses all three, and an unhandled rejection presents as the button simply doing
 * nothing, hiding the one message that explains why.
 */
const REFUSAL = '[store] "workflowTasks" in /data/config.json is an object — automation is halted.'

function renderQueue(tasks: QueuedTask[] = []) {
  const stub = createElectronApiStub()
  stub.listWorkflowTasks.mockResolvedValue(tasks)
  const user = userEvent.setup()
  render(<WorkflowQueue repo={repo} />)
  return { stub, user }
}

describe('WorkflowQueue surfaces a refused queue action', () => {
  it('shows why an enqueue was refused instead of failing silently', async () => {
    const { stub, user } = renderQueue()
    stub.api.workflow.enqueue = vi.fn(async () => {
      throw new Error(REFUSAL)
    }) as never

    await user.type(screen.getByPlaceholderText(/task/i), 'Add feature X')
    await user.click(screen.getByRole('button', { name: /start/i }))

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument()
  })

  it('shows why clear-completed was refused', async () => {
    // Gated on purpose: it emits `'change'`, so leaving it open would let this button replace the
    // unreadable stored value with no confirmation at all.
    const { stub, user } = renderQueue([finishedTask])
    stub.api.workflow.clearCompleted = vi.fn(async () => {
      throw new Error(REFUSAL)
    }) as never

    const button = await screen.findByRole('button', { name: /clear/i })
    await user.click(button)

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument()
  })
})
