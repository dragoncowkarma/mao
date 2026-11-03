import { describe, expect, it } from 'vitest'
import { layoutCommitGraph, sortCommitsTopologically, type GraphBranch, type GraphCommit } from './commit-graph.ts'

let clock = 0
/** Each call is one minute newer than the last, so declaration order is date order unless overridden. */
function commit(sha: string, parents: string[] = [], date?: string): GraphCommit {
  clock += 1
  return {
    sha,
    parents,
    message: `commit ${sha}`,
    author: 'octocat',
    date: date ?? new Date(Date.UTC(2026, 0, 1, 0, clock)).toISOString(),
    url: `https://github.com/acme/widgets/commit/${sha}`,
  }
}

function layout(commits: GraphCommit[], branches: GraphBranch[] = []) {
  return layoutCommitGraph({ commits, branches })
}

function order(commits: GraphCommit[]) {
  return layout(commits).rows.map((row) => row.commit.sha)
}

describe('sortCommitsTopologically', () => {
  it('orders newest first for a linear history', () => {
    const a = commit('a')
    const b = commit('b', ['a'])
    const c = commit('c', ['b'])
    expect(sortCommitsTopologically([a, c, b]).map((x) => x.sha)).toEqual(['c', 'b', 'a'])
  })

  it('keeps a child above its parent even when the parent carries a later date', () => {
    // A rebased or clock-skewed commit: the parent is "newer" than its own child.
    const parent = commit('parent', [], '2026-05-01T00:00:00Z')
    const child = commit('child', ['parent'], '2026-01-01T00:00:00Z')
    expect(sortCommitsTopologically([parent, child]).map((x) => x.sha)).toEqual(['child', 'parent'])
  })

  it('drops duplicate SHAs, keeping the first copy', () => {
    const a = commit('a')
    const again = { ...a, message: 'duplicate' }
    const sorted = sortCommitsTopologically([a, again])
    expect(sorted).toHaveLength(1)
    expect(sorted[0].message).toBe('commit a')
  })

  it('terminates on cyclic input instead of spinning', () => {
    const x = commit('x', ['y'])
    const y = commit('y', ['x'])
    expect(sortCommitsTopologically([x, y]).map((c) => c.sha).sort()).toEqual(['x', 'y'])
  })
})

describe('layoutCommitGraph', () => {
  it('draws a linear history in a single lane', () => {
    const a = commit('a')
    const b = commit('b', ['a'])
    const c = commit('c', ['b'])
    const { rows, width } = layout([a, b, c])
    expect(width).toBe(1)
    expect(rows.map((row) => row.column)).toEqual([0, 0, 0])
    expect(rows[0]).toMatchObject({ incoming: [], outgoing: [0], through: [] })
    expect(rows[1]).toMatchObject({ incoming: [0], outgoing: [0] })
    expect(rows[2]).toMatchObject({ incoming: [0], outgoing: [], truncated: false })
  })

  it('opens a second lane for a branch and closes it again at the merge', () => {
    // main: base -> m1 -> merge(m1, f1); feature: base -> f1
    const base = commit('base')
    const f1 = commit('f1', ['base'])
    const m1 = commit('m1', ['base'])
    const merge = commit('merge', ['m1', 'f1'])
    const { rows, width } = layout([base, f1, m1, merge])

    expect(rows.map((row) => row.commit.sha)).toEqual(['merge', 'm1', 'f1', 'base'])
    expect(width).toBe(2)
    // The merge sends its first parent down its own lane and its second into a new one.
    expect(rows[0]).toMatchObject({ column: 0, outgoing: [0, 1] })
    // m1 continues lane 0 while the feature lane passes alongside it.
    expect(rows[1]).toMatchObject({ column: 0, through: [1], outgoing: [0] })
    // f1 sits in lane 1 and joins the lane already waiting for base rather than opening a third.
    expect(rows[2]).toMatchObject({ column: 1, outgoing: [0] })
    // base collects the one line that is still waiting for it.
    expect(rows[3]).toMatchObject({ column: 0, incoming: [0], outgoing: [] })
  })

  it('converges two lanes waiting for the same commit', () => {
    // Two unmerged branch tips forked from the same commit.
    const base = commit('base')
    const left = commit('left', ['base'])
    const right = commit('right', ['base'])
    const { rows } = layout([base, left, right])
    expect(rows.map((row) => row.commit.sha)).toEqual(['right', 'left', 'base'])
    expect(rows[0].column).toBe(0)
    // The second tip finds lane 0 already waiting for base and joins it.
    expect(rows[1]).toMatchObject({ column: 1, through: [0], outgoing: [0] })
    expect(rows[2]).toMatchObject({ incoming: [0], column: 0 })
  })

  it('opens one lane per extra parent of an octopus merge', () => {
    const a = commit('a')
    const b = commit('b')
    const c = commit('c')
    const octopus = commit('octopus', ['a', 'b', 'c'])
    const { rows, width } = layout([a, b, c, octopus])
    expect(rows[0]).toMatchObject({ column: 0, outgoing: [0, 1, 2] })
    expect(width).toBe(3)
  })

  it('marks a commit whose parent lies outside the fetched window as truncated', () => {
    const tip = commit('tip', ['outside'])
    const { rows } = layout([tip])
    expect(rows[0]).toMatchObject({ truncated: true, outgoing: [] })
  })

  it('reuses a freed lane instead of widening the graph', () => {
    // Two branches that merged one after another: the second never needs a third lane.
    const base = commit('base')
    const f1 = commit('f1', ['base'])
    const merge1 = commit('merge1', ['base', 'f1'])
    const f2 = commit('f2', ['merge1'])
    const merge2 = commit('merge2', ['merge1', 'f2'])
    expect(layout([base, f1, merge1, f2, merge2]).width).toBe(2)
  })

  it('starts unrelated roots in their own lanes', () => {
    const r1 = commit('r1')
    const r2 = commit('r2')
    const { rows } = layout([r1, r2])
    expect(rows.map((row) => row.commit.sha)).toEqual(['r2', 'r1'])
    expect(rows.map((row) => row.column)).toEqual([0, 0])
  })

  it('attaches branch names to the commit they point at, in the order given', () => {
    const a = commit('a')
    const b = commit('b', ['a'])
    const { rows } = layout(
      [a, b],
      [
        { name: 'main', sha: 'b' },
        { name: 'workflow/7-x', sha: 'b' },
        { name: 'old', sha: 'a' },
      ],
    )
    expect(rows[0].refs).toEqual(['main', 'workflow/7-x'])
    expect(rows[1].refs).toEqual(['old'])
  })

  it('lays out a clock-skewed child above its parent so the line still runs downward', () => {
    const parent = commit('parent', [], '2026-05-01T00:00:00Z')
    const child = commit('child', ['parent'], '2026-01-01T00:00:00Z')
    const { rows, width } = layout([parent, child])
    expect(rows.map((row) => row.commit.sha)).toEqual(['child', 'parent'])
    // With a plain date sort the parent would be drawn first and the child would open a dangling lane.
    expect(rows[1]).toMatchObject({ incoming: [0], column: 0 })
    expect(width).toBe(1)
  })

  it('handles an empty history', () => {
    expect(layout([])).toEqual({ rows: [], width: 0 })
  })
})
