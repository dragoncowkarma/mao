import { useState } from 'react'
import SettingsPanel from './components/SettingsPanel'
import KanbanBoard from './components/KanbanBoard'
import WorkflowQueue from './components/WorkflowQueue'
import type { RepoRef } from '../electron/workflow-engine'

export default function App() {
  const [repos, setRepos] = useState<RepoRef[]>([])

  return (
    <div className="min-h-screen w-screen bg-slate-900 p-6 text-slate-100">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">MAO</h1>
        <p className="text-sm text-slate-400">AI-driven GitHub workflow toolkit</p>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6">
        <SettingsPanel repos={repos} onReposChange={setRepos} />
        <KanbanBoard repos={repos} />
        <WorkflowQueue repos={repos} />
      </main>
    </div>
  )
}
