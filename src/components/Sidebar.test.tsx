import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar'
import { describeUnusableTaskQueue, type StoredValueProblem } from '../../core/store'
import type { QueueRecoveryState } from '../../core/workflow-engine'

/**
 * Sidebar on its own, driven by props.
 *
 * The queue-recovery rules are prop-level — "offer recovery only while the file still holds the
 * unreadable value" is a decision about two inputs, not about a round trip — and App's own poll runs on a
 * 30s interval, so asserting them through a mounted App would mean either faking timers (which deadlocks
 * with user-event, per SKILL.md) or clicking something to force a re-read. Rendering the component
 * directly states the rule precisely.
 */
/**
 * The **real** report, from core's own describer rather than a one-line stand-in.
 *
 * A short fixture hid the defect this pins: the actual text asserts that the queue is empty, that MAO
 * will not start unattended work and that every queue write is refused. All three are false for a problem
 * found after a clean start, so rendering it there contradicted the card's own next sentence. Importing
 * the describer means the test keeps checking the words that actually ship.
 */
const UNUSABLE_QUEUE: StoredValueProblem = {
  field: 'workflowTasks',
  source: '/data/config.json',
  message: describeUnusableTaskQueue({ 'task-1': {} }, '/data/config.json')!,
}

const HALTED: QueueRecoveryState = { required: true, reason: UNUSABLE_QUEUE.message }

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onRecoverQueue = vi.fn(async () => {})
  const onResaveQueue = vi.fn(async () => {})
  const props = {
    repos: [],
    selectedIndex: 0,
    onSelect: vi.fn(),
    onAddRepo: vi.fn(async () => []),
    storeProblems: [] as StoredValueProblem[],
    onResetRepoList: vi.fn(async () => {}),
    queueRecovery: { required: false, reason: undefined } as QueueRecoveryState,
    queueStoredStillUnreadable: false,
    onRecoverQueue,
    onResaveQueue,
    view: 'project' as const,
    onViewChange: vi.fn(),
    ...overrides,
  }
  render(<Sidebar {...props} />)
  return { onRecoverQueue, onResaveQueue, user: userEvent.setup() }
}

describe('Sidebar queue recovery', () => {
  it('explains the consequences before recovering an unreadable stored queue', async () => {
    const { onRecoverQueue, user } = renderSidebar({
      queueRecovery: HALTED,
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Recover readable tasks' }))
    expect(onRecoverQueue).not.toHaveBeenCalled()
    expect(screen.getByText(/permanently deletes invalid queue entries/)).toBeInTheDocument()
    expect(screen.getByText(/retains every readable task/)).toBeInTheDocument()
    expect(screen.getByText(/stored as running are restored as pending/)).toBeInTheDocument()
    expect(screen.getByText(/auto-trigger poll.*may execute those retained tasks/s)).toBeInTheDocument()
    expect(screen.getByText(/half-finished branches or pull requests/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Confirm recovery' }))
    expect(onRecoverQueue).toHaveBeenCalledTimes(1)
  })

  it('does not offer recovery once something else has repaired the file', () => {
    // The rule this file exists for. The latch is monotone, so it stays up after an out-of-band repair —
    // but the write would then replace that repair with this session's filtered startup subset, which is
    // the exact loss the latch exists to prevent. A restart is the only correct way out of that state.
    renderSidebar({ queueRecovery: HALTED, queueStoredStillUnreadable: false, storeProblems: [] })

    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Recover readable tasks' })).toBeNull()
    expect(screen.getByText(/Restart MAO to load it/)).toBeInTheDocument()
    expect(screen.getByText(/in-memory queue may be incomplete/)).toBeInTheDocument()
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

  it('shows a late-discovered queue problem even though this session is not halted', () => {
    // Finding 3 from the re-review. The latch is decided at boot, so a file corrupted after a clean boot
    // leaves `required: false` while the 30s storeProblems poll finds it. The old code filtered every
    // workflowTasks report out of the generic list unconditionally while the dedicated card rendered
    // only for a boot-time latch — so in exactly this state NEITHER appeared and the operator saw
    // nothing at all.
    renderSidebar({
      queueRecovery: { required: false, reason: undefined },
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.getByText('The stored workflow queue is unreadable')).toBeInTheDocument()
    expect(screen.getByText(/This session is not halted/)).toBeInTheDocument()
    expect(screen.getByText(/\/data\/config.json/)).toBeInTheDocument()
    // And it must not claim a halt, an empty queue, or refused writes — none of which is true here. The
    // store's report asserts all three, so it must NOT be rendered verbatim in this state.
    expect(screen.queryByText('Workflow automation is halted')).toBeNull()
    expect(screen.queryByText(UNUSABLE_QUEUE.message)).toBeNull()
    for (const claim of [/will not start unattended work/, /queue is empty/, /are refused/]) {
      expect(screen.queryByText(claim)).toBeNull()
    }
  })

  it('offers a save of this session\'s queue for a late problem, never recovery', async () => {
    // Review's finding: recommending `mao workflow confirm-queue-recovery` here is actively unsafe. That
    // command discards, and run in a separate process it writes ITS empty queue over the file — so this
    // session's real queue is lost the moment it restarts without having written. The safe action is for
    // THIS session to save the queue it is holding.
    const { user, onResaveQueue, onRecoverQueue } = renderSidebar({
      queueRecovery: { required: false, reason: undefined },
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.queryByRole('button', { name: 'Recover readable tasks' })).toBeNull()
    expect(screen.queryByText(/Restart MAO to load it/)).toBeNull()
    // And the destructive CLI command must not be named in this state.
    expect(screen.queryByText(/confirm-queue-recovery/)).toBeNull()

    await user.click(screen.getByRole('button', { name: /Save this session/ }))

    expect(onResaveQueue).toHaveBeenCalledTimes(1)
    expect(onRecoverQueue).not.toHaveBeenCalled()
  })

  it('shows why a late save failed instead of failing silently', async () => {
    const { user, onResaveQueue } = renderSidebar({
      queueRecovery: { required: false, reason: undefined },
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })
    onResaveQueue.mockRejectedValue(new Error('ENOSPC: no space left on device'))

    await user.click(screen.getByRole('button', { name: /Save this session/ }))

    expect(await screen.findByText(/ENOSPC/)).toBeInTheDocument()
  })

  it('prints the late-case explanation once, and the halted report not at all', () => {
    renderSidebar({
      queueRecovery: { required: false, reason: undefined },
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.getAllByText(/This session is not halted/)).toHaveLength(1)
    expect(screen.queryByText(UNUSABLE_QUEUE.message)).toBeNull()
  })

  it('says nothing about the queue when nothing is halted', () => {
    renderSidebar()

    expect(screen.queryByText('Workflow automation is halted')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Recover readable tasks' })).toBeNull()
  })
})
