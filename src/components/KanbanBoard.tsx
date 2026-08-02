import { useEffect, useState } from 'react'
import type { GithubTask } from '../../electron/github-service'
import type { RepoRef } from '../../electron/workflow-engine'

interface KanbanBoardProps {
  repo: RepoRef
}

function sortTasks(tasks: GithubTask[]): GithubTask[] {
  return [...tasks].sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `${hours}h ago`
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

export default function KanbanBoard({ repo }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<GithubTask[]>([])
  const [error, setError] = useState('')
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [, forceTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const result = await window.electronAPI.github.fetchTasks(repo.owner, repo.repo)
        if (!cancelled) {
          setTasks(result)
          setError('')
          setLastSyncedAt(Date.now())
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
  }, [repo.owner, repo.repo])

  // Re-render every 10s so the "synced Xs ago" label stays fresh without a full refetch.
  useEffect(() => {
    const interval = setInterval(() => forceTick((n) => n + 1), 10_000)
    return () => clearInterval(interval)
  }, [])

  async function refreshNow() {
    setRefreshing(true)
    try {
      const result = await window.electronAPI.github.refreshRepo(repo.owner, repo.repo)
      setTasks(result)
      setError('')
      setLastSyncedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  const sorted = sortTasks(tasks)
  const issues = sorted.filter((t) => t.type === 'issue')
  const pullRequests = sorted.filter((t) => t.type === 'pull_request')

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2>Board</h2>
        <div className="flex items-center gap-3">
          {lastSyncedAt && (
            <span className="text-muted flex items-center gap-1.5 text-xs">
              <span className="live-dot" /> synced {timeAgo(lastSyncedAt)}
            </span>
          )}
          <button onClick={refreshNow} disabled={refreshing} className="btn btn-secondary">
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="mt-2 text-xs" style={{ color: 'var(--color-accent-700)' }}>{error}</p>}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Column title="Issues" tasks={issues} />
        <Column title="Pull Requests" tasks={pullRequests} />
      </div>
    </div>
  )
}
