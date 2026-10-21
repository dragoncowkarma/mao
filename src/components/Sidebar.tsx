import { useState } from 'react'
import type { QueueRecoveryState, RepoRef } from '../../core/workflow-engine'
import type { RepoWorkflowCapability } from '../../core/repo-capabilities'
import type { StoredValueProblem } from '../../core/store'

/**
 * Electron re-wraps anything thrown inside `ipcMain.handle` as
 * `Error invoking remote method '<channel>': <ErrorName>: <message>`. The preflight's message is
 * written to be read by an operator, so strip the plumbing rather than showing a channel name and
 * pushing the actionable half out of this narrow column.
 */
function readableIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const match = raw.match(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?(.*)$/s)
  return match ? match[1] : raw
}

/**
 * The three pipeline grants GitHub cannot confirm without a write. Shown after a successful add so the
 * GUI says exactly what `mao repos add` says — a passing preflight is not proof of write access.
 */
function unverifiedNotice(checked: RepoWorkflowCapability[]): string {
  const pending = checked.filter((capability) => capability.unverified.length > 0)
  if (pending.length === 0) return ''
  return (
    `Added, but write access is unverified for ${pending.map((c) => `${c.owner}/${c.repo}`).join(', ')}: ` +
    'GitHub cannot confirm this credential\'s Issues, Contents and Pull requests grants without a ' +
    'write, so a workflow stage can still fail with a permission error.'
  )
}

interface SidebarProps {
  repos: RepoRef[]
  selectedIndex: number | null
  onSelect: (index: number) => void
  /**
   * Rejects when the repo fails the main process's write-permission preflight — the message is shown
   * in the form. Resolves with the verdicts so the unverified-grants caveat can be shown on success.
   */
  onAddRepo: (repo: RepoRef) => Promise<RepoWorkflowCapability[]>
  /**
   * Stored values the main process could not fully use, answered with a safe default or filtered list.
   *
   * Shown here because this is where their absence is: an unusable `githubRepos` reaches the renderer
   * as `[]`, which is indistinguishable from having no repositories — and with no row to select, the
   * project's Settings tab and its Remove button never render, so the guard's own advice to use the
   * sidebar's Remove was not something the operator could actually do.
   */
  storeProblems: StoredValueProblem[]
  /** Discards the unusable stored value by writing an empty list. Rejects if even that write fails. */
  onResetRepoList: () => Promise<void>
  /**
   * Whether unattended work is halted because the stored workflow queue is unreadable or persistence
   * has an unresolved write outcome, and the fixed, value-free report saying why.
   *
   * Driven by the engine rather than by `storeProblems`, because the latch is monotone: after a repair
   * made outside this window the store reads clean while this process stays halted, and the operator
   * still needs to be told that — and told to restart — rather than shown a healthy-looking sidebar.
   */
  queueRecovery: QueueRecoveryState
  /**
   * Whether the config file *still* holds the unreadable queue. False while the latch is up means
   * something else already repaired it, and then recovery must not be offered: it would replace the
   * repair with this process's filtered, restart-normalized queue.
   */
  queueStoredStillUnreadable: boolean
  /** Recovers the queue by deleting invalid entries, retaining readable tasks and releasing the engine. */
  onRecoverQueue: () => Promise<void>
  /**
   * Rewrites the stored queue from the one this session is holding.
   *
   * Offered only for a late, field-level shape problem — this session still has the real queue and the
   * file itself remains writable. A whole-file failure latches on observation and requires restart. A
   * *discard* in the field-only case would be wrong twice over: there is no latch to release, and run in
   * another process it would put that process's independently filtered snapshot in the file.
   */
  onResaveQueue: () => Promise<void>
  /** Clears Electron's own durable marker after the operator confirms reconciliation. */
  onClearPersistenceBroken: () => Promise<void>
  view: 'project' | 'global-settings'
  onViewChange: (view: 'project' | 'global-settings') => void
}

export default function Sidebar({
  repos,
  selectedIndex,
  onSelect,
  onAddRepo,
  storeProblems,
  onResetRepoList,
  queueRecovery,
  queueStoredStillUnreadable,
  onRecoverQueue,
  onResaveQueue,
  onClearPersistenceBroken,
  view,
  onViewChange,
}: SidebarProps) {
  const [adding, setAdding] = useState(false)
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [checking, setChecking] = useState(false)
  const [addError, setAddError] = useState('')
  const [addNotice, setAddNotice] = useState('')
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState('')
  const [confirmingRecovery, setConfirmingRecovery] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [resaving, setResaving] = useState(false)
  const [confirmingPersistenceClear, setConfirmingPersistenceClear] = useState(false)
  const [clearingPersistence, setClearingPersistence] = useState(false)
  const [persistenceMarkerCleared, setPersistenceMarkerCleared] = useState(false)
  const [queueError, setQueueError] = useState('')

  /**
   * Whether it is the *repository list* that is unusable, not merely something in the same file.
   *
   * The reset deletes `githubRepos` and nothing else, so offering it for any other field's report would
   * put a destructive button under a message that is not about repositories. Issue #68 added the second
   * and third fields this now has to be distinguished from, so the check is load-bearing rather than
   * merely prospective.
   */
  const repoListUnusable = storeProblems.some((problem) => problem.field === 'githubRepos')

  /**
   * Whether the stored queue is unusable *right now*, which is not the same as this session being halted.
   *
   * A field-only problem is latched only at boot. A whole-file failure also latches when auto-trigger or
   * the next public queue mutation observes it, but the 30s diagnostic poll can render first. The card
   * therefore needs the current problem as well as the engine's monotone state.
   */
  const queueStoredProblem = storeProblems.find((problem) => problem.field === 'workflowTasks')
  const wholeFileQueueProblem = queueStoredProblem?.wholeFile === true
  const persistenceBroken = queueRecovery.persistenceBroken
  const restartOnlyQueueRecovery = queueRecovery.restartRequired || wholeFileQueueProblem
  const showQueueCard = queueRecovery.required || persistenceBroken || queueStoredProblem !== undefined

  /**
   * The queue's report is filtered out of the generic list only when the dedicated card below actually
   * renders it — filtering unconditionally hid it completely in exactly the case the card does not cover
   * (a clean boot, then corruption), so neither the card nor the generic report appeared at all.
   */
  const otherProblems = storeProblems.filter((problem) => problem.field !== 'workflowTasks' || !showQueueCard)

  async function submitResave() {
    if (resaving) return
    setResaving(true)
    setQueueError('')
    try {
      await onResaveQueue()
    } catch (err) {
      setQueueError(readableIpcError(err))
    } finally {
      setResaving(false)
    }
  }

  async function submitRecovery() {
    if (recovering) return
    setRecovering(true)
    setQueueError('')
    try {
      await onRecoverQueue()
      setConfirmingRecovery(false)
    } catch (err) {
      setQueueError(readableIpcError(err))
    } finally {
      setRecovering(false)
    }
  }

  async function submitPersistenceClear() {
    if (clearingPersistence) return
    setClearingPersistence(true)
    setQueueError('')
    try {
      await onClearPersistenceBroken()
      setPersistenceMarkerCleared(true)
      setConfirmingPersistenceClear(false)
    } catch (err) {
      setQueueError(readableIpcError(err))
    } finally {
      setClearingPersistence(false)
    }
  }

  /**
   * The main process preflights issue/PR write access before it persists anything, so this can fail
   * on a real repository. Keep the form open with what the operator typed and show the message —
   * clearing the fields would make them retype it just to read the reason.
   */
  async function submitAdd() {
    const trimmedOwner = owner.trim()
    const trimmedRepo = repo.trim()
    if (!trimmedOwner || !trimmedRepo || checking) return
    setChecking(true)
    setAddError('')
    setAddNotice('')
    try {
      const checked = await onAddRepo({ owner: trimmedOwner, repo: trimmedRepo })
      setOwner('')
      setRepo('')
      setAdding(false)
      setAddNotice(unverifiedNotice(checked))
    } catch (err) {
      setAddError(readableIpcError(err))
    } finally {
      setChecking(false)
    }
  }

  /**
   * Two-step, like removing a project: this throws away whatever the file holds for the list, and the
   * report above it says to copy anything still wanted out of that file first.
   *
   * Writing an *empty* list rather than the rows on screen is what makes this always available.
   * `updateRepos` preflights write access for every entry it considers newly registered, and an
   * unusable stored value names no tracked repository — so every row would be new, and a missing or
   * revoked token would block the one action the operator has left. An empty list registers nothing.
   */
  async function submitReset() {
    if (resetting) return
    setResetting(true)
    setResetError('')
    try {
      await onResetRepoList()
      setConfirmingReset(false)
    } catch (err) {
      setResetError(readableIpcError(err))
    } finally {
      setResetting(false)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-section">
        <span className="nav-brand">MAO</span>
      </div>

      <div className="sidebar-section flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="sidebar-heading">Projects</span>
          <button
            onClick={() => {
              setAdding((v) => !v)
              setAddError('')
              setAddNotice('')
            }}
            className="btn btn-ghost px-1 text-xs"
          >
            + Add
          </button>
        </div>

        {showQueueCard && (
          <div className="card mb-2 gap-1.5 p-2">
            <p className="card-title text-[13px]">
              {queueRecovery.required || persistenceBroken
                ? 'Workflow automation is halted'
                : 'The stored workflow queue is unreadable'}
            </p>
            {/* A field-only boot problem uses the latched reason verbatim. A whole-file problem found
                while already latched must use the CURRENT report instead: recovery cannot verify a write
                in that state. After a clean boot, field-only and whole-file failures differ again — the
                former can be healed from the live queue, while the latter pauses polling/new mutations
                and refuses every write. The branches below state those distinct consequences. */}
            {persistenceBroken ? (
              <>
                <p className="text-muted text-[11px] leading-snug">{queueRecovery.reason}</p>
                {queueStoredProblem ? (
                  <p className="text-muted text-[11px] leading-snug">
                    {queueStoredProblem.wholeFile
                      ? `MAO also cannot read ${queueStoredProblem.source} at all, so every stored setting is affected. `
                      : `MAO also cannot use the stored workflow queue in ${queueStoredProblem.source}. `}
                    This is independent of the persistence marker. Repair and inspect the stored data as
                    part of reconciliation before clearing the marker; queue recovery writes remain
                    unavailable while the durable result is uncertain.
                  </p>
                ) : null}
              </>
            ) : queueRecovery.required ? (
              restartOnlyQueueRecovery ? (
                <p className="text-muted text-[11px] leading-snug">
                  {wholeFileQueueProblem ? `${queueStoredProblem.message} ` : ''}
                  This process observed a whole-file read failure, so workflow automation remains halted
                  even if the file is readable now. Its startup snapshot cannot safely write over a
                  repair. Repair the file if needed, then restart MAO to load the complete stored state.
                </p>
              ) : (
                <p className="text-muted text-[11px] leading-snug">{queueRecovery.reason}</p>
              )
            ) : (
              /* Deliberately NOT the field report. Its halted/empty claims are false after a clean boot.
                 The whole-file branch may truthfully say writes are refused, but still needs live-session
                 wording rather than the boot-latch report. */
              /* Two different late states, and conflating them was the defect. A wrong-shaped FIELD in a
                 file that loaded really is healed by this session's next queue write, so offering to save
                 now is the right affordance. A file that did not load at all establishes nothing and
                 REFUSES every write (issue #67), so for it the promise below would be false and the
                 button could only ever answer 'restart-required' — `resaveStoredQueue` fails closed on an
                 unreadable observation. The flag comes from core; no UI parses the report text. */
              queueStoredProblem?.wholeFile ? (
                <p className="text-muted text-[11px] leading-snug">
                  MAO could not read {queueStoredProblem.source} at all, so it established neither the
                  stored workflow queue nor any other setting. Repository polling and new queue mutations
                  are paused, every write is refused, and any running workflow will stop when it next tries
                  to persist. The file still holds everything it held. Repair the file, then restart MAO.
                </p>
              ) : (
                <>
                  <p className="text-muted text-[11px] leading-snug">
                    MAO cannot read the stored workflow queue in {queueStoredProblem?.source}. This session
                    is not halted — it is still holding the queue it loaded at startup, and its next queue
                    write will rewrite the file from that. Restarting before that happens will refuse to
                    start unattended work until the value is replaced.
                  </p>
                  {/* Deliberately NOT `mao workflow confirm-queue-recovery` here. That command discards
                      anything its separate process cannot validate and writes ITS startup snapshot over
                      the file — so this session's real queue could be lost when it next restarts. Saving
                      from this session writes the queue it is actually holding. */}
                  <button
                    onClick={submitResave}
                    className="btn btn-secondary self-start text-xs"
                    disabled={resaving}
                  >
                    {resaving ? 'Saving…' : 'Save this session’s queue now'}
                  </button>
                </>
              )
            )}
            {persistenceBroken ? (
              <>
                <p className="text-muted text-[11px] leading-snug">
                  Queue recovery and live-session Save are unavailable while the durable result is
                  uncertain. Check the stored queue and target repositories before clearing the marker.
                </p>
                {persistenceMarkerCleared ? (
                  <p className="text-[11px] leading-snug" style={{ color: 'var(--color-accent-700)' }}>
                    The marker is cleared. This process remains halted; restart MAO to load the verified
                    queue.
                  </p>
                ) : confirmingPersistenceClear ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-muted text-[11px] leading-snug">
                      Confirm only after comparing the stored queue with the target repositories and
                      resolving any half-finished issue, branch or pull request. Wait for any active stage
                      in this process to stop. Clearing the marker does not change this running process;
                      restart is required before automation can resume.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={submitPersistenceClear}
                        className="btn btn-primary text-xs"
                        disabled={clearingPersistence}
                      >
                        {clearingPersistence ? 'Clearing…' : 'Confirm marker clear'}
                      </button>
                      <button
                        onClick={() => {
                          setConfirmingPersistenceClear(false)
                          setQueueError('')
                        }}
                        className="btn btn-secondary text-xs"
                        disabled={clearingPersistence}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingPersistenceClear(true)}
                    className="btn btn-secondary self-start text-xs"
                  >
                    Clear marker after verification
                  </button>
                )}
              </>
            ) : restartOnlyQueueRecovery ? (
              <p className="text-muted text-[11px] leading-snug">
                If a workflow was already running, verify its queue and GitHub state after restart. If
                MAO reports an unresolved persistence outcome, use the marker recovery shown here only
                after that check.
              </p>
            ) : null}
            {queueRecovery.required &&
            queueStoredStillUnreadable &&
            !restartOnlyQueueRecovery &&
            !persistenceBroken ? (
              confirmingRecovery ? (
                <div className="flex flex-col gap-2">
                  <p className="text-muted text-[11px] leading-snug">
                    Recovery permanently deletes invalid queue entries and retains every readable task.
                    Tasks stored as running are restored as pending. After automation is released, later
                    queue activity — including an auto-trigger poll that enqueues work — may execute those
                    retained tasks.
                  </p>
                  <p className="text-muted text-[11px] leading-snug">
                    Before continuing, check the target repositories for workflow-active issues and
                    half-finished branches or pull requests so recovery does not repeat GitHub work.
                  </p>
                  <div className="flex gap-2">
                    <button onClick={submitRecovery} className="btn btn-primary text-xs" disabled={recovering}>
                      {recovering ? 'Recovering…' : 'Confirm recovery'}
                    </button>
                    {/* Disabled mid-write rather than hidden, like the repo-list reset: the write is
                        already queued and a Cancel that appeared to work would say otherwise. */}
                    <button
                      onClick={() => {
                        setConfirmingRecovery(false)
                        setQueueError('')
                      }}
                      className="btn btn-secondary text-xs"
                      disabled={recovering}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingRecovery(true)}
                  className="btn btn-secondary self-start text-xs"
                >
                  Recover readable tasks
                </button>
              )
            ) : queueRecovery.required && !restartOnlyQueueRecovery && !persistenceBroken ? (
              /* Something outside this window already repaired the file. Offering recovery here
                 would overwrite that repair with this process's filtered, restart-normalized subset,
                 so the way out is a restart — only a fresh boot can load the complete repaired queue. */
              <p className="text-muted text-[11px] leading-snug">
                The stored queue reads normally again. Restart MAO to load it — this session is still
                halted because its in-memory queue may be incomplete.
              </p>
            ) : null}
          </div>
        )}

        {/* The result of a queue action lives OUTSIDE the card above, and that placement is the fix for a
            bug rather than a layout preference. These messages are about an action that has finished,
            while the card is about a condition that currently holds — and the two most important
            messages say the condition is *gone*. `already-readable` means the fresh observation found the
            file repaired, so the refresh that follows removes the problem, the card unmounts, and an error
            rendered inside it vanished with the thing it was reporting on. The operator saw a click that
            did nothing. Dismissed explicitly so it cannot be missed either. */}
        {queueError && (
          <div className="card mb-2 gap-1.5 p-2">
            <p className="card-title text-[13px]">Workflow queue</p>
            <p className="text-xs" style={{ color: 'var(--color-accent-700)' }}>
              {queueError}
            </p>
            <button onClick={() => setQueueError('')} className="btn btn-secondary self-start text-xs">
              Dismiss
            </button>
          </div>
        )}

        {otherProblems.length > 0 && (
          <div className="card mb-2 gap-1.5 p-2">
            <p className="card-title text-[13px]">Stored settings could not be read</p>
            {otherProblems.map((problem) => (
              <p key={problem.field} className="text-muted text-[11px] leading-snug">
                {problem.message}
              </p>
            ))}
            {repoListUnusable &&
              (confirmingReset ? (
                <div className="flex gap-2">
                  <button onClick={submitReset} className="btn btn-primary text-xs" disabled={resetting}>
                    {resetting ? 'Resetting…' : 'Confirm reset'}
                  </button>
                  {/* Disabled mid-write rather than hidden: the write is already queued and cannot be
                      called back, and a Cancel that appears to work would say otherwise. */}
                  <button
                    onClick={() => {
                      setConfirmingReset(false)
                      setResetError('')
                    }}
                    className="btn btn-secondary text-xs"
                    disabled={resetting}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmingReset(true)} className="btn btn-secondary self-start text-xs">
                  Reset stored list
                </button>
              ))}
            {resetError && (
              <p className="text-xs" style={{ color: 'var(--color-accent-700)' }}>
                {resetError}
              </p>
            )}
          </div>
        )}

        {adding && (
          <div className="card mb-2 gap-1.5 p-2">
            <input
              className="input"
              placeholder="owner"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
              autoFocus
            />
            <input
              className="input"
              placeholder="repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
            />
            <button onClick={submitAdd} className="btn btn-primary text-xs" disabled={checking}>
              {checking ? 'Checking access…' : 'Add'}
            </button>
            {addError && (
              <p className="text-xs" style={{ color: 'var(--color-accent-700)' }}>
                {addError}
              </p>
            )}
          </div>
        )}

        <nav className="flex flex-col gap-0.5">
          {repos.map((r, i) => (
            <button
              key={`${r.owner}/${r.repo}`}
              onClick={() => onSelect(i)}
              className={`sidebar-item ${view === 'project' && selectedIndex === i ? 'active' : ''}`}
            >
              <span className="truncate">
                {r.owner}/{r.repo}
              </span>
              {r.autoTrigger === false && <span className="text-[10px] opacity-70">off</span>}
            </button>
          ))}
          {repos.length === 0 && !adding && !repoListUnusable && (
            <p className="text-muted text-xs px-2">No projects yet — add a repository to get started.</p>
          )}
        </nav>

        {addNotice && (
          <p className="text-muted mt-2 px-2 text-[11px] leading-snug">{addNotice}</p>
        )}
      </div>

      <div className="sidebar-section border-t-2" style={{ borderColor: 'var(--color-divider)' }}>
        <button
          onClick={() => onViewChange('global-settings')}
          className={`sidebar-item ${view === 'global-settings' ? 'active' : ''}`}
        >
          <span>Global settings</span>
        </button>
      </div>
    </aside>
  )
}
