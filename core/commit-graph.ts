/**
 * Pure, renderer-importable commit-graph model: the data `GithubService.fetchCommitGraph()` returns and
 * the lane layout the Graph tab draws from it.
 *
 * Lives in `core/` rather than `src/` so the CLI (`mao github graph`) and the renderer agree on one
 * definition of what was fetched and how it is ordered (AGENTS.md rule 6). Keep it free of value imports:
 * the renderer bundles this module, so anything Node-side pulled in here would ship to the window.
 */

/** One commit, trimmed to what the graph shows. */
export interface GraphCommit {
  sha: string
  /** Parent SHAs in git order — the first parent is the line the commit was made on. */
  parents: string[]
  /** First line of the commit message only; the graph has no room for a body. */
  message: string
  author: string
  /** ISO-8601 committer date (falls back to the author date). */
  date: string
  url: string
}

export interface GraphBranch {
  name: string
  sha: string
}

/**
 * A bounded window onto a repository's history, never the whole of it.
 *
 * The bounds are what make it safe to fetch from a UI (one stage at a time is not at stake here, but the
 * GitHub rate limit is), and they are carried in the result on purpose: a graph that silently stops at
 * its window reads as "this is where the history begins", which it is not.
 */
export interface CommitGraphData {
  defaultBranch: string
  /** Branches whose history was fetched, default branch first. */
  branches: GraphBranch[]
  commits: GraphCommit[]
  /** Branches GitHub listed that were left out to stay inside `COMMIT_GRAPH_LIMITS.maxBranches`. */
  omittedBranches: number
  /**
   * False when the branch listing itself hit its page size, so there may be branches nobody counted —
   * `omittedBranches` is then a lower bound.
   */
  branchListComplete: boolean
}

/**
 * How much history one graph load may request. Every commit page is one REST call, so the worst case is
 * `2 + maxBranches` calls (repo, branch list, one commit page per branch).
 */
export const COMMIT_GRAPH_LIMITS = {
  /** Commits read from the default branch. */
  defaultBranchCommits: 100,
  /** Commits read from each other branch — enough to reach where a short-lived branch forked. */
  branchCommits: 30,
  /** Branches drawn, the default branch included. */
  maxBranches: 20,
  /** One page of `repos.listBranches`; a full page means the listing may be incomplete. */
  branchListPage: 100,
} as const

/** One drawn row. Columns are lane indexes; a lane keeps its column for as long as it lives. */
export interface GraphRow {
  commit: GraphCommit
  /** The lane this commit's node sits in. */
  column: number
  /** Lanes that pass straight through this row on their way to an older commit. */
  through: number[]
  /** Lanes that end at this commit's node — its children's lines, entering from above. */
  incoming: number[]
  /** Lanes leaving the node downward, one per parent inside the fetched window. */
  outgoing: number[]
  /** A parent lies outside the fetched window, so the line below this node is cut off, not finished. */
  truncated: boolean
  /** Branch names whose head is this commit, default branch first. */
  refs: string[]
}

export interface CommitGraphLayout {
  rows: GraphRow[]
  /** Number of lane columns the widest row needs. */
  width: number
}

function timeOf(commit: GraphCommit): number {
  const time = Date.parse(commit.date)
  return Number.isNaN(time) ? 0 : time
}

/**
 * Deduplicates by SHA and orders children before parents, newest first among the commits that are free
 * to go next.
 *
 * A plain date sort is not enough: committer dates are set by the committer's clock and survive rebases,
 * so a parent can carry a later date than its child, and the lane layout below would then meet a parent
 * before the line that leads to it. Topological order is what makes every line go downward.
 */
export function sortCommitsTopologically(commits: GraphCommit[]): GraphCommit[] {
  const bySha = new Map<string, GraphCommit>()
  for (const commit of commits) if (!bySha.has(commit.sha)) bySha.set(commit.sha, commit)

  const pendingChildren = new Map<string, number>()
  for (const commit of bySha.values()) {
    for (const parent of new Set(commit.parents)) {
      if (bySha.has(parent)) pendingChildren.set(parent, (pendingChildren.get(parent) ?? 0) + 1)
    }
  }

  const remaining = new Set(bySha.values())
  const ordered: GraphCommit[] = []
  while (remaining.size > 0) {
    let next: GraphCommit | undefined
    let fallback: GraphCommit | undefined
    for (const commit of remaining) {
      if (!fallback || timeOf(commit) > timeOf(fallback)) fallback = commit
      if ((pendingChildren.get(commit.sha) ?? 0) > 0) continue
      if (!next || timeOf(commit) > timeOf(next)) next = commit
    }
    // Git history is acyclic, but this is data from the network: if it ever is not, emit the newest
    // remaining commit rather than spin forever.
    const chosen = next ?? fallback!
    remaining.delete(chosen)
    ordered.push(chosen)
    for (const parent of new Set(chosen.parents)) {
      const pending = pendingChildren.get(parent)
      if (pending !== undefined) pendingChildren.set(parent, pending - 1)
    }
  }
  return ordered
}

/**
 * Assigns every commit a lane and records which lines cross each row.
 *
 * The classic single-pass scheme: `lanes[i]` holds the SHA lane `i` is waiting for. A commit takes the
 * leftmost lane waiting for it (or the first free one, for a branch tip nothing points at yet), every
 * other lane waiting for it ends there, and its parents are handed out — the first parent continues in
 * the commit's own lane, the rest join a lane already waiting for them or open a new one. Freed lanes are
 * reused, so the graph is as wide as the most branches alive at once, not as the number ever drawn.
 */
export function layoutCommitGraph(data: Pick<CommitGraphData, 'commits' | 'branches'>): CommitGraphLayout {
  const commits = sortCommitsTopologically(data.commits)
  const known = new Set(commits.map((commit) => commit.sha))

  const refsBySha = new Map<string, string[]>()
  for (const branch of data.branches) {
    const refs = refsBySha.get(branch.sha) ?? []
    refs.push(branch.name)
    refsBySha.set(branch.sha, refs)
  }

  const lanes: (string | null)[] = []
  const freeLane = () => {
    const index = lanes.indexOf(null)
    return index === -1 ? lanes.length : index
  }

  let width = 0
  const rows: GraphRow[] = commits.map((commit) => {
    const incoming: number[] = []
    const through: number[] = []
    lanes.forEach((waitingFor, index) => {
      if (waitingFor === commit.sha) incoming.push(index)
      else if (waitingFor !== null) through.push(index)
    })

    const column = incoming.length > 0 ? incoming[0] : freeLane()
    for (const index of incoming) lanes[index] = null
    lanes[column] = null

    const outgoing: number[] = []
    let truncated = false
    commit.parents.forEach((parent, position) => {
      if (!known.has(parent)) {
        truncated = true
        return
      }
      const waiting = lanes.indexOf(parent)
      if (waiting !== -1) {
        // Another line already leads to this parent: join it instead of opening a parallel lane.
        if (!outgoing.includes(waiting)) outgoing.push(waiting)
        return
      }
      const lane = position === 0 && lanes[column] === null ? column : freeLane()
      lanes[lane] = parent
      outgoing.push(lane)
    })

    // Trailing free lanes do not count towards the width the next rows need.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    width = Math.max(width, column + 1, ...incoming.map((i) => i + 1), ...through.map((i) => i + 1),
      ...outgoing.map((i) => i + 1))
    return { commit, column, through, incoming, outgoing, truncated, refs: refsBySha.get(commit.sha) ?? [] }
  })

  return { rows, width }
}
