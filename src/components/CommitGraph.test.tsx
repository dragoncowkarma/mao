import { StrictMode } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from '../App'
import CommitGraph from './CommitGraph'
import { createElectronApiStub } from '../test/electron-api-stub'
import type { CommitGraphData, GraphCommit } from '../../core/commit-graph'
import type { RepoRef } from '../../core/workflow-engine'

const repo: RepoRef = { owner: 'acme', repo: 'widgets' }

function commit(sha: string, parents: string[], message: string, minute: number): GraphCommit {
  return {
    sha,
    parents,
    message,
    author: 'Octo Cat',
    date: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    url: `https://github.com/acme/widgets/commit/${sha}`,
  }
}

const graph: CommitGraphData = {
  defaultBranch: 'main',
  branches: [
    { name: 'main', sha: 'merge000' },
    { name: 'workflow/7-fix', sha: 'feat0000' },
  ],
  commits: [
    commit('base0000', [], 'Initial commit', 1),
    commit('feat0000', ['base0000'], 'Fix the widget', 2),
    commit('merge000', ['base0000', 'feat0000'], 'Merge pull request #8', 3),
  ],
  omittedBranches: 0,
  branchListComplete: true,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('CommitGraph', () => {
  it('lists commits newest first with their branch labels, short SHA and a link to GitHub', async () => {
    const stub = createElectronApiStub()
    stub.fetchCommitGraph.mockResolvedValue(graph)
    render(<CommitGraph repo={repo} />)

    const list = await screen.findByRole('list', { name: 'Commit graph for acme/widgets' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual([
      'Merge pull request #8',
      'Fix the widget',
      'Initial commit',
    ])
    expect(within(rows[0]).getByText('main')).toBeInTheDocument()
    expect(within(rows[1]).getByText('workflow/7-fix')).toBeInTheDocument()
    expect(within(rows[0]).getByText('merge00')).toBeInTheDocument()
    expect(within(rows[0]).getByRole('link').getAttribute('href')).toBe(
      'https://github.com/acme/widgets/commit/merge000',
    )
    expect(screen.getByText('3 commits · 2 branches')).toBeInTheDocument()
    expect(stub.fetchCommitGraph).toHaveBeenCalledWith('acme', 'widgets')
  })

  it('shows the error when the graph cannot be loaded', async () => {
    const stub = createElectronApiStub()
    stub.fetchCommitGraph.mockRejectedValue(new Error('GitHub token is not set'))
    render(<CommitGraph repo={repo} />)
    expect(await screen.findByText('GitHub token is not set')).toBeInTheDocument()
  })

  it('says how many branches it left out instead of passing the window off as the whole history', async () => {
    const stub = createElectronApiStub()
    stub.fetchCommitGraph.mockResolvedValue({ ...graph, omittedBranches: 5, branchListComplete: false })
    render(<CommitGraph repo={repo} />)
    expect(await screen.findByText(/at least 5 more not drawn/)).toBeInTheDocument()
  })

  it('reloads on Refresh', async () => {
    const stub = createElectronApiStub()
    stub.fetchCommitGraph.mockResolvedValueOnce({ ...graph, commits: graph.commits.slice(0, 1) })
    const user = userEvent.setup()
    render(<CommitGraph repo={repo} />)
    await screen.findByText('Initial commit')
    expect(screen.queryByText('Fix the widget')).toBeNull()

    stub.fetchCommitGraph.mockResolvedValueOnce(graph)
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Fix the widget')).toBeInTheDocument()
  })

  it('drops a slow answer for the previous repository after a project switch', async () => {
    const stub = createElectronApiStub()
    const slow = deferred<CommitGraphData>()
    stub.fetchCommitGraph.mockImplementationOnce(() => slow.promise)
    const other: CommitGraphData = { ...graph, commits: [commit('other000', [], 'Other repo commit', 9)], branches: [] }
    stub.fetchCommitGraph.mockResolvedValueOnce(other)

    const { rerender } = render(<CommitGraph repo={repo} />)
    rerender(<CommitGraph repo={{ owner: 'acme', repo: 'gadgets' }} />)
    await screen.findByText('Other repo commit')

    slow.resolve(graph)
    await stub.fetchCommitGraph.mock.results[0].value
    // Let the stale continuation run, then confirm it changed nothing.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('Merge pull request #8')).toBeNull()
    expect(screen.getByText('Other repo commit')).toBeInTheDocument()
  })
})

describe('App Graph tab', () => {
  it('opens the selected project graph from its own tab', async () => {
    const stub = createElectronApiStub([repo])
    stub.fetchCommitGraph.mockResolvedValue(graph)
    const user = userEvent.setup()
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    await user.click(await screen.findByRole('button', { name: 'Graph' }))
    expect(await screen.findByRole('list', { name: 'Commit graph for acme/widgets' })).toBeInTheDocument()
    expect(stub.fetchCommitGraph).toHaveBeenCalledWith('acme', 'widgets')
  })
})
