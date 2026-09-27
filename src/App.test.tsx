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
 * The same repository as TWO — GitHub resolves owner/repo case-insensitively, and so does
 * `sameRepoRef`. A store written before repository identity was case-insensitive can hold both rows,
 * with different settings, which is the state the removal test below is about.
 */
const TWO_SHOUTED: RepoRef = { owner: 'ACME', repo: 'TWO', autoTrigger: false }
/**
 * A *different* repository that happens to share TWO's name. The negative control for the removal
 * test: identity is the `owner/repo` pair, and without a row like this one an implementation that
 * compared repo names alone would pass every assertion in this file.
 */
const OTHER_TWO: RepoRef = { owner: 'other', repo: 'two' }

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

/** The sidebar entry that swaps the main pane for the global settings form. */
function globalSettingsNav() {
  return screen.getByRole('button', { name: 'Global settings' })
}

/**
 * The GitHub token field inside the global settings pane. `GlobalSettings` renders it on its first
 * synchronous render — only the provider cards below it wait on a read — so a plain query is enough
 * once the pane is open.
 */
function tokenField() {
  return screen.getByPlaceholderText('ghp_...')
}

/** Fills the sidebar's Add form and submits it. Resolves as soon as the click is dispatched. */
async function submitAdd(user: ReturnType<typeof userEvent.setup>, repo: RepoRef) {
  await user.click(screen.getByRole('button', { name: '+ Add' }))
  await user.type(screen.getByPlaceholderText('owner'), repo.owner)
  await user.type(screen.getByPlaceholderText('repo'), repo.repo)
  await user.click(screen.getByRole('button', { name: 'Add' }))
}

/**
 * Waits for `addRepo` to have fully resolved. Sidebar clears and closes the Add form only after the
 * promise settles, so the disappearing `owner` input is the signal that every continuation which could
 * still navigate has run — a `waitFor` on the assertion itself would pass before it did.
 */
function addSettled() {
  return waitFor(() => expect(screen.queryByPlaceholderText('owner')).toBeNull())
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

    await submitAdd(user, TWO)

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
   * Honest about its reach: every repository here has a distinct identity, so the list it asserts on
   * is the same one an index-based removal would produce — `removal drops every row naming the
   * repository` below is what pins that. And with selection stored by identity, two mechanisms agree
   * on where the operator lands (the handler's fallback, and the reconciliation effect that re-points
   * a selection whose repository has left the list), so deleting either alone leaves this green.
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
   * Remove has to delete by repository identity, not by array position.
   *
   * A store written before identity was case-insensitive can hold one repository twice under
   * different spellings, each row carrying its own settings. Dropping only the selected row hands
   * core a list that still names the repository: "Remove" leaves it tracked, and the surviving row's
   * settings take over — here that means re-enabling the unattended polling the operator had switched
   * off, on the project they just tried to delete.
   *
   * Every other fixture in this file uses distinct repositories, so an index-based removal produces
   * the identical list and the regression goes unnoticed. This is the one that discriminates, on both
   * axes of the identity: `ACME/TWO` must go with `acme/two` (same repository, different spelling),
   * and `other/two` must stay (different repository, same name). Revert the filter to array position,
   * to a case-sensitive compare, or to a repo-name-only compare, and only this test fails.
   */
  it('removes every row naming the repository, not just the selected one', async () => {
    const { stub, user } = await renderApp([ONE, TWO, TWO_SHOUTED, OTHER_TWO, THREE])

    await user.click(sidebarProject(TWO))
    await projectHeading(TWO)
    await openSettings(user)
    await user.click(screen.getByRole('button', { name: 'Remove acme/two' }))
    await user.click(screen.getByRole('button', { name: 'Confirm remove' }))

    expect(await projectHeading(ONE)).toBeInTheDocument()
    expect(stub.setRepos).toHaveBeenCalledWith([ONE, OTHER_TWO, THREE])
    expect(stub.storedRepos()).toEqual([ONE, OTHER_TWO, THREE])
    expect(screen.queryByRole('button', { name: 'acme/two' })).toBeNull()
    expect(screen.queryByRole('button', { name: /ACME\/TWO/ })).toBeNull()
    expect(sidebarProject(OTHER_TWO)).toBeInTheDocument()
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

    await submitAdd(user, THREE)

    // Still checking access. The operator loses patience and goes back to the first project.
    expect(screen.getByRole('button', { name: 'Checking access…' })).toBeInTheDocument()
    await user.click(sidebarProject(ONE))
    expect(await projectHeading(ONE)).toBeInTheDocument()

    release()
    await addSettled()

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

/**
 * Registering a repository must not switch the main pane away from the global settings form.
 *
 * `App` mounts `GlobalSettings` from a ternary, and that component keeps the GitHub token and every
 * provider's API key in component state until "Save changes" is pressed. So a view switch is not a
 * cosmetic annoyance here: it unmounts the form and discards credentials the operator pasted, with no
 * warning and nothing to undo — they are most likely to believe those were kept.
 *
 * Both halves of `addRepo`'s guard are covered because they answer different questions and either can
 * be removed without the other noticing. The navigation counter sees a move made *during* the add;
 * the starting view sees an add submitted from a sidebar form that is visible from the settings pane
 * too, where nobody moves at all.
 */
describe('App repository add and unsaved global settings', () => {
  /** Not token-shaped on purpose: a fixture should never look like a credential to a secret scanner. */
  const DRAFT_TOKEN = 'pasted-but-not-yet-saved'

  it('stays in global settings when an add started from a project lands', async () => {
    const { stub, user } = await renderApp([ONE])
    let release!: () => void
    const preflight = new Promise<void>((resolve) => {
      release = resolve
    })
    stub.setRepos.mockImplementationOnce(async (next: RepoRef[]) => {
      await preflight
      stub.applyRepos(next)
      return []
    })

    await submitAdd(user, TWO)

    // Still checking access. The operator uses the wait to paste a token, and does not press Save.
    expect(screen.getByRole('button', { name: 'Checking access…' })).toBeInTheDocument()
    await user.click(globalSettingsNav())
    await user.type(tokenField(), DRAFT_TOKEN)

    release()
    await addSettled()

    expect(screen.getByRole('heading', { name: 'Global settings' })).toBeInTheDocument()
    expect(tokenField()).toHaveValue(DRAFT_TOKEN)
    expect(screen.queryByRole('heading', { name: 'acme/two' })).toBeNull()
    // The registration itself still has to have happened — declining to navigate is not declining to add.
    expect(sidebarProject(TWO)).toBeInTheDocument()
    expect(stub.storedRepos()).toEqual([ONE, TWO])
  })

  it('stays in global settings when the add was submitted from it', async () => {
    const { stub, user } = await renderApp([ONE])

    await user.click(globalSettingsNav())
    await user.type(tokenField(), DRAFT_TOKEN)
    // The Add form lives in the always-visible sidebar, so this add begins and ends without the
    // operator navigating once — which is why the navigation counter alone leaves this case broken.
    await submitAdd(user, TWO)
    await addSettled()

    expect(screen.getByRole('heading', { name: 'Global settings' })).toBeInTheDocument()
    expect(tokenField()).toHaveValue(DRAFT_TOKEN)
    expect(screen.queryByRole('heading', { name: 'acme/two' })).toBeNull()
    expect(sidebarProject(TWO)).toBeInTheDocument()
    expect(stub.storedRepos()).toEqual([ONE, TWO])
  })

  /**
   * The already-tracked branch returns before it ever writes, and it navigates from its own guard, so
   * the registration test above says nothing about it. Re-adding under a different capitalisation is
   * the shortest route into it — one repository to GitHub, to `sameRepoRef`, and to core — and
   * `setRepos` never being called is what proves this test took that branch rather than the other one.
   */
  it('stays in global settings when the add names an already tracked repository', async () => {
    const { stub, user } = await renderApp([ONE, TWO])

    await user.click(globalSettingsNav())
    await user.type(tokenField(), DRAFT_TOKEN)
    await submitAdd(user, TWO_SHOUTED)
    await addSettled()

    expect(screen.getByRole('heading', { name: 'Global settings' })).toBeInTheDocument()
    expect(tokenField()).toHaveValue(DRAFT_TOKEN)
    expect(screen.queryByRole('heading', { name: 'acme/two' })).toBeNull()
    expect(stub.setRepos).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'ACME/TWO' })).toBeNull()
  })
})
