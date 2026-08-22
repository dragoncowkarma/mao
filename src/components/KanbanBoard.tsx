import { useEffect, useState } from 'react'
import type { GithubTask } from '../../core/github-service'
import type { QueuedTask, RepoRef } from '../../core/workflow-engine'
import TaskDetailModal from './TaskDetailModal'

interface KanbanBoardProps {
  repo: RepoRef
}

const STAGE_LABELS: Record<QueuedTask['stage'], string> = {
  issue: 'Issue',
  pr: 'PR',
  review: 'Review',
  merge: 'Merge',
}

/** Finds the workflow task (if any) driving this GitHub issue/PR, so the card can show live pipeline state. */
function findWorkflowTask(task: GithubTask, workflowTasks: QueuedTask[]): QueuedTask | undefined {
  return workflowTasks.find(
    (t) => t.github.issueNumber === task.number || t.github.prNumber === task.number,
  )
}

function workflowBadgeClass(task: QueuedTask): string {
  if (task.status === 'error') return 'tag-accent'
  if (task.status === 'running') return 'tag-outline'
  return 'tag-neutral'
}

function workflowBadgeLabel(task: QueuedTask): string {
  if (task.status === 'error') return `${STAGE_LABELS[task.stage]} failed`
  if (task.status === 'running') return `${STAGE_LABELS[task.stage]} running`
  if (task.status === 'paused') return `${STAGE_LABELS[task.stage]} paused`
  if (task.status === 'done') return 'workflow done'
  return `${STAGE_LABELS[task.stage]} queued`
}

/** The agent currently working the task, or the most recent one that touched it — for an at-a-glance "who". */
function currentAgent(task: QueuedTask) {
  return task.active ?? task.history[task.history.length - 1]
}

/** The agent currently working the task, or the most recent one that touched it — for an at-a-glance "who". */
function currentAgentLabel(task: QueuedTask): string | undefined {
  const agent = currentAgent(task)
  if (!agent) return undefined
  const parts = [agent.agentName, agent.model, agent.effort ? `${agent.effort} effort` : undefined].filter(Boolean)
  return parts.join(' · ')
}

/** Label for the run button when this task's stage can be (re)started right now, else undefined. */
function runActionLabel(task: QueuedTask): string | undefined {
  if (task.status === 'error') return 'Retry'
  if (task.status === 'paused') return 'Run'
  return undefined
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

function Column({
  title,
  tasks,
  workflowTasks,
  onSelectTask,
  onRunTask,
  runningTaskId,
}: {
  title: string
  tasks: GithubTask[]
  workflowTasks: QueuedTask[]
  onSelectTask: (task: GithubTask) => void
  onRunTask: (task: QueuedTask) => void
  runningTaskId: string | null
}) {
  return (
    <div>
      <h4 className="mb-2">
        {title} <span className="text-muted">({tasks.length})</span>
      </h4>
      <div className="flex flex-col gap-2">
        {tasks.map((task) => {
          const workflowTask = findWorkflowTask(task, workflowTasks)
          return (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectTask(task)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectTask(task)
                }
              }}
              className="card elev-sm cursor-pointer"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="card-kicker">#{task.number}</span>
                <div className="flex gap-1.5">
                  {workflowTask && (
                    <span className={`tag ${workflowBadgeClass(workflowTask)}`}>
                      {workflowTask.status === 'running' && <span className="live-dot mr-1" />}
                      {workflowBadgeLabel(workflowTask)}
                    </span>
                  )}
                  {task.urgent && <span className="tag tag-accent">urgent</span>}
                </div>
              </div>
              <p className="card-title text-[15px]">{task.title}</p>
              <p className="card-meta">{new Date(task.updatedAt).toLocaleString()}</p>
              {workflowTask &&
                (() => {
                  // Don't gate the Run/Retry button on agent metadata: a task that fails during its
                  // very first stage has `active` cleared by runStage() and no history entry yet, so
                  // there is nothing to show here except the button itself — it must still render.
                  const agent = currentAgent(workflowTask)
                  const label = runActionLabel(workflowTask)
                  if (!agent && !label) return null
                  return (
                    <div
                      className="mt-1 flex items-end justify-between gap-2"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        {agent && <p className="card-meta">{currentAgentLabel(workflowTask)}</p>}
                        {agent?.prompt && (
                          <details>
                            <summary className="cursor-pointer text-xs text-muted">Prompt</summary>
                            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs">
                              {agent.prompt}
                            </pre>
                          </details>
                        )}
                      </div>
                      {label && (
                        <button
                          type="button"
                          onClick={() => onRunTask(workflowTask)}
                          disabled={runningTaskId === workflowTask.id}
                          className="btn btn-primary shrink-0 px-2.5 py-1 text-xs"
                        >
                          {runningTaskId === workflowTask.id ? 'Running…' : label}
                        </button>
                      )}
                    </div>
                  )
                })()}
            </div>
          )
        })}
        {tasks.length === 0 && <p className="text-muted text-sm">No items</p>}
      </div>
    </div>
  )
}

export default function KanbanBoard({ repo }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<GithubTask[]>([])
  const [workflowTasks, setWorkflowTasks] = useState<QueuedTask[]>([])
  const [error, setError] = useState('')
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [, forceTick] = useState(0)
  const [selectedTask, setSelectedTask] = useState<GithubTask | null>(null)
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null)

  const loadWorkflowTasks = () =>
    window.electronAPI.workflow
      .list()
      .then((all) => setWorkflowTasks(all.filter((t) => t.repo.owner === repo.owner && t.repo.repo === repo.repo)))

  useEffect(() => {
    loadWorkflowTasks()
    const interval = setInterval(loadWorkflowTasks, 2000)
    return () => clearInterval(interval)
  }, [repo.owner, repo.repo])

  /** Runs the assigned agent's current stage right now: retries an errored task, or advances a paused one. */
  async function runTask(task: QueuedTask) {
    setRunningTaskId(task.id)
    try {
      if (task.status === 'error') await window.electronAPI.workflow.retry(task.id)
      else if (task.status === 'paused') await window.electronAPI.workflow.advance(task.id)
      await loadWorkflowTasks()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunningTaskId(null)
    }
  }

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
        <Column
          title="Issues"
          tasks={issues}
          workflowTasks={workflowTasks}
          onSelectTask={setSelectedTask}
          onRunTask={runTask}
          runningTaskId={runningTaskId}
        />
        <Column
          title="Pull Requests"
          tasks={pullRequests}
          workflowTasks={workflowTasks}
          onSelectTask={setSelectedTask}
          onRunTask={runTask}
          runningTaskId={runningTaskId}
        />
      </div>

      {selectedTask && (
        <TaskDetailModal
          repo={repo}
          number={selectedTask.number}
          type={selectedTask.type}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </div>
  )
}
