import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import Sidebar, { type RepoListResetOutcome } from './Sidebar'
import {
  describeUnloadableStore,
  describeUnusableRepoList,
  describeUnusableTaskQueue,
  type StoredValueProblem,
} from '../../core/store'
import type { QueueRecoveryState, RepoRef } from '../../core/workflow-engine'
import { storedValueProblem } from '../test/store-problem'

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
const UNUSABLE_QUEUE = storedValueProblem(
  'workflowTasks',
  'value',
  describeUnusableTaskQueue({ 'task-1': {} }, '/data/config.json')!,
)

const WIDGETS: RepoRef = { owner: 'acme', repo: 'widgets' }

/**
 * A stored repository list with nothing usable in it, and one with some usable entries — the pair the
 * reset has to tell apart (issue #72).
 *
 * Built from core's own describer, like `UNUSABLE_QUEUE` above and for the same reason, but nothing here
 * asserts on the wording: which words ship is `core/store.test.ts`'s business, and what this file states
 * is a decision about two props.
 */
const NOTHING_USABLE_REPO_LIST = storedValueProblem(
  'githubRepos',
  'every-entry',
  describeUnusableRepoList([null], '/data/config.json')!,
)

const PARTLY_USABLE_REPO_LIST = storedValueProblem(
  'githubRepos',
  'some-entries',
  describeUnusableRepoList([WIDGETS, null], '/data/config.json')!,
)

const HALTED: QueueRecoveryState = {
  required: true,
  reason: UNUSABLE_QUEUE.message,
  restartRequired: false,
  persistenceBroken: false,
}

const PERSISTENCE_BROKEN: QueueRecoveryState = {
  required: true,
  reason:
    'Workflow queue persistence has an unresolved write outcome. No further queue mutation or ' +
    'repository polling is allowed. Verify the stored queue and GitHub state, clear the ' +
    'persistence-broken marker only after that check, then restart MAO.',
  restartRequired: false,
  persistenceBroken: true,
}

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onRecoverQueue = vi.fn(async () => {})
  const onResaveQueue = vi.fn(async () => {})
  const onClearPersistenceBroken = vi.fn(async () => {})
  const props = {
    repos: [],
    selectedIndex: 0,
    onSelect: vi.fn(),
    onAddRepo: vi.fn(async () => []),
    storeProblems: [] as StoredValueProblem[],
    onResetRepoList: vi.fn(async (): Promise<RepoListResetOutcome> => 'replaced'),
    queueRecovery: {
      required: false,
      reason: undefined,
      restartRequired: false,
      persistenceBroken: false,
    } as QueueRecoveryState,
    queueStoredStillUnreadable: false,
    onRecoverQueue,
    onResaveQueue,
    onClearPersistenceBroken,
    view: 'project' as const,
    onViewChange: vi.fn(),
    ...overrides,
  }
  const { rerender } = render(<Sidebar {...props} />)
  return {
    onRecoverQueue,
    onResaveQueue,
    onClearPersistenceBroken,
    onResetRepoList: props.onResetRepoList,
    user: userEvent.setup(),
    rerender: (next: Partial<Parameters<typeof Sidebar>[0]> = {}) => rerender(<Sidebar {...props} {...next} />),
  }
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
    const providers = storedValueProblem(
      'aiProviders',
      'value',
      '[store] "aiProviders" in /data/config.json is an object.',
    )
    renderSidebar({
      queueRecovery: HALTED,
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE, providers],
    })

    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
    expect(screen.getByText('Stored settings could not be read')).toBeInTheDocument()
    expect(screen.getByText(providers.message)).toBeInTheDocument()
  })

  it('withholds the repo-list reset when some of the stored list is still usable', () => {
    // Issue #72's destructive edge. The button writes an *empty* list, which is lossless only while the
    // store holds nothing a caller could have used. With some entries usable the rows below are real:
    // the operator can select one, reach the Settings tab and remove it one at a time — so a one-click
    // "reset" there deletes repositories they can see working, to fix entries they were only being told
    // about.
    renderSidebar({ repos: [WIDGETS], storeProblems: [PARTLY_USABLE_REPO_LIST] })

    expect(screen.getByText('Stored settings could not be read')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset stored list' })).toBeNull()
  })

  it('still offers it when nothing in the stored list is usable', () => {
    // The control for the test above, and it is only that: today's gate would pass this either way. It
    // is here because without it a gate that hid the button in *both* states would look correct.
    renderSidebar({ repos: [], storeProblems: [NOTHING_USABLE_REPO_LIST] })

    expect(screen.getByRole('button', { name: 'Reset stored list' })).toBeInTheDocument()
  })

  it('still shows a partly usable list report, even with no action to offer', () => {
    // The plausible wrong fix for the test above — filtering a report nothing can act on out of the card
    // — would restore the silence issue #72 is actually about. The entries are one list write from being
    // deleted, and this paragraph is the only warning the operator gets.
    renderSidebar({ repos: [WIDGETS], storeProblems: [PARTLY_USABLE_REPO_LIST] })

    expect(screen.getByText(PARTLY_USABLE_REPO_LIST.message)).toBeInTheDocument()
  })

  it('says a confirmed reset wrote nothing, and keeps saying it after the card goes', async () => {
    // AGENTS.md: an action's result must outlive the condition it reports on. `already-readable` means
    // the file is genuinely repaired, so the refresh that follows empties the problem list and unmounts
    // the card — and a sentence rendered inside it would vanish with the thing it was explaining,
    // leaving a confirmed destructive click that looked like it had done nothing at all.
    const onResetRepoList = vi.fn(async (): Promise<RepoListResetOutcome> => 'already-readable')
    const { user, rerender } = renderSidebar({
      storeProblems: [NOTHING_USABLE_REPO_LIST],
      onResetRepoList,
    })

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))

    expect(onResetRepoList).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/Nothing was written/)).toBeInTheDocument()

    rerender({ storeProblems: [] })

    expect(screen.getByText(/Nothing was written/)).toBeInTheDocument()
    expect(screen.queryByText('Stored settings could not be read')).toBeNull()
  })

  it('says which no-write case it was, because they ask different things of the operator', async () => {
    const onResetRepoList = vi.fn(async (): Promise<RepoListResetOutcome> => 'partly-usable')
    const { user } = renderSidebar({
      repos: [WIDGETS],
      storeProblems: [NOTHING_USABLE_REPO_LIST],
      onResetRepoList,
    })

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))

    // Named specifically: this one says entries turned out to name repositories and a whole-list
    // write would have deleted them, which "the list reads normally again" would not have told them.
    expect(await screen.findByText(/would have deleted them/)).toBeInTheDocument()
  })

  it('says nothing at all when the reset did write', async () => {
    // The replacement proves itself: the report goes, the rows go, the empty state appears. A notice
    // there would be noise, and the two cases have to stay distinguishable.
    const { user } = renderSidebar({ storeProblems: [NOTHING_USABLE_REPO_LIST] })

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))

    expect(screen.queryByText(/Nothing was written/)).toBeNull()
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
      queueRecovery: { required: false, reason: undefined, restartRequired: false, persistenceBroken: false },
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
      queueRecovery: { required: false, reason: undefined, restartRequired: false, persistenceBroken: false },
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
      queueRecovery: { required: false, reason: undefined, restartRequired: false, persistenceBroken: false },
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })
    onResaveQueue.mockRejectedValue(new Error('ENOSPC: no space left on device'))

    await user.click(screen.getByRole('button', { name: /Save this session/ }))

    expect(await screen.findByText(/ENOSPC/)).toBeInTheDocument()
  })

  it('prints the late-case explanation once, and the halted report not at all', () => {
    renderSidebar({
      queueRecovery: { required: false, reason: undefined, restartRequired: false, persistenceBroken: false },
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.getAllByText(/This session is not halted/)).toHaveLength(1)
    expect(screen.queryByText(UNUSABLE_QUEUE.message)).toBeNull()
  })

  /**
   * A file that did not load at all is a different late state from a wrong-shaped field in a file that did.
   *
   * Issue #67 made every write refuse while the file is unloadable, which turned the late card's own
   * promise — "its next queue write will rewrite the file from that" — into a falsehood, and left a Save
   * button that `resaveStoredQueue` can only answer `'restart-required'` for. Core marks the whole-file case
   * so the UI can tell them apart without parsing the report.
   *
   * It names no `defect`, because no value was observed to have one — and `nothingUsable: false`, which
   * is what core answers for a state that established nothing: the sidebar must not offer to replace a
   * whole value it cannot read.
   */
  const UNLOADABLE_FILE: StoredValueProblem = {
    field: 'workflowTasks',
    source: '/data/config.json',
    message: describeUnloadableStore('/data/config.json', 'unparseable'),
    wholeFile: true,
    nothingUsable: false,
  }

  it('does not promise a rewrite the write gate refuses', () => {
    renderSidebar({
      queueRecovery: { required: false, reason: undefined, restartRequired: false, persistenceBroken: false },
      queueStoredStillUnreadable: true,
      storeProblems: [UNLOADABLE_FILE],
    })

    expect(screen.queryByText(/next queue write will rewrite the file/)).toBeNull()
    expect(screen.getByText(/every write is refused/)).toBeInTheDocument()
    expect(screen.getByText(/still holds everything it held/)).toBeInTheDocument()
    expect(screen.queryByText(/This session is not halted/)).toBeNull()
    expect(screen.getByText(/Repository polling and new queue mutations are paused/)).toBeInTheDocument()
  })

  it('offers no save button for a file it could not read, because that save cannot succeed', async () => {
    const { onResaveQueue } = renderSidebar({
      queueRecovery: { required: false, reason: undefined, restartRequired: false, persistenceBroken: false },
      queueStoredStillUnreadable: true,
      storeProblems: [UNLOADABLE_FILE],
    })

    expect(screen.queryByRole('button', { name: /Save this session/ })).toBeNull()
    expect(onResaveQueue).not.toHaveBeenCalled()
    // Still not the destructive CLI command, and still not the halted wording.
    expect(screen.queryByText(/confirm-queue-recovery/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Recover readable tasks' })).toBeNull()
  })

  it('still offers the save for a wrong-shaped field in a file that did load', async () => {
    // The flag must discriminate, not suppress: this is the state the save was built for.
    const { user, onResaveQueue } = renderSidebar({
      queueRecovery: { required: false, reason: undefined, restartRequired: false, persistenceBroken: false },
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    await user.click(screen.getByRole('button', { name: /Save this session/ }))

    expect(onResaveQueue).toHaveBeenCalledTimes(1)
  })

  it('offers no recovery action when a halted session can no longer read the whole file', () => {
    renderSidebar({
      queueRecovery: HALTED,
      queueStoredStillUnreadable: true,
      storeProblems: [UNLOADABLE_FILE],
    })

    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
    expect(screen.getByText(/startup snapshot cannot safely write over a repair/)).toBeInTheDocument()
    expect(screen.getByText(/restart MAO to load the complete stored state/)).toBeInTheDocument()
    expect(screen.getByText(/unresolved persistence outcome/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Recover readable tasks' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Save this session/ })).toBeNull()
  })

  it('keeps whole-file-origin recovery restart-only after the file becomes field-readable', () => {
    // The current problem shape is no longer enough to decide safety. A FileStore that previously lost
    // the whole file still holds every other setting from startup, so recovering this now-field-only
    // queue would serialize that stale snapshot over the repair.
    renderSidebar({
      queueRecovery: { ...HALTED, restartRequired: true },
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.getByText(/observed a whole-file read failure/)).toBeInTheDocument()
    expect(screen.getByText(/even if the file is readable now/)).toBeInTheDocument()
    expect(screen.getByText(/unresolved persistence outcome/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Recover readable tasks' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Save this session/ })).toBeNull()
  })

  it('surfaces a marker-only persistence halt and clears it only after confirmation', async () => {
    const { onClearPersistenceBroken, user } = renderSidebar({ queueRecovery: PERSISTENCE_BROKEN })

    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
    expect(screen.getByText(/unresolved write outcome/)).toBeInTheDocument()
    expect(screen.getByText(/Verify the stored queue and GitHub state/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Recover readable tasks' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Save this session/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Clear marker after verification' }))
    expect(onClearPersistenceBroken).not.toHaveBeenCalled()
    expect(screen.getByText(/comparing the stored queue with the target repositories/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm marker clear' }))

    expect(onClearPersistenceBroken).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/marker is cleared/)).toBeInTheDocument()
    expect(screen.getByText(/process remains halted/)).toBeInTheDocument()
    expect(screen.queryByText(/mao config clear-persistence-broken/)).toBeNull()
  })

  it('keeps the confirmation open and surfaces a marker-clear failure', async () => {
    const onClearPersistenceBroken = vi.fn(async () => {
      throw new Error('marker is still present')
    })
    const { user } = renderSidebar({ queueRecovery: PERSISTENCE_BROKEN, onClearPersistenceBroken })

    await user.click(screen.getByRole('button', { name: 'Clear marker after verification' }))
    await user.click(screen.getByRole('button', { name: 'Confirm marker clear' }))

    expect(await screen.findByText('marker is still present')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm marker clear' })).toBeInTheDocument()
    expect(screen.queryByText(/marker is cleared/)).toBeNull()
  })

  it('shows stored queue corruption alongside an independent persistence marker', () => {
    renderSidebar({
      queueRecovery: { ...PERSISTENCE_BROKEN, restartRequired: true },
      queueStoredStillUnreadable: true,
      storeProblems: [UNLOADABLE_FILE],
    })

    expect(screen.getByText(/unresolved write outcome/)).toBeInTheDocument()
    expect(screen.getByText(/also cannot read \/data\/config.json at all/)).toBeInTheDocument()
    expect(screen.getByText(/every stored setting is affected/)).toBeInTheDocument()
    expect(screen.getByText(/independent of the persistence marker/)).toBeInTheDocument()
    expect(screen.getByText(/Repair and inspect the stored data/)).toBeInTheDocument()
  })

  it('also keeps a field-level queue problem visible beside the persistence marker', () => {
    renderSidebar({
      queueRecovery: PERSISTENCE_BROKEN,
      queueStoredStillUnreadable: true,
      storeProblems: [UNUSABLE_QUEUE],
    })

    expect(screen.getByText(/also cannot use the stored workflow queue in \/data\/config.json/)).toBeInTheDocument()
    expect(screen.getByText(/independent of the persistence marker/)).toBeInTheDocument()
  })

  it('says nothing about the queue when nothing is halted', () => {
    renderSidebar()

    expect(screen.queryByText('Workflow automation is halted')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Recover readable tasks' })).toBeNull()
  })
})
