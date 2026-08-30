import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import KanbanBoard from './components/KanbanBoard'
import WorkflowQueue from './components/WorkflowQueue'
import ProjectSettings from './components/ProjectSettings'
import GlobalSettings from './components/GlobalSettings'
import UpdateBanner from './components/UpdateBanner'
import type { RepoRef } from '../core/workflow-engine'
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

  async function persistRepos(next: RepoRef[]) {
    setRepos(next)
    await window.electronAPI.github.setRepos(next)
  }

  async function addRepo(repo: RepoRef) {
    const exists = repos.some((r) => r.owner === repo.owner && r.repo === repo.repo)
    if (exists) return
    const next = [...repos, repo]
    await persistRepos(next)
    setSelectedIndex(next.length - 1)
    setView('project')
    setProjectTab('board')
  }

  async function updateSelectedRepo(patch: Partial<RepoRef>) {
    if (selectedIndex === null) return
    const next = repos.map((r, i) => (i === selectedIndex ? { ...r, ...patch } : r))
    await persistRepos(next)
  }

  async function removeSelectedRepo() {
    if (selectedIndex === null) return
    const next = repos.filter((_, i) => i !== selectedIndex)
    await persistRepos(next)
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
