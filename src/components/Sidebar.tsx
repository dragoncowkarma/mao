import { useState } from 'react'
import type { QueueRecoveryState, RepoRef } from '../../core/workflow-engine'
import type { RepoWorkflowCapability } from '../../core/repo-capabilities'
import type { StoredValueProblem } from '../../core/store'
import { LANGUAGE_PREFERENCES, type LanguagePreference } from '../../core/ui-language'
import { LANGUAGE_NAMES, WordedError, uiLanguageFor, wordIn, type Messages, type Wording } from '../i18n'

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

/** A queue action's failure as the card keeps it: App's own outcomes stay re-wordable. */
function queueFailure(err: unknown): Wording {
  return err instanceof WordedError ? err.wording : readableIpcError(err)
}

/**
 * The three pipeline grants GitHub cannot confirm without a write. Shown after a successful add so the
 * GUI says exactly what `mao repos add` says — a passing preflight is not proof of write access.
 */
function unverifiedNotice(checked: RepoWorkflowCapability[], messages: Messages): string {
  const pending = checked.filter((capability) => capability.unverified.length > 0)
  if (pending.length === 0) return ''
  return messages.sidebar.addRepo.addedUnverified(pending.map((c) => `${c.owner}/${c.repo}`).join(', '))
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
  /** Every string this sidebar shows, in the language the operator picked. */
  messages: Messages
  /** The stored language preference, for the menu's picker. */
  language: LanguagePreference
  onLanguageChange: (language: LanguagePreference) => void
  /** Why the newest language change could not be saved, as the IPC rejection worded it; '' otherwise. */
  languageError: string
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
  messages,
  language,
  onLanguageChange,
  languageError,
}: SidebarProps) {
  const [adding, setAdding] = useState(false)
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [checking, setChecking] = useState(false)
  const [addError, setAddError] = useState('')
  /**
   * The last add's verdicts, not its notice: the caveat is worded at render, so switching the language
   * while it is on screen re-words it rather than leaving it in the language of the click.
   */
  const [addVerdicts, setAddVerdicts] = useState<RepoWorkflowCapability[]>([])
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState('')
  const [confirmingRecovery, setConfirmingRecovery] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [resaving, setResaving] = useState(false)
  const [confirmingPersistenceClear, setConfirmingPersistenceClear] = useState(false)
  const [clearingPersistence, setClearingPersistence] = useState(false)
  const [persistenceMarkerCleared, setPersistenceMarkerCleared] = useState(false)
  /**
   * The finished queue action's result. A `Wording`, because App words its own outcomes from the catalog
   * (as `WordedError`s) and the card has to follow a language change; IPC and core text stays a string.
   */
  const [queueError, setQueueError] = useState<Wording>('')
  const addNotice = unverifiedNotice(addVerdicts, messages)

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
      setQueueError(queueFailure(err))
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
      setQueueError(queueFailure(err))
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
      setQueueError(queueFailure(err))
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
    setAddVerdicts([])
    try {
      const checked = await onAddRepo({ owner: trimmedOwner, repo: trimmedRepo })
      setOwner('')
      setRepo('')
      setAdding(false)
      setAddVerdicts(checked)
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
        <span className="nav-brand">{messages.sidebar.brand}</span>
      </div>

      <div className="sidebar-section flex-1">
        <div className="flex items-center justify-between mb-1">
          <span className="sidebar-heading">{messages.sidebar.projects}</span>
          <button
            onClick={() => {
              setAdding((v) => !v)
              setAddError('')
              setAddVerdicts([])
            }}
            className="btn btn-ghost px-1 text-xs"
          >
            {messages.sidebar.addRepo.toggle}
          </button>
        </div>

        {showQueueCard && (
          <div className="card mb-2 gap-1.5 p-2">
            <p className="card-title text-[13px]">
              {queueRecovery.required || persistenceBroken
                ? messages.sidebar.queue.haltedTitle
                : messages.sidebar.queue.unreadableTitle}
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
                      ? messages.sidebar.marker.alsoUnreadableFile(queueStoredProblem.source)
                      : messages.sidebar.marker.alsoUnusableQueue(queueStoredProblem.source)}{' '}
                    {messages.sidebar.marker.storedDataIndependent}
                  </p>
                ) : null}
              </>
            ) : queueRecovery.required ? (
              restartOnlyQueueRecovery ? (
                <p className="text-muted text-[11px] leading-snug">
                  {wholeFileQueueProblem ? `${queueStoredProblem.message} ` : ''}
                  {messages.sidebar.queue.restartOnly}
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
                  {messages.sidebar.queue.lateWholeFile(queueStoredProblem.source)}
                </p>
              ) : (
                <>
                  <p className="text-muted text-[11px] leading-snug">
                    {messages.sidebar.queue.lateFieldOnly(queueStoredProblem?.source ?? '')}
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
                    {resaving ? messages.sidebar.queue.saving : messages.sidebar.queue.saveSessionQueue}
                  </button>
                </>
              )
            )}
            {persistenceBroken ? (
              <>
                <p className="text-muted text-[11px] leading-snug">
                  {messages.sidebar.marker.unavailable}
                </p>
                {persistenceMarkerCleared ? (
                  <p className="text-[11px] leading-snug" style={{ color: 'var(--color-accent-700)' }}>
                    {messages.sidebar.marker.cleared}
                  </p>
                ) : confirmingPersistenceClear ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-muted text-[11px] leading-snug">
                      {messages.sidebar.marker.clearConfirmation}
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={submitPersistenceClear}
                        className="btn btn-primary text-xs"
                        disabled={clearingPersistence}
                      >
                        {clearingPersistence
                          ? messages.sidebar.marker.clearing
                          : messages.sidebar.marker.confirmClear}
                      </button>
                      <button
                        onClick={() => {
                          setConfirmingPersistenceClear(false)
                          setQueueError('')
                        }}
                        className="btn btn-secondary text-xs"
                        disabled={clearingPersistence}
                      >
                        {messages.common.cancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingPersistenceClear(true)}
                    className="btn btn-secondary self-start text-xs"
                  >
                    {messages.sidebar.marker.clearAfterVerification}
                  </button>
                )}
              </>
            ) : restartOnlyQueueRecovery ? (
              <p className="text-muted text-[11px] leading-snug">
                {messages.sidebar.queue.restartFollowUp}
              </p>
            ) : null}
            {queueRecovery.required &&
            queueStoredStillUnreadable &&
            !restartOnlyQueueRecovery &&
            !persistenceBroken ? (
              confirmingRecovery ? (
                <div className="flex flex-col gap-2">
                  <p className="text-muted text-[11px] leading-snug">
                    {messages.sidebar.queue.recoveryConsequences}
                  </p>
                  <p className="text-muted text-[11px] leading-snug">
                    {messages.sidebar.queue.recoveryCheckFirst}
                  </p>
                  <div className="flex gap-2">
                    <button onClick={submitRecovery} className="btn btn-primary text-xs" disabled={recovering}>
                      {recovering
                        ? messages.sidebar.queue.recovering
                        : messages.sidebar.queue.confirmRecovery}
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
                      {messages.common.cancel}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingRecovery(true)}
                  className="btn btn-secondary self-start text-xs"
                >
                  {messages.sidebar.queue.recoverReadableTasks}
                </button>
              )
            ) : queueRecovery.required && !restartOnlyQueueRecovery && !persistenceBroken ? (
              /* Something outside this window already repaired the file. Offering recovery here
                 would overwrite that repair with this process's filtered, restart-normalized subset,
                 so the way out is a restart — only a fresh boot can load the complete repaired queue. */
              <p className="text-muted text-[11px] leading-snug">
                {messages.sidebar.queue.repairedElsewhere}
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
            <p className="card-title text-[13px]">{messages.sidebar.queueResult.title}</p>
            <p className="text-xs" style={{ color: 'var(--color-accent-700)' }}>
              {wordIn(queueError, messages)}
            </p>
            <button onClick={() => setQueueError('')} className="btn btn-secondary self-start text-xs">
              {messages.sidebar.queueResult.dismiss}
            </button>
          </div>
        )}

        {otherProblems.length > 0 && (
          <div className="card mb-2 gap-1.5 p-2">
            <p className="card-title text-[13px]">{messages.sidebar.storedProblems.title}</p>
            {otherProblems.map((problem) => (
              <p key={problem.field} className="text-muted text-[11px] leading-snug">
                {problem.message}
              </p>
            ))}
            {repoListUnusable &&
              (confirmingReset ? (
                <div className="flex gap-2">
                  <button onClick={submitReset} className="btn btn-primary text-xs" disabled={resetting}>
                    {resetting
                      ? messages.sidebar.storedProblems.resetting
                      : messages.sidebar.storedProblems.confirmReset}
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
                    {messages.common.cancel}
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmingReset(true)} className="btn btn-secondary self-start text-xs">
                  {messages.sidebar.storedProblems.resetList}
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
              placeholder={messages.sidebar.addRepo.ownerPlaceholder}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
              autoFocus
            />
            <input
              className="input"
              placeholder={messages.sidebar.addRepo.repoPlaceholder}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
            />
            <button onClick={submitAdd} className="btn btn-primary text-xs" disabled={checking}>
              {checking ? messages.sidebar.addRepo.checking : messages.sidebar.addRepo.submit}
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
              {r.autoTrigger === false && (
                <span className="text-[10px] opacity-70">{messages.sidebar.autoTriggerOff}</span>
              )}
            </button>
          ))}
          {repos.length === 0 && !adding && !repoListUnusable && (
            <p className="text-muted text-xs px-2">{messages.sidebar.noProjects}</p>
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
          <span>{messages.sidebar.globalSettings}</span>
        </button>
        {/* The language menu sits beside Global settings because it has to be reachable from every view
            — including by an operator who just picked a language they cannot read. Each option names
            its language in that language, so the way back never depends on the current one. */}
        <div className="flex items-center justify-between gap-2 p-2 text-sm">
          <label htmlFor="sidebar-language">{messages.language.label}</label>
          <select
            id="sidebar-language"
            className="input input-sm w-auto"
            value={language}
            onChange={(e) => onLanguageChange(e.target.value as LanguagePreference)}
          >
            {LANGUAGE_PREFERENCES.map((preference) => (
              // Each name is in its own language, and says so, so a screen reader voices it correctly.
              <option key={preference} value={preference} lang={preference === 'system' ? undefined : preference}>
                {preference === 'system'
                  ? messages.language.systemResolved(LANGUAGE_NAMES[uiLanguageFor('system')])
                  : LANGUAGE_NAMES[preference]}
              </option>
            ))}
          </select>
        </div>
        {languageError && (
          <p className="px-2 text-[11px] leading-snug" style={{ color: 'var(--color-accent-700)' }}>
            {messages.language.saveFailed(readableIpcError(languageError))}
          </p>
        )}
      </div>
    </aside>
  )
}
