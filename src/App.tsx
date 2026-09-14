import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import KanbanBoard from './components/KanbanBoard'
import WorkflowQueue from './components/WorkflowQueue'
import ProjectSettings from './components/ProjectSettings'
import GlobalSettings from './components/GlobalSettings'
import UpdateBanner from './components/UpdateBanner'
import { electronApi } from './electron-api'
import type { RepoRef } from '../core/workflow-engine'
import type { RepoWorkflowCapability } from '../core/repo-capabilities'
import { sameRepoRef } from '../core/repo-registry'
import type { ThemePreference } from '../core/store'
import type { AppUpdateCheck } from './electron'

type ProjectTab = 'board' | 'queue' | 'settings'
type View = 'project' | 'global-settings'

/**
 * Prefer the exact legacy row while it still exists, then follow its canonical repository identity
 * after a write folds case-variant duplicates into one entry.
 */
function selectedRepoIndex(repos: RepoRef[], selected: RepoRef): number {
  const exact = repos.findIndex((repo) => repo.owner === selected.owner && repo.repo === selected.repo)
  return exact === -1 ? repos.findIndex((repo) => sameRepoRef(repo, selected)) : exact
}

export default function App() {
  const [repos, setRepos] = useState<RepoRef[]>([])
  const [selectedRepo, setSelectedRepo] = useState<RepoRef | null>(null)
  const [view, setView] = useState<View>('project')
  const [projectTab, setProjectTab] = useState<ProjectTab>('board')
  const [theme, setThemeState] = useState<ThemePreference>('system')
  const [update, setUpdate] = useState<AppUpdateCheck | null>(null)
  const [dismissedUpdateSha, setDismissedUpdateSha] = useState<string | null>(null)
  /** Surfaces a failed settings edit or removal, which are otherwise silent (no preflight, no form). */
  const [repoError, setRepoError] = useState('')
  /**
   * Counts every navigation choice, so an async add can ask whether the operator moved elsewhere
   * while its permission preflight was running.
   *
   * A repo-list write can take seconds (an add's preflight is a network call and `updateRepos`
   * serializes everything behind it), so the completion must not drag the operator back from another
   * project, tab, or global settings. The selected repository itself is stored by identity below, but
   * identity cannot tell whether opening the newly added repository is still wanted. Never read this
   * counter during render.
   */
  const navigationGeneration = useRef(0)

  /** Store identity, not position: registration can fold duplicates and reorder the list. */
  function selectRepo(repo: RepoRef | null) {
    navigationGeneration.current += 1
    setSelectedRepo(repo)
  }

  function selectIndex(index: number | null, candidates = repos) {
    selectRepo(index === null ? null : candidates[index] ?? null)
  }

  function selectView(next: View) {
    navigationGeneration.current += 1
    setView(next)
  }

  function selectProjectTab(next: ProjectTab) {
    navigationGeneration.current += 1
    setProjectTab(next)
  }

  const matchingSelectedIndex = selectedRepo === null ? null : selectedRepoIndex(repos, selectedRepo)
  const selectedIndex = matchingSelectedIndex === -1 ? null : matchingSelectedIndex
  const selected = selectedIndex === null ? undefined : repos[selectedIndex]

  useEffect(() => {
    electronApi().github.getRepos().then((savedRepos) => {
      setRepos(savedRepos)
      if (savedRepos.length > 0) setSelectedRepo(savedRepos[0])
    })
  }, [])

  useEffect(() => {
    electronApi().ui.getTheme().then(setThemeState)
  }, [])

  // Applies the effective light/dark scheme to <html data-theme>, which src/index.css keys its dark
  // token overrides off of. 'system' has no fixed effective value, so it tracks the OS-level media
  // query live instead of resolving once — the app should flip immediately if the OS theme changes
  // while it's open, without requiring a restart or a settings round-trip.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    function applyEffectiveTheme() {
      const effective = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      if (effective === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark')
      } else {
        document.documentElement.removeAttribute('data-theme')
      }
    }

    applyEffectiveTheme()

    if (theme !== 'system') return
    media.addEventListener('change', applyEffectiveTheme)
    return () => media.removeEventListener('change', applyEffectiveTheme)
  }, [theme])

  async function setTheme(next: ThemePreference) {
    setThemeState(next)
    await electronApi().ui.setTheme(next)
  }

  useEffect(() => {
    let cancelled = false

    async function checkUpdate() {
      try {
        const result = await electronApi().app.checkUpdate()
        if (cancelled) return
        if (result.updateAvailable && result.latestSha !== dismissedUpdateSha) {
          setUpdate(result)
        } else if (!result.updateAvailable) {
          setUpdate(null)
        }
      } catch {
        // Missing token/offline/self-update lookup errors should not interrupt normal app use.
      }
    }

    checkUpdate()
    const interval = setInterval(checkUpdate, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [dismissedUpdateSha])

  async function restartForUpdate() {
    if (!update) return
    const force =
      update.runningTaskCount === 0 ||
      window.confirm(`${update.runningTaskCount} workflow task(s) are still running. Restart anyway?`)
    if (!force) return
    try {
      await electronApi().app.relaunch(update.runningTaskCount > 0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (window.confirm(`${message}. Restart anyway?`)) {
        await electronApi().app.relaunch(true)
      }
    }
  }

  useEffect(() => {
    if (repos.length === 0) {
      if (selectedRepo !== null) setSelectedRepo(null)
    } else if (selectedRepo === null || selectedIndex === null) {
      // This is reconciliation, not an operator navigation choice. In particular, the optimistic
      // first add reaches here while its preflight is still pending and must not invalidate its own
      // completion's intent to open the newly registered project.
      setSelectedRepo(repos[0])
    }
  }, [repos, selectedIndex, selectedRepo])

  /**
   * Mirrors into React state immediately, and on rejection re-reads the store rather than restoring a
   * snapshot.
   *
   * Optimistic on the success path because the update path cannot wait for the round trip:
   * ProjectSettings renders fully controlled inputs off this state, and deferring the mirror until
   * after the IPC makes React restore each keystroke to the last rendered value, so the poll-interval
   * field reverts as it is typed. (For the same reason the success path must NOT re-read either — a
   * round trip that lands mid-typing would stomp newer keystrokes with the value it persisted.)
   *
   * Rolling back to a captured `previous` is wrong, though: that snapshot is this render's optimistic
   * mirror, not the store, and `setRepos` writes the whole list, so several writes can be in flight at
   * once — an add's preflight is a multi-second network call during which the settings panel stays
   * live. Restoring a stale snapshot can then resurrect an entry the store refused, or erase one a
   * concurrent write just persisted, and since the renderer reads the list only once at mount that
   * divergence never heals. `github:getRepos` is a pure `store.get`, so asking it what actually
   * survived is both cheap and authoritative — and it is the re-fetch-after-mutation model AGENTS.md
   * prescribes for the renderer.
   */
  async function persistRepos(next: RepoRef[]): Promise<RepoWorkflowCapability[]> {
    const previous = repos
    setRepos(next)
    try {
      return await electronApi().github.setRepos(next)
    } catch (err) {
      // Fall back to the snapshot only if even the read fails; showing a stale list beats showing one
      // built from a write we know was refused.
      setRepos(await electronApi().github.getRepos().catch(() => previous))
      throw err
    }
  }

  /**
   * Rejects when the repo fails the write-permission preflight; Sidebar renders the message. Resolves
   * with the verdicts so Sidebar can show the caveat for grants the preflight could not prove.
   */
  async function addRepo(repo: RepoRef): Promise<RepoWorkflowCapability[]> {
    const startedAt = navigationGeneration.current
    // Decided against what the store actually holds, not this component's mirror, which is read once at
    // mount: a repo added by `mao repos add` in a terminal since then would be missing from it. That
    // matters twice over — core can only protect a tracked repo's settings from a bare Add-form
    // submission when the tracked entry is in the list being written, and an unseen repo would
    // otherwise make this look like a first registration.
    const current = await electronApi().github.getRepos().catch(() => repos)
    const existing = current.findIndex((r) => sameRepoRef(r, repo))
    if (existing !== -1) {
      // Already tracked — including under a different capitalisation, which is one repository to
      // GitHub and to core. Adopt the authoritative list and navigate rather than returning silently:
      // the repo may be one this component has never seen, and leaving the mirror stale would hide a
      // repository that really is being tracked and polled until the app restarts.
      setRepos(current)
      if (navigationGeneration.current === startedAt) {
        selectIndex(existing, current)
        setView('project')
        setProjectTab('board')
      }
      return []
    }
    const checked = await persistRepos([...current, repo])
    // Re-read instead of deriving the selection from the optimistic copy: the fold means the stored
    // list can be shorter than the one just sent, and selecting into a list the store does not have
    // would leave the sidebar showing a row that is not there. This is the re-fetch-after-mutation
    // model AGENTS.md prescribes for the renderer, and `github:getRepos` is a pure `store.get`, so it
    // resolves immediately after our own write — which `updateRepos` has already serialized, meaning
    // any settings write queued before this one has landed and is included.
    //
    // Not free of risk, unlike what persistRepos' success path avoids: a settings edit made *during*
    // the add's multi-second preflight is queued behind it, so this read can return the pre-edit value
    // and revert that field in the renderer. That window is narrow and needs a deliberate edit while
    // the form reads "Checking access…", whereas a phantom sidebar row is certain whenever the add is
    // folded — so it is the better trade, not a free one. Core keeps the last occurrence of a
    // repository, so the entry just registered (or the existing one it merged into) is last.
    const stored = await electronApi().github.getRepos().catch(() => [...current, repo])
    setRepos(stored)
    // Open the added repository only if the operator has not navigated elsewhere during the preflight.
    // Selection is written as identity, so later list folding cannot silently retarget it.
    if (navigationGeneration.current === startedAt) {
      const added = stored.findIndex((r) => sameRepoRef(r, repo))
      selectIndex(added === -1 ? (stored.length > 0 ? stored.length - 1 : null) : added, stored)
      setView('project')
      setProjectTab('board')
    }
    return checked
  }

  // Settings edits and removals skip the preflight by design, but the store write can still fail —
  // and an inert checkbox with an unhandled rejection in the console tells the operator nothing.
  async function updateSelectedRepo(patch: Partial<RepoRef>) {
    if (selectedIndex === null) return
    const target = repos[selectedIndex]
    if (!target) return
    const next = repos.map((r, i) => (i === selectedIndex ? { ...r, ...patch } : r))
    setRepoError('')
    try {
      await persistRepos(next)
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
      return
    }
    // A settings edit leaves the list's shape alone, and re-reading after every one would let a slow
    // round trip stomp a newer keystroke — the reason persistRepos' success path does not (see there).
    // The exception is a store still holding a pre-fix duplicate: this write collapses it, so the row
    // count drops. Without adopting that, the mirror keeps a row the store no longer has and keeps
    // re-sending it, so an edit that lost the duplicate tie-break could never be re-applied. Adopting
    // only the structural change heals the list without touching any value being typed.
    const stored = await electronApi().github.getRepos().catch(() => next)
    if (stored.length !== next.length) {
      setRepos(stored)
      // `selectedRepo` remains the authoritative identity. Whether it is this edit's target or a
      // project selected while the write was pending, deriving the index from `stored` preserves it
      // across the fold instead of letting the old numeric position silently name another project.
    }
  }

  async function removeSelectedRepo() {
    if (selectedIndex === null) return
    const target = repos[selectedIndex]
    if (!target) return
    // Every row naming this repository, not just the selected index. A store written before repository
    // identity was case-insensitive can hold it twice, and dropping one row hands core a list that
    // still names it: "Remove" would leave the repo tracked, and the surviving row's settings would
    // take over — re-enabling unattended polling the operator had switched off, on the repository they
    // just tried to delete. `mao repos remove` already deletes by identity; the GUI has to agree.
    const next = repos.filter((r) => !sameRepoRef(r, target))
    setRepoError('')
    // The selected identity is being removed. Pick the deterministic fallback before the await so a
    // later user navigation always wins over this operation's completion.
    selectIndex(next.length > 0 ? 0 : null, next)
    setProjectTab('board')
    const fallbackGeneration = navigationGeneration.current
    try {
      await persistRepos(next)
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
      // If nothing else was selected while the write was pending, return to the repository whose
      // removal failed so the settings error is visible. A concurrent external removal is harmless:
      // the identity-fallback effect will choose an entry that still exists.
      if (navigationGeneration.current === fallbackGeneration) {
        selectRepo(target)
        setView('project')
        setProjectTab('settings')
      }
      return
    }
    // Re-read for the same reason as addRepo, and with the same safety: a list that still held a
    // duplicate written by an earlier build comes back one entry shorter once core folds it away, and
    // this path navigates to the board rather than leaving an input mid-edit.
    const stored = await electronApi().github.getRepos().catch(() => next)
    setRepos(stored)
  }

  function selectProject(index: number) {
    selectIndex(index, repos)
    setView('project')
    setProjectTab('board')
  }

  return (
    <div className="min-h-screen w-screen flex">
      <Sidebar
        repos={repos}
        selectedIndex={selectedIndex}
        onSelect={selectProject}
        onAddRepo={addRepo}
        view={view}
        onViewChange={selectView}
      />

      <main className="flex-1 mx-auto w-full max-w-[1120px] px-6 py-8">
        {update && (
          <UpdateBanner
            update={update}
            onRestart={restartForUpdate}
            onDismiss={() => {
              setDismissedUpdateSha(update.latestSha)
              setUpdate(null)
            }}
          />
        )}

        {view === 'global-settings' ? (
          <GlobalSettings theme={theme} onThemeChange={setTheme} />
        ) : !selected ? (
          <div>
            <h2>Welcome to MAO</h2>
            <p className="text-muted mt-2 text-sm">
              Add a repository from the sidebar to see its issues and pull requests here.
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 className="!mb-0">
                {selected.owner}/{selected.repo}
              </h2>
            </div>

            {repoError && (
              <p className="mb-3 text-xs" style={{ color: 'var(--color-accent-700)' }}>
                {repoError}
              </p>
            )}

            <div className="tabs">
              <button
                className={`tab ${projectTab === 'board' ? 'active' : ''}`}
                onClick={() => selectProjectTab('board')}
              >
                Board
              </button>
              <button
                className={`tab ${projectTab === 'queue' ? 'active' : ''}`}
                onClick={() => selectProjectTab('queue')}
              >
                Queue
              </button>
              <button
                className={`tab ${projectTab === 'settings' ? 'active' : ''}`}
                onClick={() => selectProjectTab('settings')}
              >
                Settings
              </button>
            </div>

            {projectTab === 'board' && <KanbanBoard repo={selected} />}
            {projectTab === 'queue' && <WorkflowQueue repo={selected} />}
            {projectTab === 'settings' && (
              <ProjectSettings repo={selected} onChange={updateSelectedRepo} onRemove={removeSelectedRepo} />
            )}
          </div>
        )}
      </main>
    </div>
  )
}
