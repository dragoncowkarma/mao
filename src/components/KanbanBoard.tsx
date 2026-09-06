import { useEffect, useState } from 'react'
import type { AiProviderConfig } from '../../core/ai/types'
import { providerToolLabel } from '../../core/ai/provider-options'
import { previewStageAgent } from '../../core/agent-selection'
import type { RunOverride } from '../../core/agent-selection'
import type { GithubTask } from '../../core/github-service'
import type { QueuedTask, RepoRef } from '../../core/workflow-engine'
import AgentRunControls from './AgentRunControls'
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
  if (task.status === 'paused') return 'tag-warn'
  return 'tag-neutral'
}

/** A task is "active" (in-flight right now) when it's actually running, or sitting in review — the
 * two states this issue asks to be visually unmissable across the board. */
function isActiveTask(task: QueuedTask): boolean {
  return task.status === 'running' || task.stage === 'review'
}

function workflowBadgeLabel(task: QueuedTask): string {
  if (task.status === 'error') return `${STAGE_LABELS[task.stage]} failed`
  if (task.status === 'running') return `${STAGE_LABELS[task.stage]} running`
  if (task.status === 'paused') return `${STAGE_LABELS[task.stage]} paused`
  if (task.status === 'done') return 'workflow done'
  return `${STAGE_LABELS[task.stage]} queued`
}

/** The agent running right now, or the most recent one that touched the task — the entry that
 * carries a real prompt, so it is what the card's Prompt disclosure shows. */
function lastStep(task: QueuedTask) {
  return task.active ?? task.history[task.history.length - 1]
}

/**
 * Who this card's stage belongs to, for an at-a-glance "who": the agent running right now, the one
 * that finished the pipeline, or — for a stage that has not run yet — the agent the engine would pick
 * for it. That last case is why `providers` is needed: a freshly queued card has neither `active` nor
 * `history`, and before issue #42 named no AI at all until its stage was already underway.
 */
function currentAgentLabel(task: QueuedTask, providers: AiProviderConfig[]): string | undefined {
  // Running now, or finished the whole pipeline — either way the card names a real, past-tense agent.
  const activeStep = task.active
  const settled = activeStep ?? (task.status === 'done' ? task.history[task.history.length - 1] : undefined)
  const upcoming = settled
    ? undefined
    : previewStageAgent(providers, {
        stage: task.stage,
        previous: task.history[task.history.length - 1],
        override: task.providerOverride,
        // A task queued behind the single-flight queue already holds the agent the operator picked;
        // without this the card would advertise the default and then run something else.
        oneShot: task.nextRunOverride,
      })
  // Nothing resolvable (no providers configured yet) — fall back to whoever last touched the task.
  const step = settled ?? (upcoming ? undefined : lastStep(task))
  // Name the tool, not just the operator-chosen provider name, for the agent running now or up next.
  // A finished stage keeps its recorded name — the provider's kind may have changed since it ran.
  const live = upcoming ?? (activeStep ? providers.find((p) => p.id === activeStep.agentId) : undefined)
  const name = live ? providerToolLabel(live) : step?.agentName
  if (!name) return undefined
  const model = upcoming?.model ?? step?.model
  const effort = upcoming?.effort ?? step?.effort
  return [name, model, effort ? `${effort} effort` : undefined].filter(Boolean).join(' · ')
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
  allTasks,
  workflowTasks,
  providers,
  onSelectTask,
  onRunTask,
  runningTaskId,
}: {
  title: string
  tasks: GithubTask[]
  /** Full board task list — used to resolve linked issue/PR numbers into their states and titles. */
  allTasks: GithubTask[]
  workflowTasks: QueuedTask[]
  /** Registered AI providers, for naming the assigned agent and populating the run dropdowns. */
  providers: AiProviderConfig[]
  onSelectTask: (task: GithubTask) => void
  onRunTask: (task: QueuedTask, runOverride?: RunOverride) => void
  runningTaskId: string | null
}) {
  const activeCount = tasks.filter((task) => {
    const workflowTask = findWorkflowTask(task, workflowTasks)
    return workflowTask && isActiveTask(workflowTask)
  }).length

  return (
    <div>
      <h4 className="mb-2 flex items-center gap-2">
        {title} <span className="text-muted">({tasks.length})</span>
        {activeCount > 0 && (
          <span className="summary-indicator">
            <span className="live-dot" />
            {activeCount} active
          </span>
        )}
      </h4>
      <div className="flex flex-col gap-2">
        {tasks.map((task) => {
          const workflowTask = findWorkflowTask(task, workflowTasks)
          const active = !!workflowTask && isActiveTask(workflowTask)

          // For PR cards: show the issues this PR closes (from linkedIssueNumbers on the PR).
          // For issue cards: show any open PRs that reference this issue via closing keywords.
          // `task` may be undefined when the referenced item is closed and not in the open-item
          // snapshot — render those as a static "closed" badge rather than silently dropping them.
          const linkedItems: { number: number; label: string; task: GithubTask | undefined }[] =
            task.type === 'pull_request'
              ? (task.linkedIssueNumbers ?? []).map((n) => ({
                  number: n,
                  label: `Issue #${n}`,
                  task: allTasks.find((t) => t.number === n),
                }))
              : allTasks
                  .filter((t) => t.type === 'pull_request' && t.linkedIssueNumbers?.includes(task.number))
                  .map((t) => ({ number: t.number, label: `PR #${t.number}`, task: t }))

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
              className={`card elev-sm cursor-pointer ${active ? 'card-active' : ''}`}
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
                  const step = lastStep(workflowTask)
                  const agentLabel = currentAgentLabel(workflowTask, providers)
                  const label = runActionLabel(workflowTask)
                  if (!agentLabel && !label && !step?.prompt) return null
                  return (
                    <div
                      className="mt-1 flex flex-col gap-1"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        {/* The dropdowns below already name the agent for a runnable stage — don't say it twice. */}
                        {agentLabel && !label && <p className="card-meta">{agentLabel}</p>}
                        {step?.prompt && (
                          <details>
                            <summary className="cursor-pointer text-xs text-muted">Prompt</summary>
                            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs">
                              {step.prompt}
                            </pre>
                          </details>
                        )}
                      </div>
                      {label && (
                        <AgentRunControls
                          // Remount per task *and* stage so a choice made for one stage never carries
                          // into the next — the same one-run-only rule the engine enforces.
                          key={`${workflowTask.id}:${workflowTask.stage}`}
                          task={workflowTask}
                          providers={providers}
                          actionLabel={label}
                          busy={runningTaskId === workflowTask.id}
                          onRun={(runOverride) => onRunTask(workflowTask, runOverride)}
                        />
                      )}
                    </div>
                  )
                })()}
              {linkedItems.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {linkedItems.map(({ number, label, task: linked }) =>
                    linked ? (
                      <button
                        key={number}
                        type="button"
                        className="tag tag-neutral cursor-pointer"
                        title={linked.title}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelectTask(linked)
                        }}
                      >
                        {label} · {linked.state}
                      </button>
                    ) : (
                      <span key={number} className="tag tag-neutral" title="No longer in open items">
                        {label} · closed
                      </span>
                    ),
                  )}
                </div>
              )}
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
  const [providers, setProviders] = useState<AiProviderConfig[]>([])
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

  // Providers change only in Global Settings, so fetch once rather than on the 2s task poll.
  useEffect(() => {
    window.electronAPI.ai
      .list()
      .then(setProviders)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  /**
   * Runs the assigned agent's current stage right now: retries an errored task, or advances a paused
   * one. `runOverride` is the card's one-shot Tool/Model/Effort choice — it applies to this single
   * execution only. The engine validates it and rejects an impossible pick, so surface that message
   * on the card instead of letting the task fail later for a reason the operator can't see.
   */
  async function runTask(task: QueuedTask, runOverride?: RunOverride) {
    setRunningTaskId(task.id)
    try {
      if (task.status === 'error') await window.electronAPI.workflow.retry(task.id, runOverride)
      else if (task.status === 'paused') await window.electronAPI.workflow.advance(task.id, runOverride)
      setError('')
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
          allTasks={sorted}
          workflowTasks={workflowTasks}
          providers={providers}
          onSelectTask={setSelectedTask}
          onRunTask={runTask}
          runningTaskId={runningTaskId}
        />
        <Column
          title="Pull Requests"
          tasks={pullRequests}
          allTasks={sorted}
          workflowTasks={workflowTasks}
          providers={providers}
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
          alreadyQueued={!!findWorkflowTask(selectedTask, workflowTasks)}
          onEnqueued={() => {
            loadWorkflowTasks()
            setSelectedTask(null)
          }}
          allTasks={sorted}
          onNavigate={setSelectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
    </div>
  )
}
