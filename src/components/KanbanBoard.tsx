import { useEffect, useState } from 'react'
import type { GithubTask } from '../../electron/github-service'
import type { RepoRef } from '../../electron/workflow-engine'

interface KanbanBoardProps {
  repos: RepoRef[]
}

function sortTasks(tasks: GithubTask[]): GithubTask[] {
  return [...tasks].sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

function Column({ title, tasks }: { title: string; tasks: GithubTask[] }) {
  return (
    <div>
      <h4 className="mb-2">
        {title} <span className="text-muted">({tasks.length})</span>
      </h4>
      <div className="flex flex-col gap-2">
        {tasks.map((task) => (
          <a
            key={task.id}
            href={task.url}
            target="_blank"
            rel="noreferrer"
            className="card elev-sm no-underline text-inherit"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="card-kicker">#{task.number}</span>
              <div className="flex gap-1.5">
                {task.labels.includes('workflow-active') && <span className="tag tag-outline">in workflow</span>}
                {task.urgent && <span className="tag tag-accent">urgent</span>}
              </div>
            </div>
            <p className="card-title text-[15px]">{task.title}</p>
            <p className="card-meta">{new Date(task.updatedAt).toLocaleString()}</p>
          </a>
        ))}
        {tasks.length === 0 && <p className="text-muted text-sm">No items</p>}
      </div>
    </div>
  )
}

export default function KanbanBoard({ repos }: KanbanBoardProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [tasks, setTasks] = useState<GithubTask[]>([])
  const [error, setError] = useState('')

  const selected = repos[selectedIndex]

  useEffect(() => {
    if (selectedIndex >= repos.length) setSelectedIndex(0)
  }, [repos, selectedIndex])

  useEffect(() => {
    if (!selected) return

    let cancelled = false
    async function load() {
      try {
        const result = await window.electronAPI.github.fetchTasks(selected.owner, selected.repo)
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
  }, [selected?.owner, selected?.repo])

  const sorted = sortTasks(tasks)
  const issues = sorted.filter((t) => t.type === 'issue')
  const pullRequests = sorted.filter((t) => t.type === 'pull_request')

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2>Board</h2>
        {repos.length > 0 && (
          <select
            className="input max-w-[260px]"
            value={selectedIndex}
            onChange={(e) => setSelectedIndex(Number(e.target.value))}
          >
            {repos.map((r, i) => (
              <option key={i} value={i}>
                {r.owner}/{r.repo}
              </option>
            ))}
          </select>
        )}
      </div>

      {repos.length === 0 ? (
        <p className="text-muted mt-4 text-sm">Add a repository in Settings to load the board.</p>
      ) : (
        <>
          {error && <p className="mt-2 text-xs text-[var(--color-accent)]">{error}</p>}
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <Column title="Issues" tasks={issues} />
            <Column title="Pull Requests" tasks={pullRequests} />
          </div>
        </>
      )}
    </div>
  )
}
