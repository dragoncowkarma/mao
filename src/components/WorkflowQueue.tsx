import { useEffect, useState } from 'react'
import type { QueuedTask, RepoRef } from '../../electron/workflow-engine'

interface WorkflowQueueProps {
  repo: RepoRef
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
  if (task.status === 'done') return 'Done'
  if (task.status === 'paused') return `${STAGE_LABELS[task.stage]} · paused`
  return `${STAGE_LABELS[task.stage]} · ${task.status}`
}

function AgentBadge({ name, model, effort }: { name: string; model?: string; effort?: string }) {
  return (
    <span className="tag tag-neutral inline-flex items-center gap-1">
      {name}
      {model && <span className="opacity-60">· {model}</span>}
      {effort && <span className="opacity-60">· {effort} effort</span>}
    </span>
  )
}

function TaskCard({
  task,
  onRetry,
  onAdvance,
  onToggleAutoAdvance,
}: {
  task: QueuedTask
  onRetry: (id: string) => void
  onAdvance: (id: string) => void
  onToggleAutoAdvance: (id: string, autoAdvance: boolean) => void
}) {
  const [expanded, setExpanded] = useState<number | null>(null)

  return (
    <div className="card elev-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="card-title text-[15px]">{task.title}</span>
        <div className="flex items-center gap-2">
          {task.status === 'running' && <span className="live-dot" title="Currently working" />}
          <span className={`tag ${statusTagClass(task)}`}>{statusLabel(task)}</span>
        </div>
      </div>

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

      {task.status === 'running' && task.active && (
        <div className="card gap-1 p-2">
          <div className="flex items-center gap-2">
            <span className="live-dot" />
            <AgentBadge name={task.active.agentName} model={task.active.model} effort={task.active.effort} />
            <span className="text-muted text-xs">running now</span>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted">Prompt</summary>
            <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">{task.active.prompt}</pre>
          </details>
        </div>
      )}

      {task.history.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {task.history.map((step, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="tag tag-neutral">{STAGE_LABELS[step.stage]}</span>
                <AgentBadge name={step.agentName} model={step.model} effort={step.effort} />
                <button
                  onClick={() => setExpanded(expanded === i ? null : i)}
                  className="btn btn-ghost px-1 text-xs"
                >
                  {expanded === i ? 'Hide details' : 'Show prompt/output'}
                </button>
              </div>
              {expanded === i && (
                <div className="flex flex-col gap-2 pl-1">
                  <div>
                    <p className="text-muted text-[10px] uppercase tracking-wide">Prompt</p>
                    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">{step.prompt}</pre>
                  </div>
                  <div>
                    <p className="text-muted text-[10px] uppercase tracking-wide">Output</p>
                    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">{step.output}</pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {task.status === 'paused' && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted text-xs">
            Waiting for manual advance before starting the {STAGE_LABELS[task.stage]} stage.
          </p>
          <button onClick={() => onAdvance(task.id)} className="btn btn-primary shrink-0 px-2.5 py-1 text-xs">
            Run next stage
          </button>
        </div>
      )}

      {task.status !== 'done' && (
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={task.autoAdvance}
            onChange={(e) => onToggleAutoAdvance(task.id, e.target.checked)}
          />
          Auto-advance through stages
        </label>
      )}

      {task.error && (
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-xs" style={{ color: 'var(--color-accent-700)' }}>
            {task.error}
          </p>
          <button onClick={() => onRetry(task.id)} className="btn btn-secondary shrink-0 px-2.5 py-1 text-xs">
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

export default function WorkflowQueue({ repo }: WorkflowQueueProps) {
  const [tasks, setTasks] = useState<QueuedTask[]>([])
  const [title, setTitle] = useState('')
  const [autoAdvanceNewTask, setAutoAdvanceNewTask] = useState(true)

  useEffect(() => {
    const load = () => window.electronAPI.workflow.list().then(setTasks)
    load()
    const interval = setInterval(load, 2000)
    return () => clearInterval(interval)
  }, [])

  const repoTasks = tasks.filter((t) => t.repo.owner === repo.owner && t.repo.repo === repo.repo)

  async function startWorkflow() {
    if (!title.trim()) return
    await window.electronAPI.workflow.enqueue(title.trim(), repo, autoAdvanceNewTask)
    setTitle('')
    setTasks(await window.electronAPI.workflow.list())
  }

  async function retryTask(taskId: string) {
    await window.electronAPI.workflow.retry(taskId)
    setTasks(await window.electronAPI.workflow.list())
  }

  async function advanceTask(taskId: string) {
    await window.electronAPI.workflow.advance(taskId)
    setTasks(await window.electronAPI.workflow.list())
  }

  async function toggleAutoAdvance(taskId: string, autoAdvance: boolean) {
    await window.electronAPI.workflow.setAutoAdvance(taskId, autoAdvance)
    setTasks(await window.electronAPI.workflow.list())
  }

  async function clearCompleted() {
    await window.electronAPI.workflow.clearCompleted()
    setTasks(await window.electronAPI.workflow.list())
  }

  const finishedCount = repoTasks.filter((t) => t.status === 'done' || t.status === 'error').length

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2>Workflow Queue</h2>
        {finishedCount > 0 && (
          <button onClick={clearCompleted} className="btn btn-secondary">
            Clear completed ({finishedCount})
          </button>
        )}
      </div>

      <div className="my-3 flex flex-wrap items-center gap-2">
        <input
          className="input min-w-[220px] flex-1"
          placeholder="New task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && startWorkflow()}
        />
        <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
          <input
            type="checkbox"
            checked={autoAdvanceNewTask}
            onChange={(e) => setAutoAdvanceNewTask(e.target.checked)}
          />
          Auto-advance
        </label>
        <button onClick={startWorkflow} className="btn btn-primary shrink-0">
          Start
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {repoTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onRetry={retryTask}
            onAdvance={advanceTask}
            onToggleAutoAdvance={toggleAutoAdvance}
          />
        ))}
        {repoTasks.length === 0 && <p className="text-muted text-sm">No workflow tasks yet.</p>}
      </div>
    </div>
  )
}
