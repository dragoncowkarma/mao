import { useEffect, useState } from 'react'
import type { GithubTask } from '../../electron/github-service'

interface KanbanBoardProps {
  owner: string
  repo: string
}

function sortTasks(tasks: GithubTask[]): GithubTask[] {
  return [...tasks].sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

function Column({ title, tasks }: { title: string; tasks: GithubTask[] }) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-200">
        {title} <span className="text-slate-500">({tasks.length})</span>
      </h3>
      <div className="space-y-2">
        {tasks.map((task) => (
          <a
            key={task.id}
            href={task.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded bg-slate-900 p-2 text-xs hover:bg-slate-700"
          >
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-slate-100">#{task.number}</span>
              <span className="flex gap-1">
                {task.labels.includes('workflow-active') && (
                  <span className="rounded bg-indigo-900/60 px-1.5 py-0.5 text-[10px] text-indigo-200">
                    in workflow
                  </span>
                )}
                {task.urgent && (
                  <span className="rounded bg-red-900/60 px-1.5 py-0.5 text-[10px] text-red-200">urgent</span>
                )}
              </span>
            </div>
            <p className="mt-1 truncate text-slate-300">{task.title}</p>
            <p className="mt-1 text-slate-500">{new Date(task.updatedAt).toLocaleString()}</p>
          </a>
        ))}
        {tasks.length === 0 && <p className="text-xs text-slate-500">No items</p>}
      </div>
    </div>
  )
}

export default function KanbanBoard({ owner, repo }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<GithubTask[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!owner || !repo) return

    let cancelled = false
    async function load() {
      try {
        const result = await window.electronAPI.github.fetchTasks(owner, repo)
        if (!cancelled) {
          setTasks(result)
          setError('')
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }

    load()
    const interval = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [owner, repo])

  if (!owner || !repo) {
    return <p className="text-sm text-slate-500">Set a GitHub owner/repo in Settings to load the board.</p>
  }

  const sorted = sortTasks(tasks)
  const issues = sorted.filter((t) => t.type === 'issue')
  const pullRequests = sorted.filter((t) => t.type === 'pull_request')

  return (
    <div>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      <div className="flex gap-3">
        <Column title="Issues" tasks={issues} />
        <Column title="Pull Requests" tasks={pullRequests} />
      </div>
    </div>
  )
}
