import { useEffect, useState } from 'react'
import type { GithubTaskDetail } from '../../core/github-service'
import type { RepoRef } from '../../core/workflow-engine'

interface TaskDetailModalProps {
  repo: RepoRef
  /** Identifies the card that was clicked; full title/body/labels/comments are fetched on open. */
  number: number
  type: 'issue' | 'pull_request'
  onClose: () => void
}

/**
 * In-app replacement for opening the GitHub issue/PR in the OS browser. Renders what the caller
 * already knows (number/type) immediately, then fills in from `github:fetchTaskDetail` once it
 * resolves. A "View on GitHub" link stays available for the cases the in-app view doesn't cover.
 */
export default function TaskDetailModal({ repo, number, type, onClose }: TaskDetailModalProps) {
  const [detail, setDetail] = useState<GithubTaskDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

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

  const kicker = type === 'pull_request' ? 'Pull Request' : 'Issue'
  const fallbackUrl = `https://github.com/${repo.owner}/${repo.repo}/${type === 'pull_request' ? 'pull' : 'issues'}/${number}`

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

        <div>
          <a href={detail?.url ?? fallbackUrl} target="_blank" rel="noreferrer" className="text-xs">
            View on GitHub ↗
          </a>
        </div>
      </div>
    </div>
  )
}
