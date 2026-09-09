import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import KanbanBoard from './components/KanbanBoard'
import WorkflowQueue from './components/WorkflowQueue'
import ProjectSettings from './components/ProjectSettings'
import GlobalSettings from './components/GlobalSettings'
import UpdateBanner from './components/UpdateBanner'
import type { RepoRef } from '../core/workflow-engine'
import type { RepoWorkflowCapability } from '../core/repo-capabilities'
import type { ThemePreference } from '../core/store'
import type { AppUpdateCheck } from './electron'

type ProjectTab = 'board' | 'queue' | 'settings'
type View = 'project' | 'global-settings'

export default function App() {
  const [repos, setRepos] = useState<RepoRef[]>([])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [view, setView] = useState<View>('project')
  const [projectTab, setProjectTab] = useState<ProjectTab>('board')
  const [theme, setThemeState] = useState<ThemePreference>('system')
  const [update, setUpdate] = useState<AppUpdateCheck | null>(null)
  const [dismissedUpdateSha, setDismissedUpdateSha] = useState<string | null>(null)
  /** Surfaces a failed settings edit or removal, which are otherwise silent (no preflight, no form). */
  const [repoError, setRepoError] = useState('')

  useEffect(() => {
    window.electronAPI.github.getRepos().then((savedRepos) => {
      setRepos(savedRepos)
      if (savedRepos.length > 0) setSelectedIndex(0)
    })
  }, [])

  useEffect(() => {
    window.electronAPI.ui.getTheme().then(setThemeState)
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
    await window.electronAPI.ui.setTheme(next)
  }

  useEffect(() => {
    let cancelled = false

    async function checkUpdate() {
      try {
        const result = await window.electronAPI.app.checkUpdate()
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
      await window.electronAPI.app.relaunch(update.runningTaskCount > 0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (window.confirm(`${message}. Restart anyway?`)) {
        await window.electronAPI.app.relaunch(true)
      }
    }
  }

  useEffect(() => {
    if (selectedIndex !== null && selectedIndex >= repos.length) {
      setSelectedIndex(repos.length > 0 ? 0 : null)
    }
  }, [repos, selectedIndex])

  /**
   * Mirrors into React state immediately and rolls back if the main process rejects.
   *
   * Adding a repository is preflighted in the main process (see core/repo-registry.ts), so setRepos
   * can now legitimately reject — but the update path cannot wait for that round trip: ProjectSettings
   * renders fully controlled inputs off this state, and deferring the mirror until after the IPC
   * makes React restore each keystroke to the last rendered value, so the poll-interval field reverts
   * as it is typed. Optimistic-plus-rollback keeps those inputs responsive while still leaving the
   * list exactly as it was whenever the store refuses the write.
   */
  async function persistRepos(next: RepoRef[]): Promise<RepoWorkflowCapability[]> {
    const previous = repos
    setRepos(next)
    try {
      return await window.electronAPI.github.setRepos(next)
    } catch (err) {
      setRepos(previous)
      throw err
    }
  }

  /**
   * Rejects when the repo fails the write-permission preflight; Sidebar renders the message. Resolves
   * with the verdicts so Sidebar can show the caveat for grants the preflight could not prove.
   */
  async function addRepo(repo: RepoRef): Promise<RepoWorkflowCapability[]> {
    const exists = repos.some((r) => r.owner === repo.owner && r.repo === repo.repo)
    if (exists) return []
    const next = [...repos, repo]
    const checked = await persistRepos(next)
    setSelectedIndex(next.length - 1)
    setView('project')
    setProjectTab('board')
    return checked
  }

  // Settings edits and removals skip the preflight by design, but the store write can still fail —
  // and an inert checkbox with an unhandled rejection in the console tells the operator nothing.
  async function updateSelectedRepo(patch: Partial<RepoRef>) {
    if (selectedIndex === null) return
    const next = repos.map((r, i) => (i === selectedIndex ? { ...r, ...patch } : r))
    setRepoError('')
    try {
      await persistRepos(next)
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
    }
  }

  async function removeSelectedRepo() {
    if (selectedIndex === null) return
    const next = repos.filter((_, i) => i !== selectedIndex)
    setRepoError('')
    try {
      await persistRepos(next)
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
      return
    }
    setSelectedIndex(next.length > 0 ? 0 : null)
    setProjectTab('board')
  }

  function selectProject(index: number) {
    setSelectedIndex(index)
    setView('project')
    setProjectTab('board')
  }

  const selected = selectedIndex !== null ? repos[selectedIndex] : undefined

  return (
    <div className="min-h-screen w-screen flex">
      <Sidebar
        repos={repos}
        selectedIndex={selectedIndex}
        onSelect={selectProject}
        onAddRepo={addRepo}
        view={view}
        onViewChange={setView}
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
                onClick={() => setProjectTab('board')}
              >
                Board
              </button>
              <button
                className={`tab ${projectTab === 'queue' ? 'active' : ''}`}
                onClick={() => setProjectTab('queue')}
              >
                Queue
              </button>
              <button
                className={`tab ${projectTab === 'settings' ? 'active' : ''}`}
                onClick={() => setProjectTab('settings')}
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
