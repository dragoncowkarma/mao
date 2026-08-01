import { useState } from 'react'
import SettingsPanel from './components/SettingsPanel'
import KanbanBoard from './components/KanbanBoard'
import WorkflowQueue from './components/WorkflowQueue'

export default function App() {
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')

  return (
    <div className="min-h-screen w-screen bg-slate-900 p-6 text-slate-100">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">MAO</h1>
        <p className="text-sm text-slate-400">AI-driven GitHub workflow toolkit</p>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6">
        <SettingsPanel owner={owner} repo={repo} onRepoChange={(o, r) => { setOwner(o); setRepo(r) }} />
        <KanbanBoard owner={owner} repo={repo} />
        <WorkflowQueue />
      </main>
    </div>
  )
}
