import { useEffect, useMemo, useRef, useState } from 'react'
import { electronApi } from '../electron-api'
import { layoutCommitGraph, type CommitGraphData, type GraphRow } from '../../core/commit-graph'
import type { RepoRef } from '../../core/workflow-engine'

interface CommitGraphProps {
  repo: RepoRef
}

const ROW_HEIGHT = 28
const LANE_WIDTH = 14
const NODE_RADIUS = 4
/** Matches the number of `--graph-lane-N` tokens in src/index.css. */
const LANE_COLORS = 6

function laneColor(lane: number): string {
  return `var(--graph-lane-${lane % LANE_COLORS})`
}

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2
}

/** A straight line when the lane does not move, an S-curve when it changes column. */
function edgePath(fromLane: number, fromY: number, toLane: number, toY: number): string {
  const x1 = laneX(fromLane)
  const x2 = laneX(toLane)
  if (x1 === x2) return `M ${x1} ${fromY} L ${x2} ${toY}`
  const midY = (fromY + toY) / 2
  return `M ${x1} ${fromY} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${toY}`
}

function shortDate(iso: string): string {
  const time = Date.parse(iso)
  return Number.isNaN(time) ? '' : new Date(time).toLocaleDateString()
}

/** One row's slice of the graph. Rows are equal height, so each strip continues the one above it. */
function LaneStrip({ row, width }: { row: GraphRow; width: number }) {
  const mid = ROW_HEIGHT / 2
  return (
    <svg className="graph-lanes" width={width * LANE_WIDTH} height={ROW_HEIGHT} aria-hidden="true">
      {row.through.map((lane) => (
        <path key={`t${lane}`} d={edgePath(lane, 0, lane, ROW_HEIGHT)} stroke={laneColor(lane)} strokeWidth={2} fill="none" />
      ))}
      {row.incoming.map((lane) => (
        <path key={`i${lane}`} d={edgePath(lane, 0, row.column, mid)} stroke={laneColor(lane)} strokeWidth={2} fill="none" />
      ))}
      {row.outgoing.map((lane) => (
        <path key={`o${lane}`} d={edgePath(row.column, mid, lane, ROW_HEIGHT)} stroke={laneColor(lane)} strokeWidth={2} fill="none" />
      ))}
      {row.truncated && (
        <path
          d={edgePath(row.column, mid, row.column, ROW_HEIGHT)}
          stroke={laneColor(row.column)}
          strokeWidth={2}
          strokeDasharray="2 3"
          fill="none"
        />
      )}
      <circle
        cx={laneX(row.column)}
        cy={mid}
        r={NODE_RADIUS}
        fill={row.commit.parents.length > 1 ? 'var(--color-bg)' : laneColor(row.column)}
        stroke={laneColor(row.column)}
        strokeWidth={2}
      />
    </svg>
  )
}

export default function CommitGraph({ repo }: CommitGraphProps) {
  const [data, setData] = useState<CommitGraphData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  /**
   * Only the newest request may apply. A Refresh clicked while the previous load is still in flight, or a
   * project switch, would otherwise let a slower, older answer land last and show another repository's
   * history under this one's name.
   */
  const latestRequest = useRef(0)

  async function load() {
    const request = (latestRequest.current += 1)
    setLoading(true)
    try {
      const result = await electronApi().github.fetchCommitGraph(repo.owner, repo.repo)
      if (latestRequest.current !== request) return
      setData(result)
      setError('')
    } catch (err) {
      if (latestRequest.current !== request) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (latestRequest.current === request) setLoading(false)
    }
  }

  // Loaded on entry and on a project switch, deliberately not polled: one load is up to
  // `2 + COMMIT_GRAPH_LIMITS.maxBranches` REST calls, and history is not something to watch tick by.
  useEffect(() => {
    setData(null)
    setError('')
    void load()
    return () => {
      // Invalidate the in-flight answer on unmount/switch so it cannot land on the next project.
      latestRequest.current += 1
    }
  }, [repo.owner, repo.repo])

  const layout = useMemo(() => (data ? layoutCommitGraph(data) : null), [data])
  const defaultBranch = data?.defaultBranch

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2>Graph</h2>
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-muted text-xs">
              {data.commits.length} commits · {data.branches.length} branches
            </span>
          )}
          <button onClick={() => void load()} disabled={loading} className="btn btn-secondary">
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="mt-2 text-xs" style={{ color: 'var(--color-accent-700)' }}>{error}</p>}

      {data && (data.omittedBranches > 0 || !data.branchListComplete) && (
        <p className="text-muted mt-2 text-xs">
          Showing {data.branches.length} branches; {data.branchListComplete ? '' : 'at least '}
          {data.omittedBranches} more not drawn. Dashed lines continue beyond the loaded history.
        </p>
      )}

      {layout && layout.rows.length === 0 && <p className="text-muted mt-4 text-sm">No commits</p>}

      {layout && layout.rows.length > 0 && (
        <ol className="graph-list mt-4" aria-label={`Commit graph for ${repo.owner}/${repo.repo}`}>
          {layout.rows.map((row) => (
            <li key={row.commit.sha} className="graph-row">
              <LaneStrip row={row} width={layout.width} />
              {row.refs.map((ref) => (
                <span
                  key={ref}
                  className="graph-ref"
                  style={{ color: laneColor(row.column), fontWeight: ref === defaultBranch ? 800 : 400 }}
                >
                  {ref}
                </span>
              ))}
              <a href={row.commit.url} target="_blank" rel="noreferrer" className="graph-message">
                {row.commit.message}
              </a>
              <span className="graph-meta">
                <code>{row.commit.sha.slice(0, 7)}</code> · {row.commit.author} · {shortDate(row.commit.date)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
