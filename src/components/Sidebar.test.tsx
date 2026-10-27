import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar'
import { describeUnloadableStore, describeUnusableTaskQueue, type StoredValueProblem } from '../../core/store'
import type { QueueRecoveryState } from '../../core/workflow-engine'
import type { RepoWorkflowCapability } from '../../core/repo-capabilities'
import { LANGUAGE_NAMES, MESSAGES } from '../i18n'

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
    onResetRepoList: vi.fn(async () => {}),
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
    messages: MESSAGES.en,
    language: 'system' as const,
    onLanguageChange: vi.fn(),
    languageError: '',
    ...overrides,
  }
  render(<Sidebar {...props} />)
  return { onRecoverQueue, onResaveQueue, onClearPersistenceBroken, user: userEvent.setup() }
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
   */
  const UNLOADABLE_FILE: StoredValueProblem = {
    field: 'workflowTasks',
    source: '/data/config.json',
    message: describeUnloadableStore('/data/config.json', 'unparseable'),
    wholeFile: true,
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

describe('Sidebar language menu', () => {
  it('names every language in that language, whatever the sidebar is showing', () => {
    // An operator who picked a language they cannot read has to be able to find the way back, so the
    // options are the one thing in the menu that does not follow the current language.
    renderSidebar({ messages: MESSAGES.ko, language: 'ko' })

    const menu = screen.getByRole('combobox', { name: MESSAGES.ko.language.label })
    expect(menu).toHaveValue('ko')
    expect(within(menu).getAllByRole('option').map((option) => option.textContent)).toEqual([
      // jsdom reports en-US, so 'system' resolves to English here — and says so.
      MESSAGES.ko.language.systemResolved(LANGUAGE_NAMES.en),
      'English',
      '한국어',
    ])
    // And each name says which language it is in, so assistive tech voices it as that language rather
    // than as the page's. 'System' is worded in the page's language and takes the page's.
    expect(within(menu).getAllByRole('option').map((option) => option.getAttribute('lang'))).toEqual([
      null,
      'en',
      'ko',
    ])
  })

  it('hands the chosen preference up', async () => {
    const onLanguageChange = vi.fn()
    const { user } = renderSidebar({ onLanguageChange })
    const menu = screen.getByRole('combobox', { name: 'Language' })

    await user.selectOptions(menu, '한국어')
    expect(onLanguageChange).toHaveBeenLastCalledWith('ko')
    await user.selectOptions(menu, 'English')
    expect(onLanguageChange).toHaveBeenLastCalledWith('en')
  })

  it('says a change was not saved, without the IPC plumbing around the reason', () => {
    renderSidebar({
      languageError:
        "Error invoking remote method 'ui:setLanguage': Error: [store] Refusing to write \"language\" to " +
        '/data/config.json, because the file could not be read.',
    })

    expect(
      screen.getByText(
        MESSAGES.en.language.saveFailed(
          '[store] Refusing to write "language" to /data/config.json, because the file could not be read.',
        ),
      ),
    ).toBeInTheDocument()
  })

  it('says nothing about saving when the last change was saved', () => {
    renderSidebar()

    expect(screen.queryByText(/could not be saved/)).toBeNull()
  })

  it('re-words the unverified-access caveat when the language changes while it is showing', async () => {
    // The caveat is the GUI's only statement that a passing preflight is not proof of write access, so
    // it must not stay behind in the language of the click once the operator switches.
    const unverified: RepoWorkflowCapability = {
      owner: 'acme',
      repo: 'one',
      ok: true,
      gaps: [],
      unverified: ['issues-write', 'contents-write', 'pull-requests-write'],
      observed: { archived: false, disabled: false, hasIssues: true, push: true, private: false, credential: 'unknown' },
    }
    const props = {
      repos: [],
      selectedIndex: null,
      onSelect: vi.fn(),
      onAddRepo: vi.fn(async () => [unverified]),
      storeProblems: [] as StoredValueProblem[],
      onResetRepoList: vi.fn(async () => {}),
      queueRecovery: { required: false, reason: undefined, restartRequired: false, persistenceBroken: false },
      queueStoredStillUnreadable: false,
      onRecoverQueue: vi.fn(async () => {}),
      onResaveQueue: vi.fn(async () => {}),
      onClearPersistenceBroken: vi.fn(async () => {}),
      view: 'project' as const,
      onViewChange: vi.fn(),
      language: 'en' as const,
      onLanguageChange: vi.fn(),
      languageError: '',
    }
    const user = userEvent.setup()
    const { rerender } = render(<Sidebar {...props} messages={MESSAGES.en} />)

    await user.click(screen.getByRole('button', { name: MESSAGES.en.sidebar.addRepo.toggle }))
    await user.type(screen.getByPlaceholderText(MESSAGES.en.sidebar.addRepo.ownerPlaceholder), 'acme')
    await user.type(screen.getByPlaceholderText(MESSAGES.en.sidebar.addRepo.repoPlaceholder), 'one')
    await user.click(screen.getByRole('button', { name: MESSAGES.en.sidebar.addRepo.submit }))

    expect(await screen.findByText(MESSAGES.en.sidebar.addRepo.addedUnverified('acme/one'))).toBeInTheDocument()

    rerender(<Sidebar {...props} language="ko" messages={MESSAGES.ko} />)

    expect(screen.getByText(MESSAGES.ko.sidebar.addRepo.addedUnverified('acme/one'))).toBeInTheDocument()
    expect(screen.queryByText(MESSAGES.en.sidebar.addRepo.addedUnverified('acme/one'))).toBeNull()
  })
})
