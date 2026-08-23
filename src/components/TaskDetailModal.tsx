import { useEffect, useRef, useState } from 'react'
import type { GithubTask, GithubTaskDetail } from '../../core/github-service'
import type { RepoRef } from '../../core/workflow-engine'

interface TaskDetailModalProps {
  repo: RepoRef
  /** Identifies the card that was clicked; full title/body/labels/comments are fetched on open. */
  number: number
  type: 'issue' | 'pull_request'
  /** Whether this issue already has a QueuedTask driving it — hides the "add to workflow" action. */
  alreadyQueued: boolean
  /** Called after a successful enqueue so the caller can refresh its workflow task list. */
  onEnqueued: () => void
  /**
   * Full task list from the board — used to resolve linked issue/PR numbers to their states.
   * Optional: when absent (e.g. in WorkflowQueue), the linked-item section is simply hidden.
   */
  allTasks?: GithubTask[]
  /** Called when the user clicks a linked issue or PR badge to navigate to it in-app. */
  onNavigate?: (task: GithubTask) => void
  onClose: () => void
}

/**
 * In-app replacement for opening the GitHub issue/PR in the OS browser. Renders what the caller
 * already knows (number/type) immediately, then fills in from `github:fetchTaskDetail` once it
 * resolves. A "View on GitHub" link stays available for the cases the in-app view doesn't cover.
 */
export default function TaskDetailModal({
  repo,
  number,
  type,
  alreadyQueued,
  onEnqueued,
  allTasks = [],
  onNavigate,
  onClose,
}: TaskDetailModalProps) {
  const [detail, setDetail] = useState<GithubTaskDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [enqueueing, setEnqueueing] = useState(false)
  const [enqueueError, setEnqueueError] = useState('')

  /**
   * Guards the enqueue flow's async tail (the poll in waitForImmediateFailure, and its onEnqueued()
   * call) against running after this modal has unmounted — e.g. the user closed it and opened a
   * different issue's modal while the single-flight queue was still busy with something else. Without
   * this, the stale onEnqueued() fires later and closes whatever modal happens to be open then, since
   * KanbanBoard's callback unconditionally clears the selected task.
   */
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError('')
    setLoading(true)
    window.electronAPI.github
      .fetchTaskDetail(repo.owner, repo.repo, number)
      .then((result) => {
        if (!cancelled) setDetail(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repo.owner, repo.repo, number])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /**
   * enqueueFromIssue() returns as soon as the task is queued — it never awaits the stage that
   * `processQueue()` kicks off in the background, so init failures (e.g. no AI providers
   * registered) never reach this call's try/catch. Those failures set status: 'error' inside
   * runStage() essentially synchronously (before any await), so a short poll of the freshly
   * created task is enough to catch them and show them inline instead of silently closing the
   * modal and leaving the user to notice the failed card later in the queue.
   */
  async function waitForImmediateFailure(taskId: string): Promise<string | null> {
    for (let i = 0; i < 10; i++) {
      if (!mountedRef.current) return null
      const tasks = await window.electronAPI.workflow.list()
      if (!mountedRef.current) return null
      const task = tasks.find((t) => t.id === taskId)
      if (task?.status === 'error') return task.error ?? 'Task failed to start'
      if (task && task.status !== 'pending') return null
      await new Promise((r) => setTimeout(r, 150))
    }
    return null
  }

  async function enqueue() {
    setEnqueueing(true)
    setEnqueueError('')
    try {
      const task = await window.electronAPI.workflow.enqueueFromIssue(repo.owner, repo.repo, number, autoAdvance)
      const immediateError = await waitForImmediateFailure(task.id)
      if (!mountedRef.current) return
      if (immediateError) {
        setEnqueueError(immediateError)
        return
      }
      onEnqueued()
    } catch (err) {
      if (mountedRef.current) setEnqueueError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current) setEnqueueing(false)
    }
  }

  const kicker = type === 'pull_request' ? 'Pull Request' : 'Issue'
  const fallbackUrl = `https://github.com/${repo.owner}/${repo.repo}/${type === 'pull_request' ? 'pull' : 'issues'}/${number}`

  // For PRs: resolve linked issue numbers from the fetched detail body.
  // For issues: find any open PRs in the board list that close this issue.
  // Items not in the current open-item snapshot (closed) are kept with task: undefined
  // and rendered as GitHub links rather than silently dropping the relationship.
  const linkedItems: { number: number; label: string; task: GithubTask | undefined }[] =
    type === 'pull_request'
      ? (detail?.linkedIssueNumbers ?? []).map((n) => ({
          number: n,
          label: `Closes Issue #${n}`,
          task: allTasks.find((t) => t.number === n),
        }))
      : allTasks
          .filter((t) => t.type === 'pull_request' && t.linkedIssueNumbers?.includes(number))
          .map((t) => ({ number: t.number, label: `PR #${t.number}`, task: t }))

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card elev-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="card-kicker">
              {kicker} #{number}
            </span>
            <h3 className="mt-1">{detail?.title ?? '…'}</h3>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost shrink-0" aria-label="Close">
            Close
          </button>
        </div>

        {detail && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`tag ${detail.state === 'open' ? 'tag-outline' : 'tag-neutral'}`}>{detail.state}</span>
            {detail.urgent && <span className="tag tag-accent">urgent</span>}
            {detail.labels.map((label) => (
              <span key={label} className="tag tag-neutral">
                {label}
              </span>
            ))}
          </div>
        )}

        {linkedItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="card-meta shrink-0">{type === 'pull_request' ? 'Closes:' : 'Linked PRs:'}</span>
            {linkedItems.map(({ number: n, label, task }) =>
              task ? (
                <button
                  key={n}
                  type="button"
                  onClick={() => onNavigate?.(task)}
                  className="tag tag-neutral cursor-pointer"
                  title={task.title}
                >
                  {label} · {task.state}
                </button>
              ) : (
                <a
                  key={n}
                  href={`https://github.com/${repo.owner}/${repo.repo}/issues/${n}`}
                  target="_blank"
                  rel="noreferrer"
                  className="tag tag-neutral"
                  title="No longer in open items — view on GitHub"
                >
                  {label} · closed ↗
                </a>
              ),
            )}
          </div>
        )}

        {loading && <p className="text-muted text-sm">Loading…</p>}
        {error && (
          <p className="text-sm" style={{ color: 'var(--color-accent-700)' }}>
            {error}
          </p>
        )}

        {detail && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="card-meta">
                Opened by {detail.author} · {new Date(detail.updatedAt).toLocaleString()}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm">{detail.body || 'No description provided.'}</p>
            </div>

            {detail.comments.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-muted text-[10px] uppercase tracking-wide">
                  {detail.comments.length} comment{detail.comments.length === 1 ? '' : 's'}
                </p>
                {detail.comments.map((comment) => (
                  <div key={comment.id} className="card gap-1 p-2">
                    <p className="card-meta">
                      {comment.author} · {new Date(comment.createdAt).toLocaleString()}
                    </p>
                    <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {type === 'issue' && !alreadyQueued && (
          <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--color-divider)' }}>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={autoAdvance}
                onChange={(e) => setAutoAdvance(e.target.checked)}
                disabled={enqueueing}
              />
              Auto-advance through pr → review → merge unattended
            </label>
            <button type="button" onClick={enqueue} disabled={enqueueing} className="btn btn-primary self-start">
              {enqueueing ? 'Adding…' : 'Add to workflow'}
            </button>
            {enqueueError && (
              <p className="text-sm" style={{ color: 'var(--color-accent-700)' }}>
                {enqueueError}
              </p>
            )}
          </div>
        )}

        <div>
          <a href={detail?.url ?? fallbackUrl} target="_blank" rel="noreferrer" className="text-xs">
            View on GitHub ↗
          </a>
        </div>
      </div>
    </div>
  )
}
