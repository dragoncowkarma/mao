import { useState } from 'react'
import SettingsPanel from './components/SettingsPanel'
import KanbanBoard from './components/KanbanBoard'
import WorkflowQueue from './components/WorkflowQueue'
import type { RepoRef } from '../electron/workflow-engine'

export default function App() {
  const [repos, setRepos] = useState<RepoRef[]>([])

  return (
    <div className="min-h-screen w-screen">
      <header className="nav">
        <span className="nav-brand">MAO</span>
        <a href="#board">Board</a>
        <a href="#queue">Queue</a>
        <a href="#settings">Settings</a>
        <span className="text-muted ml-4 text-[13px]">AI-driven GitHub workflow toolkit</span>
      </header>

      <main className="mx-auto max-w-[1120px] px-6 py-8">
        <section id="board">
          <KanbanBoard repos={repos} />
        </section>

        <hr className="hr" />

        <section id="queue">
          <WorkflowQueue repos={repos} />
        </section>

        <hr className="hr" />

        <section id="settings">
          <SettingsPanel repos={repos} onReposChange={setRepos} />
        </section>
      </main>
    </div>
  )
}
