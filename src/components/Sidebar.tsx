import { useState } from 'react'
import type { RepoRef } from '../../core/workflow-engine'
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
   * Stored values the main process could not use, answered with a schema default instead.
   *
   * Shown here because this is where their absence is: an unusable `githubRepos` reaches the renderer
   * as `[]`, which is indistinguishable from having no repositories — and with no row to select, the
   * project's Settings tab and its Remove button never render, so the guard's own advice to use the
   * sidebar's Remove was not something the operator could actually do.
   */
  storeProblems: StoredValueProblem[]
  /** Discards the unusable stored value by writing an empty list. Rejects if even that write fails. */
  onResetRepoList: () => Promise<void>
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

  /**
   * Whether it is the *repository list* that is unusable, not merely something in the same file.
   *
   * The reset deletes `githubRepos` and nothing else, so offering it for any other field's report would
   * put a destructive button under a message that is not about repositories. Today the guard only checks
   * this one field, so the distinction is invisible — which is exactly why it is written down now rather
   * than discovered when a second field joins it (issue #68).
   */
  const repoListUnusable = storeProblems.some((problem) => problem.field === 'githubRepos')

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

        {storeProblems.length > 0 && (
          <div className="card mb-2 gap-1.5 p-2">
            <p className="card-title text-[13px]">Stored settings could not be read</p>
            {storeProblems.map((problem) => (
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
