import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import { createElectronApiStub } from './test/electron-api-stub'
import type { RepoRef } from '../core/workflow-engine'
import type { StoredValueProblem } from '../core/store'

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
 * What the main process answers `app:storeProblems` with when `config.json` holds a `githubRepos` the
 * schema cannot use. Spelled out rather than built from core's own describer: `core/store.ts` is a
 * Node module the renderer may not import, and the renderer's job here is to render what it is handed,
 * whatever the wording turns out to be.
 */
const UNUSABLE_REPO_LIST: StoredValueProblem = {
  field: 'githubRepos',
  source: '/data/config.json',
  message:
    '[store] "githubRepos" in /data/config.json is an object, not a JSON array of { owner, repo } ' +
    'entries — ignoring it, so no repositories are tracked until it is replaced.',
}

/**
 * A report about a field this sidebar's reset does not touch. The reset deletes `githubRepos` and
 * nothing else, and `describeStoredProblems` is written to grow to the other array-typed fields
 * (issue #68) — so the card has to tell the difference before it offers a destructive button.
 */
const UNUSABLE_PROVIDERS: StoredValueProblem = {
  field: 'aiProviders',
  source: '/data/config.json',
  message: '[store] "aiProviders" in /data/config.json is an object, not a JSON array of providers.',
}

/**
 * What the main process answers for a `config.json` whose `workflowTasks` the schema cannot use.
 *
 * Spelled out rather than imported from core for the same reason as the fixtures above, and it carries
 * the halt wording because that is what the engine's latch holds verbatim — the operator reads the same
 * paragraph here, in `mao run`'s refusal, and in every refused queue action.
 */
const UNUSABLE_QUEUE: StoredValueProblem = {
  field: 'workflowTasks',
  source: '/data/config.json',
  message:
    '[store] "workflowTasks" in /data/config.json is an object, not a JSON array of queued workflow ' +
    'tasks — ignoring it, so the queue is empty and MAO will not start unattended work.',
}

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
async function renderApp(repos: RepoRef[], problems: StoredValueProblem[] = []) {
  const user = userEvent.setup()
  const stub = createElectronApiStub(repos, problems)
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

describe('App unusable stored settings', () => {
  it('tells the operator what was discarded instead of showing an empty project list', async () => {
    // The gap this closes: a `githubRepos` the schema cannot use reaches the renderer as `[]`, so the
    // sidebar said "No projects yet — add a repository to get started" — indistinguishable from having
    // none, while the only report went to a main-process console a packaged-app operator never sees.
    await renderApp([], [UNUSABLE_REPO_LIST])

    expect(await screen.findByText(/is an object, not a JSON array/)).toBeInTheDocument()
    expect(screen.getByText(/could not be read/)).toBeInTheDocument()
    expect(screen.queryByText(/No projects yet/)).toBeNull()
  })

  it('offers a recovery the operator can actually reach, and it needs no token', async () => {
    // With no usable list there is no sidebar row, so no project is selected and the Settings tab's
    // Remove button never renders — the recovery the store's own report used to name was unreachable.
    // Writing an empty list registers nothing, so unlike Add it is never refused by the preflight.
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))

    await waitFor(() => expect(screen.queryByText(/is an object, not a JSON array/)).toBeNull())
    expect(stub.setRepos).toHaveBeenCalledWith([])
    expect(stub.storedRepos()).toEqual([])
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument()
  })

  it('keeps the report up when the recovery write itself fails', async () => {
    // A refused write leaves the unusable value on disk, so clearing the notice optimistically would
    // tell the operator the problem was fixed when nothing had changed.
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)
    stub.setRepos.mockRejectedValueOnce(new Error("Error invoking remote method 'github:setRepos': Error: disk is full"))

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))

    expect(await screen.findByText('disk is full')).toBeInTheDocument()
    expect(screen.getByText(/is an object, not a JSON array/)).toBeInTheDocument()
  })

  it('re-reads the report after a write that failed, rather than just leaving it alone', async () => {
    // Asserted through Add, not the reset: the reset re-reads on its own before it writes, so a delta
    // measured there would be its pre-check rather than `persistRepos`' `finally`. A report that
    // survives only because nothing cleared it goes stale the first time a failure and a heal happen in
    // either order. The 30s poll cannot have fired inside a test this short, so the delta is
    // attributable to the write.
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)
    stub.setRepos.mockRejectedValueOnce(new Error('acme/one cannot host the MAO workflow'))
    const readsBefore = stub.storeProblems.mock.calls.length

    await submitAdd(user, ONE)

    expect(await screen.findByText('acme/one cannot host the MAO workflow')).toBeInTheDocument()
    await waitFor(() => expect(stub.storeProblems.mock.calls.length).toBeGreaterThan(readsBefore))
  })

  it('refuses to reset a store something else has already healed', async () => {
    // The store is not this window's alone: the report tells the operator to go to `config.json`, and
    // `mao repos add` in a terminal heals it — while this card, read at mount and after writes, keeps
    // offering a button that writes an empty list. Blind, that deletes the healthy list they just built.
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)
    stub.storeProblems.mockResolvedValue([])
    stub.applyRepos([ONE])

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))

    await waitFor(() => expect(screen.queryByText(/is an object, not a JSON array/)).toBeNull())
    expect(stub.setRepos).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'acme/one' })).toBeInTheDocument()
  })

  it('offers no reset for a report about a field the reset does not touch', async () => {
    // Today the guard checks only `githubRepos`, so this state is not yet reachable — which is why it is
    // pinned now rather than discovered when a second field joins it and an `aiProviders` message ends
    // up sitting above a button that wipes every tracked repository.
    await renderApp([], [UNUSABLE_PROVIDERS])

    expect(await screen.findByText(/"aiProviders" in/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset stored list' })).toBeNull()
    expect(screen.getByText(/No projects yet/)).toBeInTheDocument()
  })

  it('offers the reset when the repo list is one of several unusable values', async () => {
    // Both fixtures, with the unrelated one first: with a single report on screen, a positional check
    // (`storeProblems[0].field === 'githubRepos'`) satisfies every other test in this file, and the
    // mixed state is the one it gets wrong — which is the state issue #68 makes reachable.
    const { user } = await renderApp([], [UNUSABLE_PROVIDERS, UNUSABLE_REPO_LIST])

    // Matched by field, because both fixture messages say "is an object, not a JSON array".
    expect(await screen.findByText(/"aiProviders" in/)).toBeInTheDocument()
    expect(screen.getByText(/"githubRepos" in/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))

    expect(screen.getByRole('button', { name: 'Confirm reset' })).toBeInTheDocument()
  })

  it('clears a failed reset when the operator backs out', async () => {
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)
    stub.setRepos.mockRejectedValueOnce(new Error('disk is full'))

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))
    expect(await screen.findByText('disk is full')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    // A failure message left under an un-pressed button misreports the state of an action the operator
    // explicitly backed out of.
    expect(screen.queryByText('disk is full')).toBeNull()
  })

  it('does not pretend a queued reset can be called back', async () => {
    // The write is already queued behind `updateRepos`' serialization by the time this renders, and
    // nothing can recall it — a Cancel that looked live would say otherwise.
    let release = () => {}
    const inFlight = new Promise<void>((resolve) => {
      release = resolve
    })
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)
    stub.setRepos.mockImplementationOnce(async (next: RepoRef[]) => {
      await inFlight
      stub.applyRepos(next)
      return []
    })

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))

    expect(await screen.findByRole('button', { name: 'Resetting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    release()
    await waitFor(() => expect(stub.storedRepos()).toEqual([]))
  })

  it('takes the report down once an add has healed the store', async () => {
    // The other way out, and the one the reviewer's "Add overwrote it before the operator was ever
    // told" case turns on: any list write replaces the unusable value, so the card has to be re-read
    // after every write — not only after the reset that this card owns.
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)

    await submitAdd(user, ONE)
    await addSettled()

    await waitFor(() => expect(screen.queryByText(/is an object, not a JSON array/)).toBeNull())
    expect(stub.setRepos).toHaveBeenCalledWith([ONE])
  })

  it('reports the write failure even when the diagnostic read throws', async () => {
    // `refreshStoreProblems` runs in `persistRepos`' `finally`, and a synchronous throw there *replaces*
    // the rejection already on its way to the caller — the operator would be told the bridge was missing
    // instead of why their write failed. A diagnostic must not be able to hide the thing it annotates.
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)
    stub.setRepos.mockRejectedValueOnce(new Error('acme/one cannot host the MAO workflow'))
    stub.storeProblems.mockImplementation(() => {
      throw new Error('preload bridge did not load')
    })

    await submitAdd(user, ONE)

    expect(await screen.findByText('acme/one cannot host the MAO workflow')).toBeInTheDocument()
    expect(screen.queryByText('preload bridge did not load')).toBeNull()
  })

  it('leaves the operator where they were when the reset lands', async () => {
    // The sidebar is visible from Global settings too, so a reset can be started there — and it
    // finishes two awaits later. Navigating on completion is the race `navigationGeneration` exists to
    // stop, and after a reset there is nothing to navigate to anyway.
    const { stub, user } = await renderApp([], [UNUSABLE_REPO_LIST])
    await screen.findByText(/is an object, not a JSON array/)
    await user.click(globalSettingsNav())
    expect(tokenField()).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reset stored list' }))
    await user.click(screen.getByRole('button', { name: 'Confirm reset' }))

    await waitFor(() => expect(stub.setRepos).toHaveBeenCalledWith([]))
    expect(tokenField()).toBeInTheDocument()
  })

  it('notices a store that became unusable while the window was open', async () => {
    // The file is not this window's to own: the report sends the operator to `config.json`, and a
    // hand-edit made there is invisible until the next repository-list write — which is the thing that
    // destroys the value. Reading it only after a write cannot warn anyone in time.
    //
    // Fake timers here and no `userEvent`: the two deadlock (SKILL.md), so this drives the interval
    // directly and asserts on what the operator sees.
    vi.useFakeTimers()
    try {
      const stub = createElectronApiStub([ONE])
      const { unmount } = render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.queryByText(/could not be read/)).toBeNull()

      stub.storeProblems.mockResolvedValue([UNUSABLE_REPO_LIST])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      expect(screen.getByText(/is an object, not a JSON array/)).toBeInTheDocument()

      // AGENTS.md requires a polling effect to clear its interval; a leaked one is otherwise invisible
      // here, because `refreshStoreProblems` swallows the error an unbound bridge would throw.
      const readsBeforeUnmount = stub.storeProblems.mock.calls.length
      unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(stub.storeProblems.mock.calls.length).toBe(readsBeforeUnmount)
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts a repository list something else repaired while the window was open', async () => {
    // The renderer read the list once, at mount, while the store could not answer — so healing the file
    // from a terminal took the card away and left the sidebar insisting there were no projects. The
    // diagnostic going green while the UI stays broken is worse than either alone.
    vi.useFakeTimers()
    try {
      const stub = createElectronApiStub([], [UNUSABLE_REPO_LIST])
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/"githubRepos" in/)).toBeInTheDocument()

      // `mao repos add acme one` in another terminal: the store now holds a real list and reports nothing.
      stub.applyRepos([ONE])
      stub.storeProblems.mockResolvedValue([])

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      expect(screen.queryByText(/"githubRepos" in/)).toBeNull()
      expect(screen.getByRole('button', { name: 'acme/one' })).toBeInTheDocument()
      expect(screen.queryByText(/No projects yet/)).toBeNull()
      // Selection reconciles too, by identity: the repaired list has an entry and nothing was selected,
      // so the project opens rather than leaving the operator on an empty welcome pane.
      expect(screen.getByRole('heading', { name: 'acme/one' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries the repaired list on the next poll when the first read fails', async () => {
    // The repair transition is observable exactly once, so consuming it before the list is actually in
    // hand spends it: one transient rejection and the sidebar is stuck on "No projects yet" until the
    // window is restarted, with the diagnostic gone and nothing left to say why.
    vi.useFakeTimers()
    try {
      const stub = createElectronApiStub([], [UNUSABLE_REPO_LIST])
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/"githubRepos" in/)).toBeInTheDocument()

      stub.applyRepos([ONE])
      stub.storeProblems.mockResolvedValue([])
      stub.getRepos.mockRejectedValueOnce(new Error('main process is busy'))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(screen.queryByRole('button', { name: 'acme/one' })).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      expect(screen.getByRole('button', { name: 'acme/one' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a repaired list a newer observation has already superseded', async () => {
    // Repairs are observed on a 30s poll but adopted through a read that takes its own time, so the two
    // can interleave: a read started for one repair can land after the store has broken and been
    // repaired again. Applying it then would both show the list from before the second repair and spend
    // the latch, so nothing would ever read the current one — and a later list write would persist that
    // stale mirror.
    vi.useFakeTimers()
    try {
      const stub = createElectronApiStub([], [UNUSABLE_REPO_LIST])
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/"githubRepos" in/)).toBeInTheDocument()

      // The first repair is seen, and its read is held open.
      let releaseStale: (repos: RepoRef[]) => void = () => {}
      const stale = new Promise<RepoRef[]>((resolve) => {
        releaseStale = resolve
      })
      stub.storeProblems.mockResolvedValue([])
      stub.getRepos.mockImplementationOnce(() => stale)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      // While it is still in flight the store breaks again, and is then repaired to a different list.
      stub.storeProblems.mockResolvedValue([UNUSABLE_REPO_LIST])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      stub.applyRepos([TWO])
      stub.storeProblems.mockResolvedValue([])

      // The held read answers at last, with the list from before the second repair.
      await act(async () => {
        releaseStale([ONE])
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.queryByRole('button', { name: 'acme/one' })).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      expect(screen.getByRole('button', { name: 'acme/two' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("discards a repaired list this window's own write has superseded", async () => {
    // The other half of the same race: the newer information is not a report but a write from here.
    // `fireEvent` rather than `userEvent` because fake timers are needed to drive the poll and the two
    // deadlock (SKILL.md).
    vi.useFakeTimers()
    try {
      const stub = createElectronApiStub([], [UNUSABLE_REPO_LIST])
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/"githubRepos" in/)).toBeInTheDocument()

      let releaseStale: (repos: RepoRef[]) => void = () => {}
      const stale = new Promise<RepoRef[]>((resolve) => {
        releaseStale = resolve
      })
      stub.storeProblems.mockResolvedValue([])
      stub.getRepos.mockImplementationOnce(() => stale)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      // The operator registers a repository while that read is still in flight.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
      })
      await act(async () => {
        fireEvent.change(screen.getByPlaceholderText('owner'), { target: { value: ONE.owner } })
        fireEvent.change(screen.getByPlaceholderText('repo'), { target: { value: ONE.repo } })
        fireEvent.click(screen.getByRole('button', { name: 'Add' }))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(stub.setRepos).toHaveBeenCalledWith([ONE])

      // The held read answers with the list from before that write.
      await act(async () => {
        releaseStale([])
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.getByRole('button', { name: 'acme/one' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a repair read that a later one has already answered', async () => {
    // Two reads started while the report said the same thing share a generation, so ordering them needs
    // more than that check: whichever *finishes* last would otherwise win, and an older answer landing
    // late rolls the sidebar back to a list that is no longer what the store holds.
    vi.useFakeTimers()
    try {
      const stub = createElectronApiStub([], [UNUSABLE_REPO_LIST])
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/"githubRepos" in/)).toBeInTheDocument()

      let releaseFirst: (repos: RepoRef[]) => void = () => {}
      let releaseSecond: (repos: RepoRef[]) => void = () => {}
      const first = new Promise<RepoRef[]>((resolve) => {
        releaseFirst = resolve
      })
      const second = new Promise<RepoRef[]>((resolve) => {
        releaseSecond = resolve
      })
      stub.storeProblems.mockResolvedValue([])
      stub.getRepos.mockImplementationOnce(() => first).mockImplementationOnce(() => second)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      // The newer answer lands first; the older one arrives after it.
      await act(async () => {
        releaseSecond([TWO])
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        releaseFirst([ONE])
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(screen.getByRole('button', { name: 'acme/two' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'acme/one' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds a repair read back while this window is writing the list', async () => {
    // A settings edit's success path deliberately does not re-read the list, so a repair read that slips
    // in *during* that write and answers with the pre-write list has the last word — the store keeps the
    // new interval while the pane shows the old one, and the next full list write puts the old one back.
    vi.useFakeTimers()
    try {
      const stub = createElectronApiStub([ONE])
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
      })
      expect(screen.getByRole('spinbutton')).toHaveValue(30)

      // The store breaks, is repaired, and the first repair read fails — leaving a retry pending.
      stub.storeProblems.mockResolvedValue([UNUSABLE_REPO_LIST])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      stub.storeProblems.mockResolvedValue([])
      stub.getRepos.mockRejectedValueOnce(new Error('main process is busy'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      // A slow settings write, with a poll landing in the middle of it.
      let releaseWrite: () => void = () => {}
      const written = new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      stub.setRepos.mockImplementationOnce(async (next: RepoRef[]) => {
        await written
        stub.applyRepos(next)
        return []
      })
      await act(async () => {
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '60' } })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      await act(async () => {
        releaseWrite()
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(stub.storedRepos()).toEqual([{ ...ONE, pollIntervalMs: 60_000 }])
      expect(screen.getByRole('spinbutton')).toHaveValue(60)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still adopts a repair after an earlier write has finished', async () => {
    // The other side of holding adoption back during a write: the hold has to be released. Leak it and
    // the window never adopts another repair for the rest of its life, which is a worse failure than the
    // race it exists to prevent — and an invisible one, since nothing else re-reads the list.
    vi.useFakeTimers()
    try {
      const stub = createElectronApiStub([ONE])
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
      })

      // An ordinary settings write, start to finish.
      await act(async () => {
        fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '45' } })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(stub.setRepos).toHaveBeenCalledWith([{ ...ONE, pollIntervalMs: 45_000 }])

      // Only afterwards does the store break, and then get repaired to a different list.
      stub.storeProblems.mockResolvedValue([UNUSABLE_REPO_LIST])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(screen.getByText(/"githubRepos" in/)).toBeInTheDocument()

      stub.applyRepos([TWO])
      stub.storeProblems.mockResolvedValue([])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })

      expect(screen.getByRole('button', { name: 'acme/two' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says nothing when the store is healthy', async () => {
    await renderApp([ONE])

    expect(screen.queryByText(/could not be read/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reset stored list' })).toBeNull()
  })
})

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

  /**
   * The already-tracked fast path, in its positive direction.
   *
   * `addRepo` decides new-versus-tracked against what the *store* holds rather than this component's
   * mirror, which is read once at mount — so a repository registered by `mao repos add` in a terminal
   * since then is already tracked even though nothing on screen shows it. The branch adopts that
   * authoritative list and opens the repository instead of returning silently, because leaving the
   * mirror stale would hide a project that really is being tracked and polled until the app restarts.
   *
   * Nothing else in this file reaches that branch with the navigation guard satisfied: the
   * global-settings test below exercises the same branch but asserts its *declined* half. Delete the
   * guarded block at the early return and every other test here stays green — only this one fails.
   *
   * The case variant is what makes `projectHeading(TWO)` mean something: the board has to show the
   * stored spelling — the one the preflight vouched for — not the one just typed into the form.
   */
  it('opens an already tracked repository the renderer had never seen', async () => {
    const { stub, user } = await renderApp([ONE])

    // Registered elsewhere after this renderer mounted. The mirror still holds only ONE; the store is
    // what `addRepo` asks, and it already has both.
    stub.applyRepos([ONE, TWO])

    await submitAdd(user, TWO_SHOUTED)

    expect(await projectHeading(TWO)).toBeInTheDocument()
    expect(sidebarProject(TWO)).toBeInTheDocument()
    // The fast path returns before it writes, so a persisted list would mean it took the wrong branch.
    expect(stub.setRepos).not.toHaveBeenCalled()
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

/**
 * The GUI half of issue #68: a halted host has to say so, and has to offer a way out that is reachable.
 *
 * Reachable matters literally — an unusable `githubRepos` can sit in the same file, leaving no sidebar
 * row, no selected project and therefore no Settings tab. So the card renders above the project list,
 * exactly where the repo-list reset does.
 */
describe('App halted workflow queue', () => {
  it('shows the store report and offers a two-step discard', async () => {
    const { user, stub } = await renderApp([], [UNUSABLE_QUEUE])

    expect(await screen.findByText(/MAO will not start unattended work/)).toBeInTheDocument()
    // Two-step, like the repo-list reset: this write discards whatever the file held for the queue.
    await user.click(await screen.findByRole('button', { name: 'Discard unreadable queue' }))
    expect(stub.confirmQueueRecovery).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Confirm discard' }))

    await waitFor(() => expect(stub.confirmQueueRecovery).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/MAO will not start unattended work/)).toBeNull())
  })

  it('refuses to overwrite a queue something else already repaired, and says to restart', async () => {
    // The latch is monotone, so after a repair made outside this window the store reads clean while this
    // session still holds the coerced empty queue. Core answers `already-readable` and writes nothing;
    // the operator has to be told that a restart — not another click — is what loads the real queue.
    // (That the button is not even *offered* in that state is a prop-level rule, pinned in
    // src/components/Sidebar.test.tsx where it can be asserted without waiting on a 30s poll.)
    const { user, stub } = await renderApp([], [UNUSABLE_QUEUE])
    stub.confirmQueueRecovery.mockResolvedValue({ kind: 'already-readable' })

    await user.click(await screen.findByRole('button', { name: 'Discard unreadable queue' }))
    await user.click(screen.getByRole('button', { name: 'Confirm discard' }))

    expect(await screen.findByText(/Restart MAO to load it/)).toBeInTheDocument()
    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
  })

  it('keeps the card up and says why when the discard itself fails', async () => {
    const { user, stub } = await renderApp([], [UNUSABLE_QUEUE])
    stub.confirmQueueRecovery.mockResolvedValue({
      kind: 'write-failed',
      reason: 'The replacement write failed, so what reached the config file is unknown.',
    })

    await user.click(await screen.findByRole('button', { name: 'Discard unreadable queue' }))
    await user.click(screen.getByRole('button', { name: 'Confirm discard' }))

    expect(await screen.findByText(/what reached the config file is unknown/)).toBeInTheDocument()
    expect(screen.getByText('Workflow automation is halted')).toBeInTheDocument()
  })

  it('does not print the same report twice', async () => {
    // The latch carries the store's message verbatim, so rendering both the queue card and the generic
    // problems list would show the same paragraph twice in a narrow column.
    await renderApp([], [UNUSABLE_QUEUE])

    expect(await screen.findAllByText(/MAO will not start unattended work/)).toHaveLength(1)
  })

  it('still shows another field report alongside the queue card', async () => {
    await renderApp([], [UNUSABLE_QUEUE, UNUSABLE_PROVIDERS])

    expect(await screen.findByText(/MAO will not start unattended work/)).toBeInTheDocument()
    expect(screen.getByText(/"aiProviders" in \/data\/config.json/)).toBeInTheDocument()
  })

  it('a repo-list read that fails from the very first poll does not suppress the queue card', async () => {
    // The two reads sit on separate chains on purpose: `refreshStoreProblems` ends in one trailing catch
    // covering both halves, so folding the queue read into it would let a throw there hide the one answer
    // that says unattended work is halted. Built by hand rather than through `renderApp` so the failure
    // is already in place at mount — that is what makes this a proof of the separation rather than of
    // state left over from a successful first read.
    const stub = createElectronApiStub([], [UNUSABLE_QUEUE])
    stub.storeProblems.mockRejectedValue(new Error('EACCES: permission denied'))
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    expect(await screen.findByText('Workflow automation is halted')).toBeInTheDocument()
    // And it fails SAFE: with nobody able to say whether the file still holds the unreadable value, the
    // discard stays on offer rather than the renderer claiming a repair it cannot see. Clicking it is
    // harmless either way — `confirmQueueRecovery()` re-probes and writes nothing if the value is gone.
    expect(await screen.findByRole('button', { name: 'Discard unreadable queue' })).toBeInTheDocument()
    expect(screen.queryByText(/Restart MAO to load it/)).toBeNull()
  })

  it('says nothing about the queue when the store is healthy', async () => {
    await renderApp([ONE])

    expect(screen.queryByText('Workflow automation is halted')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard unreadable queue' })).toBeNull()
  })
})
