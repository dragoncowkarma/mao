import { useEffect, useState } from 'react'
import type { QueuedTask } from '../../electron/workflow-engine'

const STAGE_LABELS: Record<QueuedTask['stage'], string> = {
  issue: 'Issue',
  pr: 'PR',
  review: 'Review',
  merge: 'Merge',
}

export default function WorkflowQueue() {
  const [tasks, setTasks] = useState<QueuedTask[]>([])
  const [title, setTitle] = useState('')

  useEffect(() => {
    const load = () => window.electronAPI.workflow.list().then(setTasks)
    load()
    const interval = setInterval(load, 2000)
    return () => clearInterval(interval)
  }, [])

  async function startWorkflow() {
    if (!title.trim()) return
    await window.electronAPI.workflow.enqueue(title.trim())
    setTitle('')
    setTasks(await window.electronAPI.workflow.list())
  }

  async function retryTask(taskId: string) {
    await window.electronAPI.workflow.retry(taskId)
    setTasks(await window.electronAPI.workflow.list())
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4">
      <h2 className="mb-3 text-base font-semibold text-slate-100">Workflow Queue</h2>

      <div className="mb-4 flex gap-2">
        <input
          className="flex-1 rounded bg-slate-900 px-2 py-1 text-sm text-slate-100"
          placeholder="New task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && startWorkflow()}
        />
        <button
          onClick={startWorkflow}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Start
        </button>
      </div>

      <div className="space-y-2">
        {tasks.map((task) => (
          <div key={task.id} className="rounded bg-slate-900 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-100">{task.title}</span>
              <span
                className={
                  'rounded px-2 py-0.5 text-xs ' +
                  (task.status === 'error'
                    ? 'bg-red-900/60 text-red-200'
                    : task.status === 'done'
                      ? 'bg-emerald-900/60 text-emerald-200'
                      : 'bg-slate-700 text-slate-200')
                }
              >
                {task.status === 'done' ? 'Done' : `${STAGE_LABELS[task.stage]} · ${task.status}`}
              </span>
            </div>
            {(task.github.issueUrl || task.github.prUrl) && (
              <div className="mt-2 flex gap-3 text-xs">
                {task.github.issueUrl && (
                  <a
                    href={task.github.issueUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-300 hover:underline"
                  >
                    Issue #{task.github.issueNumber}
                  </a>
                )}
                {task.github.prUrl && (
                  <a
                    href={task.github.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-300 hover:underline"
                  >
                    PR #{task.github.prNumber}
                  </a>
                )}
              </div>
            )}
            {task.history.length > 0 && (
              <ol className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
                {task.history.map((step, i) => (
                  <li key={i} className="rounded bg-slate-800 px-2 py-0.5">
                    {STAGE_LABELS[step.stage]} → <span className="text-indigo-300">{step.agentName}</span>
                  </li>
                ))}
              </ol>
            )}
            {task.error && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-xs text-red-400">{task.error}</p>
                <button
                  onClick={() => retryTask(task.id)}
                  className="shrink-0 rounded bg-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-600"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        ))}
        {tasks.length === 0 && <p className="text-xs text-slate-500">No workflow tasks yet.</p>}
      </div>
    </div>
  )
}
