import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'
import { createElectronApiStub } from './test/electron-api-stub'
import type { RepoRef } from '../core/workflow-engine'

const ONE: RepoRef = { owner: 'acme', repo: 'one' }
const TWO: RepoRef = { owner: 'acme', repo: 'two' }
const THREE: RepoRef = { owner: 'acme', repo: 'three' }

/**
 * Mounts the real App against a fake bridge, inside StrictMode because that is what `src/main.tsx`
 * does. The doubled mount/unmount is a development-and-test check — the packaged build runs effects
 * once — but it is the check AGENTS.md requires polling effects to survive, so running tests under it
 * is what turns that rule into something observed rather than asserted. The price is that every
 * mount-path IPC call is made twice: assert on what the operator sees or on `toHaveBeenCalledWith`,
 * never on a bare `toHaveBeenCalledTimes`.
 *
 * Waits for the first project to be on screen before handing control back: App reads the repo list in
 * an effect, so everything a test wants to click is one resolved promise away from the initial render.
 */
async function renderApp(repos: RepoRef[]) {
  const user = userEvent.setup()
  const stub = createElectronApiStub(repos)
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  if (repos.length > 0) await projectHeading(repos[0])
  return { stub, user }
}

/** The `<h2>` naming the open project — distinct from the sidebar button carrying the same text. */
function projectHeading(repo: RepoRef) {
  return screen.findByRole('heading', { name: `${repo.owner}/${repo.repo}` })
}

/** The sidebar row for a project. */
function sidebarProject(repo: RepoRef) {
  return screen.getByRole('button', { name: `${repo.owner}/${repo.repo}` })
}

/** Opens a project's Settings tab, which is the only route to Remove. */
async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Settings' }))
}

describe('App project selection', () => {
  it('opens the project the operator picks in the sidebar', async () => {
    const { user } = await renderApp([ONE, TWO])

    await user.click(sidebarProject(TWO))

    expect(await projectHeading(TWO)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'acme/one' })).toBeNull()
  })

  it('opens a repository it has just added', async () => {
    const { stub, user } = await renderApp([ONE])

    await user.click(screen.getByRole('button', { name: '+ Add' }))
    await user.type(screen.getByPlaceholderText('owner'), 'acme')
    await user.type(screen.getByPlaceholderText('repo'), 'two')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(await projectHeading(TWO)).toBeInTheDocument()
    expect(stub.setRepos).toHaveBeenCalledWith([ONE, TWO])
    expect(stub.storedRepos()).toEqual([ONE, TWO])
  })

  it('falls back to the first project when the selected one is removed', async () => {
    const { stub, user } = await renderApp([ONE, TWO])

    await user.click(sidebarProject(TWO))
    await projectHeading(TWO)
    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Remove acme/two' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }))

    expect(await projectHeading(ONE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'acme/two' })).toBeNull()
    expect(stub.setRepos).toHaveBeenCalledWith([ONE])
  })

  /**
   * The three-repository case, where the removed row is neither the fallback nor the last entry, so
   * "ends up on the first project" and "ends up on a neighbour" are distinguishable outcomes.
   *
   * Honest about its reach: with selection stored by identity, two mechanisms agree here — the
   * handler's fallback and the reconciliation effect that re-points a selection whose repository has
   * left the list — and deleting either one alone leaves this green. What it pins that nothing else
   * does is the list actually written: removal is by identity, not by array position.
   */
  it('falls back to the first project when a middle project is removed', async () => {
    const { stub, user } = await renderApp([ONE, TWO, THREE])

    await user.click(sidebarProject(TWO))
    await projectHeading(TWO)
    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Remove acme/two' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }))

    expect(await projectHeading(ONE)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'acme/two' })).toBeNull()
    expect(sidebarProject(THREE)).toBeInTheDocument()
    expect(stub.setRepos).toHaveBeenCalledWith([ONE, THREE])
  })

  /**
   * The race the GUI actually runs into: registering a repository preflights its write access over
   * the network and `updateRepos` serializes every list write behind it, so `await persistRepos(...)`
   * can stay pending for seconds — during which the sidebar is live and the operator can, and does,
   * click another project. Opening the repository just registered is a convenience; it must lose to a
   * later explicit choice.
   */
  it('keeps a selection the operator made while a slow add was in flight', async () => {
    const { stub, user } = await renderApp([ONE, TWO])
    let release!: () => void
    const preflight = new Promise<void>((resolve) => {
      release = resolve
    })
    stub.setRepos.mockImplementationOnce(async (next: RepoRef[]) => {
      await preflight
      stub.applyRepos(next)
      return []
    })

    await user.click(screen.getByRole('button', { name: '+ Add' }))
    await user.type(screen.getByPlaceholderText('owner'), 'acme')
    await user.type(screen.getByPlaceholderText('repo'), 'three')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    // Still checking access. The operator loses patience and goes back to the first project.
    expect(screen.getByRole('button', { name: 'Checking access…' })).toBeInTheDocument()
    await user.click(sidebarProject(ONE))
    expect(await projectHeading(ONE)).toBeInTheDocument()

    release()
    // The add form closes only after `addRepo` has fully resolved, so this waits for the continuation
    // that would overwrite the selection rather than racing it.
    await waitFor(() => expect(screen.queryByPlaceholderText('owner')).toBeNull())

    expect(sidebarProject(THREE)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'acme/one' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'acme/three' })).toBeNull()
  })

  /**
   * The removal twin. It needs its own test because the add path's guard being right says nothing
   * about this one: removal keeps the operator's choice by picking its fallback *before* the await,
   * which is a different mechanism that a refactor could quietly undo by moving one line below it.
   *
   * Removing a middle row is again what makes the assertion mean something — the fallback lands on
   * the first project, so a selection that survives on the third can only have survived deliberately.
   */
  it('keeps a selection the operator made while a slow removal was in flight', async () => {
    const { stub, user } = await renderApp([ONE, TWO, THREE])
    let release!: () => void
    const write = new Promise<void>((resolve) => {
      release = resolve
    })
    stub.setRepos.mockImplementationOnce(async (next: RepoRef[]) => {
      await write
      stub.applyRepos(next)
      return []
    })

    await user.click(sidebarProject(TWO))
    await projectHeading(TWO)
    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Remove acme/two' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }))

    // `persistRepos` mirrors optimistically, so the row is already gone from the sidebar while the
    // store write is still pending. The operator opens the third project instead of the fallback.
    await user.click(sidebarProject(THREE))
    expect(await projectHeading(THREE)).toBeInTheDocument()

    // The completion's only remaining act is to re-read the store, so an extra `getRepos` is the
    // signal that it ran — a `waitFor` on the selection itself would pass before it did.
    const readsBefore = stub.getRepos.mock.calls.length
    release()
    await waitFor(() => expect(stub.getRepos.mock.calls.length).toBeGreaterThan(readsBefore))

    expect(screen.getByRole('heading', { name: 'acme/three' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'acme/one' })).toBeNull()
    expect(stub.setRepos).toHaveBeenCalledWith([ONE, THREE])
  })
})
