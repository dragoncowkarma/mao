import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar'
import type { StoredValueProblem } from '../../core/store'
import type { QueueRecoveryState } from '../../core/workflow-engine'

/**
 * Sidebar on its own, driven by props.
 *
 * The queue-recovery rules are prop-level — "offer the discard only while the file still holds the
 * unreadable value" is a decision about two inputs, not about a round trip — and App's own poll runs on a
 * 30s interval, so asserting them through a mounted App would mean either faking timers (which deadlocks
 * with user-event, per SKILL.md) or clicking something to force a re-read. Rendering the component
 * directly states the rule precisely.
 */
const UNUSABLE_QUEUE: StoredValueProblem = {
  field: 'workflowTasks',
  source: '/data/config.json',
  message: '[store] "workflowTasks" in /data/config.json is an object, not a JSON array of queued tasks.',
}

const HALTED: QueueRecoveryState = { required: true, reason: UNUSABLE_QUEUE.message }

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onDiscardQueue = vi.fn(async () => {})
  const props = {
    repos: [],
    selectedIndex: 0,
    onSelect: vi.fn(),
    onAddRepo: vi.fn(async () => []),
    storeProblems: [] as StoredValueProblem[],
    onResetRepoList: vi.fn(async () => {}),
    queueRecovery: { required: false, reason: undefined } as QueueRecoveryState,
    queueStoredStillUnreadable: false,
    onDiscardQueue,
    view: 'project' as const,
    onViewChange: vi.fn(),
    ...overrides,
  }
  render(<Sidebar {...props} />)
  return { onDiscardQueue, user: userEvent.setup() }
}

describe('Sidebar queue recovery', () => {
  it('offers a two-step discard while the file still holds the unreadable value', async () => {
    const { onDiscardQueue, user } = renderSidebar({
      queueRecovery: HALTED,
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Discard unreadable queue' }))
    expect(onDiscardQueue).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Confirm discard' }))
    expect(onDiscardQueue).toHaveBeenCalledTimes(1)
  })

  it('does not offer the discard once something else has repaired the file', () => {
    // The rule this file exists for. The latch is monotone, so it stays up after an out-of-band repair —
    // but the write would then replace that repair with this session's coerced empty queue, which is the
    // exact loss the latch exists to prevent. A restart is the only correct way out of that state.
    renderSidebar({ queueRecovery: HALTED, queueStoredStillUnreadable: false, storeProblems: [] })

    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard unreadable queue' })).toBeNull()
    expect(screen.getByText(/Restart MAO to load it/)).toBeInTheDocument()
  })

  it('shows the queue report once, not twice', () => {
    // The latch carries the store's message verbatim, so rendering it in the queue card *and* in the
    // generic problems list would print the same paragraph twice in a narrow column.
    renderSidebar({
      queueRecovery: HALTED,
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.getAllByText(UNUSABLE_QUEUE.message)).toHaveLength(1)
    expect(screen.queryByText('Stored settings could not be read')).toBeNull()
  })

  it('still shows another field report alongside the queue card', () => {
    const providers: StoredValueProblem = {
      field: 'aiProviders',
      source: '/data/config.json',
      message: '[store] "aiProviders" in /data/config.json is an object.',
    }
    renderSidebar({
      queueRecovery: HALTED,
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE, providers],
    })

    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
    expect(screen.getByText('Stored settings could not be read')).toBeInTheDocument()
    expect(screen.getByText(providers.message)).toBeInTheDocument()
  })

  it('offers the repo-list reset only for a githubRepos report, never for the queue', () => {
    // The reset writes an empty `githubRepos` and nothing else, so offering it under the queue's report
    // would put a destructive button under a message that is not about repositories.
    renderSidebar({
      queueRecovery: HALTED,
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.queryByRole('button', { name: 'Reset stored list' })).toBeNull()
  })

  it('says nothing about the queue when nothing is halted', () => {
    renderSidebar()

    expect(screen.queryByText('Workflow automation is halted')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard unreadable queue' })).toBeNull()
  })
})
