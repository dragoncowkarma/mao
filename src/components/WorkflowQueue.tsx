import { useEffect, useState } from 'react'
import { electronApi } from '../electron-api'
import type { AiProviderConfig } from '../../core/ai/types'
import { providerToolKind } from '../../core/ai/provider-options'
import { previewStageAgent } from '../../core/agent-selection'
import { sameRepoRef } from '../../core/repo-registry'
import type { RunOverride } from '../../core/agent-selection'
import type { QueuedTask, RepoRef } from '../../core/workflow-engine'
import type { Messages } from '../i18n'
import AgentRunControls from './AgentRunControls'
import TaskDetailModal from './TaskDetailModal'

interface WorkflowQueueProps {
  /** Every string the queue shows, in the language the operator picked. */
  messages: Messages
  repo: RepoRef
}

function statusTagClass(task: QueuedTask): string {
  if (task.status === 'error') return 'tag-accent'
  if (task.status === 'done') return 'tag-neutral'
  if (task.status === 'paused') return 'tag-warn'
  return 'tag-outline'
}

function statusLabel(task: QueuedTask, messages: Messages): string {
  const tag = messages.workflowQueue.statusTag
  const statuses = messages.workflowQueue.statuses
  if (task.status === 'done') return tag.done
  const stage = messages.common.stages[task.stage]
  if (task.status === 'paused') return tag.inStage(stage, statuses.paused)
  return tag.inStage(stage, statuses[task.status])
}

/** A task is "active" (in-flight right now) when it's actually running, or sitting in review — the
 * two states this issue asks to be visually unmissable across the queue. */
function isActiveTask(task: QueuedTask): boolean {
  return task.status === 'running' || task.stage === 'review'
}

function AgentBadge({
  messages,
  name,
  kind,
  model,
  effort,
}: {
  messages: Messages
  name: string
  /** The AI tool behind the provider — a provider's name needn't say which CLI it drives. */
  kind?: string
  model?: string
  effort?: string
}) {
  return (
    <span className="tag tag-neutral inline-flex items-center gap-1">
      {name}
      {kind && <span className="opacity-60">· {kind}</span>}
      {model && <span className="opacity-60">· {model}</span>}
      {effort && <span className="opacity-60">· {messages.common.effortLevel(effort)}</span>}
    </span>
  )
}

function TaskCard({
  messages,
  task,
  providers,
  busy,
  onRetry,
  onAdvance,
  onToggleAutoAdvance,
  onOpenTask,
}: {
  messages: Messages
  task: QueuedTask
  /** Registered AI providers, for naming the assigned agent and populating the run dropdowns. */
  providers: AiProviderConfig[]
  busy: boolean
  onRetry: (id: string, runOverride?: RunOverride) => void
  onAdvance: (id: string, runOverride?: RunOverride) => void
  onToggleAutoAdvance: (id: string, autoAdvance: boolean) => void
  onOpenTask: (number: number, type: 'issue' | 'pull_request') => void
}) {
  const [expanded, setExpanded] = useState<number | null>(null)
  const active = isActiveTask(task)
  // Who the *next* stage belongs to. A queued task that has never run has no `active` entry and no
  // history, so before issue #42 its card named no AI at all until the stage was already underway.
  const upcoming =
    task.status === 'pending' && !task.active
      ? previewStageAgent(providers, {
          stage: task.stage,
          previous: task.history[task.history.length - 1],
          override: task.providerOverride,
          // A task queued behind the single-flight queue already holds the agent the operator
          // picked; without this the card would advertise the default and then run something else.
          oneShot: task.nextRunOverride,
        })
      : undefined

  return (
    <div className={`card elev-sm ${active ? 'card-active' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="card-title text-[15px]">{task.title}</span>
        <div className="flex items-center gap-2">
          {task.status === 'running' && (
            <span className="live-dot" title={messages.workflowQueue.currentlyWorking} />
          )}
          <span className={`tag ${statusTagClass(task)}`}>{statusLabel(task, messages)}</span>
        </div>
      </div>

      {(task.github.issueNumber !== undefined || task.github.prNumber !== undefined) && (
        <div className="flex gap-3 text-xs">
          {task.github.issueNumber !== undefined && (
            <button
              type="button"
              className="link-button"
              onClick={() => onOpenTask(task.github.issueNumber!, 'issue')}
            >
              {messages.common.issueRef(task.github.issueNumber)}
            </button>
          )}
          {task.github.prNumber !== undefined && (
            <button
              type="button"
              className="link-button"
              onClick={() => onOpenTask(task.github.prNumber!, 'pull_request')}
            >
              {messages.common.prRef(task.github.prNumber)}
            </button>
          )}
        </div>
      )}

      {upcoming && (
        <div className="flex items-center gap-2">
          <span className="tag tag-stage">{messages.common.stages[task.stage]}</span>
          <AgentBadge
            messages={messages}
            name={upcoming.name}
            kind={providerToolKind(upcoming)}
            model={upcoming.model}
            effort={upcoming.effort}
          />
          <span className="text-muted text-xs">{messages.workflowQueue.upNext}</span>
        </div>
      )}

      {task.status === 'running' && task.active && (
        <div className="card gap-1 p-2">
          <div className="flex items-center gap-2">
            <span className="live-dot" />
            <AgentBadge
              messages={messages}
              name={task.active.agentName}
              kind={providerToolKind(task.active)}
              model={task.active.model}
              effort={task.active.effort}
            />
            <span className="text-muted text-xs">{messages.workflowQueue.runningNow}</span>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-muted">{messages.common.prompt}</summary>
            <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">{task.active.prompt}</pre>
          </details>
        </div>
      )}

      {task.history.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {task.history.map((step, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="tag tag-stage">{messages.common.stages[step.stage]}</span>
                <AgentBadge
                  messages={messages}
                  name={step.agentName}
                  kind={providerToolKind(step)}
                  model={step.model}
                  effort={step.effort}
                />
                <button
                  onClick={() => setExpanded(expanded === i ? null : i)}
                  className="btn btn-ghost px-1 text-xs"
                >
                  {expanded === i
                    ? messages.workflowQueue.hideDetails
                    : messages.workflowQueue.showPromptOutput}
                </button>
              </div>
              {expanded === i && (
                <div className="flex flex-col gap-2 pl-1">
                  <div>
                    <p className="text-muted text-[10px] uppercase tracking-wide">{messages.common.prompt}</p>
                    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">{step.prompt}</pre>
                  </div>
                  <div>
                    <p className="text-muted text-[10px] uppercase tracking-wide">
                      {messages.workflowQueue.output}
                    </p>
                    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-xs">{step.output}</pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {task.status === 'paused' && (
        <div className="flex flex-col gap-1.5">
          <p className="text-muted text-xs">
            {messages.workflowQueue.waitingForAdvance(messages.common.stages[task.stage])}
          </p>
          <AgentRunControls
            // Remount per task *and* stage so a choice made for one stage never carries into the
            // next — the same one-run-only rule the engine enforces.
            key={`${task.id}:${task.stage}:advance`}
            messages={messages}
            task={task}
            providers={providers}
            actionLabel={messages.workflowQueue.runNextStage}
            busy={busy}
            onRun={(runOverride) => onAdvance(task.id, runOverride)}
          />
        </div>
      )}

      {task.status !== 'done' && (
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={task.autoAdvance}
            onChange={(e) => onToggleAutoAdvance(task.id, e.target.checked)}
          />
          {messages.workflowQueue.autoAdvanceThroughStages}
        </label>
      )}

      {task.error && (
        <div className="mt-1 flex flex-col gap-1.5">
          <p className="text-xs" style={{ color: 'var(--color-accent-700)' }}>
            {task.error}
          </p>
          <AgentRunControls
            key={`${task.id}:${task.stage}:retry`}
            messages={messages}
            task={task}
            providers={providers}
            actionLabel={messages.common.retry}
            busy={busy}
            onRun={(runOverride) => onRetry(task.id, runOverride)}
          />
        </div>
      )}
    </div>
  )
}

export default function WorkflowQueue({ messages, repo }: WorkflowQueueProps) {
  const [tasks, setTasks] = useState<QueuedTask[]>([])
  const [providers, setProviders] = useState<AiProviderConfig[]>([])
  const [title, setTitle] = useState('')
  const [autoAdvanceNewTask, setAutoAdvanceNewTask] = useState(true)
  const [openTask, setOpenTask] = useState<{ number: number; type: 'issue' | 'pull_request' } | null>(null)
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = () => electronApi().workflow.list().then(setTasks)
    load()
    const interval = setInterval(load, 2000)
    return () => clearInterval(interval)
  }, [])

  // Providers change only in Global Settings, so fetch once rather than on the 2s task poll.
  useEffect(() => {
    electronApi()
      .ai.list()
      .then(setProviders)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  // sameRepoRef, not ===: see the matching note in KanbanBoard — a task carries the spelling it was
  // enqueued with, which need not be the one now stored for the same repository.
  const repoTasks = tasks.filter((t) => sameRepoRef(t.repo, repo))

  /**
   * Runs a queue action and shows what came back if it was refused.
   *
   * These three had no catch at all, which was survivable while the only rejections came from `retry`
   * and `advance` (both routed through `runStage`, which does catch). Issue #68's queue-recovery latch
   * refuses `enqueue`, `setAutoAdvance` and `clearCompleted` too, and an unhandled rejection presents as
   * the button simply doing nothing — which would hide the one message explaining why.
   */
  async function withError(action: () => Promise<unknown>) {
    try {
      await action()
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function startWorkflow() {
    if (!title.trim()) return
    await withError(async () => {
      await electronApi().workflow.enqueue(title.trim(), repo, autoAdvanceNewTask)
      setTitle('')
    })
    setTasks(await electronApi().workflow.list())
  }

  /**
   * Re-runs a stage with the card's one-shot Tool/Model/Effort choice, if any. The engine validates
   * the choice and rejects an impossible one (unknown provider, or a pick maker-checker forbids), so
   * catch that and show it here — otherwise the click would fail silently as an unhandled rejection.
   */
  async function runStage(taskId: string, run: () => Promise<unknown>) {
    setRunningTaskId(taskId)
    try {
      await run()
      setError('')
      setTasks(await electronApi().workflow.list())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunningTaskId(null)
    }
  }

  function retryTask(taskId: string, runOverride?: RunOverride) {
    void runStage(taskId, () => electronApi().workflow.retry(taskId, runOverride))
  }

  function advanceTask(taskId: string, runOverride?: RunOverride) {
    void runStage(taskId, () => electronApi().workflow.advance(taskId, runOverride))
  }

  async function toggleAutoAdvance(taskId: string, autoAdvance: boolean) {
    await withError(() => electronApi().workflow.setAutoAdvance(taskId, autoAdvance))
    setTasks(await electronApi().workflow.list())
  }

  async function clearCompleted() {
    await withError(() => electronApi().workflow.clearCompleted())
    setTasks(await electronApi().workflow.list())
  }

  const finishedCount = repoTasks.filter((t) => t.status === 'done' || t.status === 'error').length
  const activeCount = repoTasks.filter(isActiveTask).length

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2>{messages.workflowQueue.heading}</h2>
          {activeCount > 0 && (
            <span className="summary-indicator">
              <span className="live-dot" />
              {messages.common.activeCount(activeCount)}
            </span>
          )}
        </div>
        {finishedCount > 0 && (
          <button onClick={clearCompleted} className="btn btn-secondary">
            {messages.workflowQueue.clearCompleted(finishedCount)}
          </button>
        )}
      </div>

      <div className="my-3 flex flex-wrap items-center gap-2">
        <input
          className="input min-w-[220px] flex-1"
          placeholder={messages.workflowQueue.newTaskTitle}
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
          {messages.workflowQueue.autoAdvance}
        </label>
        <button onClick={startWorkflow} className="btn btn-primary shrink-0">
          {messages.workflowQueue.start}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {repoTasks.map((task) => (
          <TaskCard
            key={task.id}
            messages={messages}
            task={task}
            providers={providers}
            busy={runningTaskId === task.id}
            onRetry={retryTask}
            onAdvance={advanceTask}
            onToggleAutoAdvance={toggleAutoAdvance}
            onOpenTask={(number, type) => setOpenTask({ number, type })}
          />
        ))}
        {repoTasks.length === 0 && <p className="text-muted text-sm">{messages.workflowQueue.noTasks}</p>}
      </div>

      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-accent-700)' }}>
          {error}
        </p>
      )}

      {openTask && (
        <TaskDetailModal
          messages={messages}
          repo={repo}
          number={openTask.number}
          type={openTask.type}
          // Every card here is already a QueuedTask by construction — no "add to workflow" action needed.
          alreadyQueued
          onEnqueued={() => {}}
          onClose={() => setOpenTask(null)}
        />
      )}
    </div>
  )
}
