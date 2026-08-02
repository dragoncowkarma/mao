import { useEffect, useState } from 'react'
import type { QueuedTask, RepoRef } from '../../electron/workflow-engine'

interface WorkflowQueueProps {
  repos: RepoRef[]
}

const STAGE_LABELS: Record<QueuedTask['stage'], string> = {
  issue: 'Issue',
  pr: 'PR',
  review: 'Review',
  merge: 'Merge',
}

function statusTagClass(task: QueuedTask): string {
  if (task.status === 'error') return 'tag-accent'
  if (task.status === 'done') return 'tag-neutral'
  return 'tag-outline'
}

function statusLabel(task: QueuedTask): string {
  return task.status === 'done' ? 'Done' : `${STAGE_LABELS[task.stage]} · ${task.status}`
}

export default function WorkflowQueue({ repos }: WorkflowQueueProps) {
  const [tasks, setTasks] = useState<QueuedTask[]>([])
  const [title, setTitle] = useState('')
  const [repoIndex, setRepoIndex] = useState(0)

  useEffect(() => {
    const load = () => window.electronAPI.workflow.list().then(setTasks)
    load()
    const interval = setInterval(load, 2000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (repoIndex >= repos.length) setRepoIndex(0)
  }, [repos, repoIndex])

  async function startWorkflow() {
    const repo = repos[repoIndex]
    if (!title.trim() || !repo) return
    await window.electronAPI.workflow.enqueue(title.trim(), repo)
    setTitle('')
    setTasks(await window.electronAPI.workflow.list())
  }

  async function retryTask(taskId: string) {
    await window.electronAPI.workflow.retry(taskId)
    setTasks(await window.electronAPI.workflow.list())
  }

  return (
    <div>
      <h2>Workflow Queue</h2>

      <div className="my-3 flex flex-wrap gap-2">
        <select
          className="input max-w-[220px]"
          value={repoIndex}
          onChange={(e) => setRepoIndex(Number(e.target.value))}
          disabled={repos.length === 0}
        >
          {repos.length === 0 && <option>No repos configured</option>}
          {repos.map((r, i) => (
            <option key={i} value={i}>
              {r.owner}/{r.repo}
            </option>
          ))}
        </select>
        <input
          className="input min-w-[220px] flex-1"
          placeholder="New task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && startWorkflow()}
        />
        <button onClick={startWorkflow} disabled={repos.length === 0} className="btn btn-primary shrink-0">
          Start
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {tasks.map((task) => (
          <div key={task.id} className="card elev-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="card-title text-[15px]">{task.title}</span>
              <span className={`tag ${statusTagClass(task)}`}>{statusLabel(task)}</span>
            </div>
            <p className="card-meta">
              {task.repo.owner}/{task.repo.repo}
            </p>

            {(task.github.issueUrl || task.github.prUrl) && (
              <div className="flex gap-3 text-xs">
                {task.github.issueUrl && (
                  <a href={task.github.issueUrl} target="_blank" rel="noreferrer">
                    Issue #{task.github.issueNumber}
                  </a>
                )}
                {task.github.prUrl && (
                  <a href={task.github.prUrl} target="_blank" rel="noreferrer">
                    PR #{task.github.prNumber}
                  </a>
                )}
              </div>
            )}

            {task.history.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {task.history.map((step, i) => (
                  <span key={i} className="tag tag-neutral">
                    {STAGE_LABELS[step.stage]} → {step.agentName}
                  </span>
                ))}
              </div>
            )}

            {task.error && (
              <div className="mt-1 flex items-center justify-between gap-2">
                <p className="text-xs" style={{ color: 'var(--color-accent-700)' }}>
                  {task.error}
                </p>
                <button
                  onClick={() => retryTask(task.id)}
                  className="btn btn-secondary shrink-0 px-2.5 py-1 text-xs"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        ))}
        {tasks.length === 0 && <p className="text-muted text-sm">No workflow tasks yet.</p>}
      </div>
    </div>
  )
}
