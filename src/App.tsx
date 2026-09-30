import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import KanbanBoard from './components/KanbanBoard'
import WorkflowQueue from './components/WorkflowQueue'
import ProjectSettings from './components/ProjectSettings'
import GlobalSettings from './components/GlobalSettings'
import UpdateBanner from './components/UpdateBanner'
import { electronApi } from './electron-api'
import type { RepoRef } from '../core/workflow-engine'
import type { RepoWorkflowCapability } from '../core/repo-capabilities'
import { sameRepoRef } from '../core/repo-registry'
import type { StoredValueProblem, ThemePreference } from '../core/store'
import type { AppUpdateCheck } from './electron'

/** Matches the board's own listing poll: this is a background diagnostic, not something to spin on. */
const STORE_PROBLEM_POLL_MS = 30_000

type ProjectTab = 'board' | 'queue' | 'settings'
type View = 'project' | 'global-settings'

/**
 * Prefer the exact legacy row while it still exists, then follow its canonical repository identity
 * after a write folds case-variant duplicates into one entry.
 */
function selectedRepoIndex(repos: RepoRef[], selected: RepoRef): number {
  const exact = repos.findIndex((repo) => repo.owner === selected.owner && repo.repo === selected.repo)
  return exact === -1 ? repos.findIndex((repo) => sameRepoRef(repo, selected)) : exact
}

export default function App() {
  const [repos, setRepos] = useState<RepoRef[]>([])
  const [selectedRepo, setSelectedRepo] = useState<RepoRef | null>(null)
  const [view, setView] = useState<View>('project')
  const [projectTab, setProjectTab] = useState<ProjectTab>('board')
  const [theme, setThemeState] = useState<ThemePreference>('system')
  const [update, setUpdate] = useState<AppUpdateCheck | null>(null)
  const [dismissedUpdateSha, setDismissedUpdateSha] = useState<string | null>(null)
  /** Surfaces a failed settings edit or removal, which are otherwise silent (no preflight, no form). */
  const [repoError, setRepoError] = useState('')
  /**
   * Stored values the main process could not use. Polled rather than pushed (AGENTS.md rule 6), and
   * kept separate from `repos` on purpose: a `githubRepos` the schema cannot use arrives here as `[]`,
   * exactly like an empty list, so the list itself can never carry the fact that something was
   * discarded — and the guard's own report goes to a console a packaged-app operator never sees.
   */
  const [storeProblems, setStoreProblems] = useState<StoredValueProblem[]>([])
  /**
   * What the poll has to remember between reports about the repository list. A ref, not state: it is
   * read to decide what to do with the value being stored, and a render is not what has to happen in
   * between.
   *
   * - `lastUnusable` — what the previous report said, so the next one can be recognised as a repair
   *   rather than merely a quiet answer.
   * - `repairOwed` — a repair has been seen but its list has not been adopted yet. Survives a failed
   *   read so the next poll tries again.
   * - `generation` — bumped whenever something invalidates a list read already in flight: the observed
   *   state changing, or this window starting a write. Repairs are observed on a 30s poll
   *   but adopted through a read that takes its own time, so the two interleave; without this, a read
   *   started for one repair could land after the store had broken and been repaired again, show the
   *   list from before that second repair, and spend `repairOwed` so nothing ever read the current one.
   * - `writesInFlight` — writes from this window that have not settled. A read taken across one answers
   *   with a list the write is about to replace, and a generation captured *after* the write began looks
   *   current, so the read is not started at all; the write's own completion re-enters and retries.
   * - `adoption` — the most recently started adoption. Reads sharing a generation can still finish out
   *   of order, and only the newest may apply, or a late older answer rolls the sidebar back.
   */
  const repoListWatch = useRef({
    lastUnusable: false,
    repairOwed: false,
    generation: 0,
    writesInFlight: 0,
    adoption: 0,
  })
  /**
   * Counts every navigation choice, so an async add can ask whether the operator moved elsewhere
   * while its permission preflight was running.
   *
   * A repo-list write can take seconds (an add's preflight is a network call and `updateRepos`
   * serializes everything behind it), so the completion must not drag the operator back from another
   * project, tab, or global settings. The selected repository itself is stored by identity below, but
   * identity cannot tell whether opening the newly added repository is still wanted.
   *
   * It counts moves; it does not say where the operator is. An add submitted from the sidebar while
   * Global settings is already open never moves anyone, so `addRepo` pairs this counter with the view
   * it started from. Never read this counter during render.
   */
  const navigationGeneration = useRef(0)

  /** Store identity, not position: registration can fold duplicates and reorder the list. */
  function selectRepo(repo: RepoRef | null) {
    navigationGeneration.current += 1
    setSelectedRepo(repo)
  }

  function selectIndex(index: number | null, candidates = repos) {
    selectRepo(index === null ? null : candidates[index] ?? null)
  }

  function selectView(next: View) {
    navigationGeneration.current += 1
    setView(next)
  }

  function selectProjectTab(next: ProjectTab) {
    navigationGeneration.current += 1
    setProjectTab(next)
  }

  const matchingSelectedIndex = selectedRepo === null ? null : selectedRepoIndex(repos, selectedRepo)
  const selectedIndex = matchingSelectedIndex === -1 ? null : matchingSelectedIndex
  const selected = selectedIndex === null ? undefined : repos[selectedIndex]

  /**
   * Best-effort: a diagnostic that cannot be read must not take the app down with it, so a rejection
   * leaves the notice as it was rather than propagating. Re-read after every list write instead of
   * assumed cleared — a write heals the store, but a *failed* write leaves the unusable value in
   * place, which is precisely when the notice has to stay up.
   */
  /**
   * Stores a report and answers whether the repository list still has to be re-read because it was
   * repaired since the last one.
   *
   * That transition is the only thing worth acting on. While the list is unusable the renderer holds
   * `[]` — the guard's answer, not a list — so it is not stale, it is correct; and once a repair has
   * been adopted there is nothing further to take. Re-reading on *every* poll instead would reintroduce
   * the hazard `persistRepos`' success path avoids: a round trip landing mid-typing stomps newer
   * keystrokes in the settings pane.
   *
   * Deliberately does **not** clear the flag when it answers `true`: the transition is observable once,
   * and clearing it here would spend it on a read that has not happened yet. `adoptRepairedRepoList()`
   * clears it, and only once the list is in hand — so a transient failure leaves the repair pending and
   * the next poll tries again, instead of stranding the sidebar on "No projects yet" until a restart.
   */
  function applyStoreProblems(next: StoredValueProblem[]): boolean {
    const watch = repoListWatch.current
    const unusable = next.some((problem) => problem.field === 'githubRepos')
    if (unusable !== watch.lastUnusable) {
      watch.lastUnusable = unusable
      watch.generation += 1
    }
    const healed = watch.repairOwed && !unusable
    if (!healed) watch.repairOwed = unusable
    setStoreProblems(next)
    return healed
  }

  /**
   * Takes the repaired list, and only then treats the repair as done.
   *
   * Throws if the read fails, which every caller swallows — on purpose. The renderer's current list is
   * left exactly as it was rather than replaced with an empty one, and because the flag is still set the
   * next poll re-enters here. Adopting `[]` on failure would look identical to "there really are no
   * projects", which is the one thing this whole path exists to stop the operator being told.
   */
  async function adoptRepairedRepoList(): Promise<void> {
    const watch = repoListWatch.current
    // Not while this window is writing: the store is about to hold whatever the write is sending, so a
    // read now can only produce a list to be discarded — and its generation, captured after the write
    // began, would still look current when it answered. `persistRepos` re-enters here once it settles.
    if (watch.writesInFlight > 0) return
    const startedAt = watch.generation
    const request = (watch.adoption += 1)
    const repaired = await electronApi().github.getRepos()
    // Superseded while this read was in flight — by a newer report, by a write from this window, or by a
    // later adoption that has already answered. The list is dropped rather than applied, and
    // `repairOwed` is left standing so the next report reads whatever exists then.
    if (watch.generation !== startedAt || watch.adoption !== request) return
    watch.repairOwed = false
    setRepos(repaired)
  }

  function refreshStoreProblems(): Promise<void> {
    // The bridge lookup is deferred into the chain rather than called here, because this runs inside
    // `persistRepos`' `finally`: `electronApi()` throws synchronously when nothing is bound, and a
    // synchronous throw in a `finally` *replaces* the rejection already on its way to the caller — the
    // operator would be told the bridge was missing instead of why their write failed.
    return Promise.resolve()
      .then(() => electronApi().app.storeProblems())
      .then(async (next) => {
        // A repair from outside this window — `mao repos add` in a terminal, or the hand-edit the report
        // itself asks for — heals the store without the renderer writing anything, so nothing else would
        // ever re-read the list. Taking only the diagnostic down would leave the card gone and the
        // sidebar still insisting there are no projects, which is worse than either alone. Selection
        // reconciles itself: the identity effect above adopts the first entry once one exists.
        if (applyStoreProblems(next)) await adoptRepairedRepoList()
      })
      .catch(() => {})
  }

  /**
   * Polled, not only read at mount, because the file is not this window's to own: an operator who
   * hand-edits `config.json` while the app is open — which the report itself sends them to do — would
   * otherwise see nothing until their next repository-list write, and that write is what destroys the
   * value. Reading it *after* a write cannot warn anyone in time; only reading it on a clock can.
   *
   * Cleared on unmount, and safe under StrictMode's double invocation: the read is idempotent and both
   * mounts install and clear their own interval.
   */
  useEffect(() => {
    void refreshStoreProblems()
    const handle = setInterval(() => void refreshStoreProblems(), STORE_PROBLEM_POLL_MS)
    return () => clearInterval(handle)
  }, [])

  useEffect(() => {
    electronApi().github.getRepos().then((savedRepos) => {
      setRepos(savedRepos)
      if (savedRepos.length > 0) setSelectedRepo(savedRepos[0])
    })
  }, [])

  useEffect(() => {
    electronApi().ui.getTheme().then(setThemeState)
  }, [])

  // Applies the effective light/dark scheme to <html data-theme>, which src/index.css keys its dark
  // token overrides off of. 'system' has no fixed effective value, so it tracks the OS-level media
  // query live instead of resolving once — the app should flip immediately if the OS theme changes
  // while it's open, without requiring a restart or a settings round-trip.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    function applyEffectiveTheme() {
      const effective = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      if (effective === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark')
      } else {
        document.documentElement.removeAttribute('data-theme')
      }
    }

    applyEffectiveTheme()

    if (theme !== 'system') return
    media.addEventListener('change', applyEffectiveTheme)
    return () => media.removeEventListener('change', applyEffectiveTheme)
  }, [theme])

  async function setTheme(next: ThemePreference) {
    setThemeState(next)
    await electronApi().ui.setTheme(next)
  }

  useEffect(() => {
    let cancelled = false

    async function checkUpdate() {
      try {
        const result = await electronApi().app.checkUpdate()
        if (cancelled) return
        if (result.updateAvailable && result.latestSha !== dismissedUpdateSha) {
          setUpdate(result)
        } else if (!result.updateAvailable) {
          setUpdate(null)
        }
      } catch {
        // Missing token/offline/self-update lookup errors should not interrupt normal app use.
      }
    }

    checkUpdate()
    const interval = setInterval(checkUpdate, 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [dismissedUpdateSha])

  async function restartForUpdate() {
    if (!update) return
    const force =
      update.runningTaskCount === 0 ||
      window.confirm(`${update.runningTaskCount} workflow task(s) are still running. Restart anyway?`)
    if (!force) return
    try {
      await electronApi().app.relaunch(update.runningTaskCount > 0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (window.confirm(`${message}. Restart anyway?`)) {
        await electronApi().app.relaunch(true)
      }
    }
  }

  useEffect(() => {
    if (repos.length === 0) {
      if (selectedRepo !== null) setSelectedRepo(null)
    } else if (selectedRepo === null || selectedIndex === null) {
      // This is reconciliation, not an operator navigation choice. In particular, the optimistic
      // first add reaches here while its preflight is still pending and must not invalidate its own
      // completion's intent to open the newly registered project.
      setSelectedRepo(repos[0])
    }
  }, [repos, selectedIndex, selectedRepo])

  /**
   * Mirrors into React state immediately, and on rejection re-reads the store rather than restoring a
   * snapshot.
   *
   * Optimistic on the success path because the update path cannot wait for the round trip:
   * ProjectSettings renders fully controlled inputs off this state, and deferring the mirror until
   * after the IPC makes React restore each keystroke to the last rendered value, so the poll-interval
   * field reverts as it is typed. (For the same reason the success path must NOT re-read either — a
   * round trip that lands mid-typing would stomp newer keystrokes with the value it persisted.)
   *
   * Rolling back to a captured `previous` is wrong, though: that snapshot is this render's optimistic
   * mirror, not the store, and `setRepos` writes the whole list, so several writes can be in flight at
   * once — an add's preflight is a multi-second network call during which the settings panel stays
   * live. Restoring a stale snapshot can then resurrect an entry the store refused, or erase one a
   * concurrent write just persisted, and since the renderer reads the list only once at mount that
   * divergence never heals. `github:getRepos` is a pure `store.get`, so asking it what actually
   * survived is both cheap and authoritative — and it is the re-fetch-after-mutation model AGENTS.md
   * prescribes for the renderer.
   */
  async function persistRepos(next: RepoRef[]): Promise<RepoWorkflowCapability[]> {
    const previous = repos
    // This window is now the newest thing to have touched the list, so any repair read already in flight
    // is describing a store that predates it — and until this settles, no new one should start.
    repoListWatch.current.generation += 1
    repoListWatch.current.writesInFlight += 1
    setRepos(next)
    try {
      return await electronApi().github.setRepos(next)
    } catch (err) {
      // Fall back to the snapshot only if even the read fails; showing a stale list beats showing one
      // built from a write we know was refused.
      setRepos(await electronApi().github.getRepos().catch(() => previous))
      throw err
    } finally {
      // No second generation bump on the way out: the one taken on entry already invalidates every read
      // that spans this write, whichever order they settle in.
      repoListWatch.current.writesInFlight -= 1
      // Every list write replaces an unusable stored value, and a refused one does not — so this is
      // read back on both paths rather than cleared optimistically on the success path. It is also what
      // retries an adoption this write held back.
      void refreshStoreProblems()
    }
  }

  /**
   * Rejects when the repo fails the write-permission preflight; Sidebar renders the message. Resolves
   * with the verdicts so Sidebar can show the caveat for grants the preflight could not prove.
   */
  async function addRepo(repo: RepoRef): Promise<RepoWorkflowCapability[]> {
    const startedAt = navigationGeneration.current
    /**
     * Whether the operator was looking at a project when they submitted the form. Read at entry
     * rather than at completion, which is sound in the one direction that matters here: the only way
     * *out of* the project view is `selectView`, the sidebar's Global settings button, and it bumps
     * `navigationGeneration`. So an unchanged counter — which `mayOpenAddedRepo()` also requires —
     * means the operator has not left. Every other `setView` call moves *into* the project view, and
     * is preceded by a `selectRepo`/`selectIndex` that bumps regardless. A new call site that can
     * leave the project view has to bump the counter too, or this capture goes stale.
     */
    const startedInProject = view === 'project'
    /**
     * Opening the repository just registered is a courtesy, and getting it wrong costs more than a
     * stray click. `GlobalSettings` is mounted by a ternary below and holds the GitHub token and each
     * provider's API key in component state until "Save changes" is pressed, so switching the view out
     * from under it discards pasted credentials silently — and an operator who pasted a token has
     * every reason to think it was kept. So decline unless the operator is still exactly where they
     * were when they asked: the counter catches a move made during the preflight (a multi-second
     * network call), and `startedInProject` catches what the counter cannot see, an add submitted from
     * the always-visible sidebar form while Global settings was already open.
     */
    const mayOpenAddedRepo = () => startedInProject && navigationGeneration.current === startedAt
    // Decided against what the store actually holds, not this component's mirror, which is read once at
    // mount: a repo added by `mao repos add` in a terminal since then would be missing from it. That
    // matters twice over — core can only protect a tracked repo's settings from a bare Add-form
    // submission when the tracked entry is in the list being written, and an unseen repo would
    // otherwise make this look like a first registration.
    const current = await electronApi().github.getRepos().catch(() => repos)
    const existing = current.findIndex((r) => sameRepoRef(r, repo))
    if (existing !== -1) {
      // Already tracked — including under a different capitalisation, which is one repository to
      // GitHub and to core. Adopt the authoritative list and navigate rather than returning silently:
      // the repo may be one this component has never seen, and leaving the mirror stale would hide a
      // repository that really is being tracked and polled until the app restarts.
      setRepos(current)
      if (mayOpenAddedRepo()) {
        selectIndex(existing, current)
        setView('project')
        setProjectTab('board')
      }
      return []
    }
    const checked = await persistRepos([...current, repo])
    // Re-read instead of deriving the selection from the optimistic copy: the fold means the stored
    // list can be shorter than the one just sent, and selecting into a list the store does not have
    // would leave the sidebar showing a row that is not there. This is the re-fetch-after-mutation
    // model AGENTS.md prescribes for the renderer, and `github:getRepos` is a pure `store.get`, so it
    // resolves immediately after our own write — which `updateRepos` has already serialized, meaning
    // any settings write queued before this one has landed and is included.
    //
    // Not free of risk, unlike what persistRepos' success path avoids: a settings edit made *during*
    // the add's multi-second preflight is queued behind it, so this read can return the pre-edit value
    // and revert that field in the renderer. That window is narrow and needs a deliberate edit while
    // the form reads "Checking access…", whereas a phantom sidebar row is certain whenever the add is
    // folded — so it is the better trade, not a free one. Core keeps the last occurrence of a
    // repository, so the entry just registered (or the existing one it merged into) is last.
    const stored = await electronApi().github.getRepos().catch(() => [...current, repo])
    setRepos(stored)
    // Selection is written as identity, so later list folding cannot silently retarget it.
    if (mayOpenAddedRepo()) {
      const added = stored.findIndex((r) => sameRepoRef(r, repo))
      selectIndex(added === -1 ? (stored.length > 0 ? stored.length - 1 : null) : added, stored)
      setView('project')
      setProjectTab('board')
    }
    return checked
  }

  // Settings edits and removals skip the preflight by design, but the store write can still fail —
  // and an inert checkbox with an unhandled rejection in the console tells the operator nothing.
  async function updateSelectedRepo(patch: Partial<RepoRef>) {
    if (selectedIndex === null) return
    const target = repos[selectedIndex]
    if (!target) return
    const next = repos.map((r, i) => (i === selectedIndex ? { ...r, ...patch } : r))
    setRepoError('')
    try {
      await persistRepos(next)
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
      return
    }
    // A settings edit leaves the list's shape alone, and re-reading after every one would let a slow
    // round trip stomp a newer keystroke — the reason persistRepos' success path does not (see there).
    // The exception is a store still holding a pre-fix duplicate: this write collapses it, so the row
    // count drops. Without adopting that, the mirror keeps a row the store no longer has and keeps
    // re-sending it, so an edit that lost the duplicate tie-break could never be re-applied. Adopting
    // only the structural change heals the list without touching any value being typed.
    const stored = await electronApi().github.getRepos().catch(() => next)
    if (stored.length !== next.length) {
      setRepos(stored)
      // `selectedRepo` remains the authoritative identity. Whether it is this edit's target or a
      // project selected while the write was pending, deriving the index from `stored` preserves it
      // across the fold instead of letting the old numeric position silently name another project.
    }
  }

  /**
   * The in-app way out of a stored repository list the schema cannot use.
   *
   * Reachable when nothing else is: with no usable list there is no sidebar row, so no project is
   * selected and the Settings tab's Remove button — the guard's own suggested recovery — never
   * renders. Writing an empty list registers nothing, so unlike Add it is never refused by the
   * write-permission preflight, which is what an operator with a missing or revoked token is left
   * with. Sidebar confirms first, and shows the report naming the file to salvage from.
   */
  async function resetRepoList() {
    setRepoError('')
    // Re-read before destroying anything. This store is not this window's alone: the report itself tells
    // the operator to go to `config.json`, and `mao repos add` in a terminal heals it — while this card,
    // read at mount and after writes, keeps offering a button that writes an empty list. Blind, that
    // deletes the healthy list they just built. Fail closed: a read that throws aborts the reset.
    const current = await electronApi().app.storeProblems()
    applyStoreProblems(current)
    if (!current.some((problem) => problem.field === 'githubRepos')) {
      await adoptRepairedRepoList().catch(() => {})
      return
    }
    await persistRepos([])
    // Adopt what the store now holds, for the same reason removal does: the write is the authority.
    // Deliberately nothing else. Selection reconciles itself — the effect above clears `selectedRepo`
    // when the list empties — and forcing a view/tab here would be a navigation decision made after
    // two awaits, which is exactly what `navigationGeneration` exists to stop: the sidebar is visible
    // from Global settings too, so a reset started there would otherwise yank the operator away from it.
    await adoptRepairedRepoList().catch(() => {})
  }

  async function removeSelectedRepo() {
    if (selectedIndex === null) return
    const target = repos[selectedIndex]
    if (!target) return
    // Every row naming this repository, not just the selected index. A store written before repository
    // identity was case-insensitive can hold it twice, and dropping one row hands core a list that
    // still names it: "Remove" would leave the repo tracked, and the surviving row's settings would
    // take over — re-enabling unattended polling the operator had switched off, on the repository they
    // just tried to delete. `mao repos remove` already deletes by identity; the GUI has to agree.
    const next = repos.filter((r) => !sameRepoRef(r, target))
    setRepoError('')
    // The selected identity is being removed. Pick the deterministic fallback before the await so a
    // later user navigation always wins over this operation's completion.
    selectIndex(next.length > 0 ? 0 : null, next)
    setProjectTab('board')
    const fallbackGeneration = navigationGeneration.current
    try {
      await persistRepos(next)
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : String(err))
      // If nothing else was selected while the write was pending, return to the repository whose
      // removal failed so the settings error is visible. A concurrent external removal is harmless:
      // the identity-fallback effect will choose an entry that still exists.
      if (navigationGeneration.current === fallbackGeneration) {
        selectRepo(target)
        setView('project')
        setProjectTab('settings')
      }
      return
    }
    // Re-read for the same reason as addRepo, and with the same safety: a list that still held a
    // duplicate written by an earlier build comes back one entry shorter once core folds it away, and
    // this path navigates to the board rather than leaving an input mid-edit.
    const stored = await electronApi().github.getRepos().catch(() => next)
    setRepos(stored)
  }

  function selectProject(index: number) {
    selectIndex(index, repos)
    setView('project')
    setProjectTab('board')
  }

  return (
    <div className="min-h-screen w-screen flex">
      <Sidebar
        repos={repos}
        selectedIndex={selectedIndex}
        onSelect={selectProject}
        onAddRepo={addRepo}
        storeProblems={storeProblems}
        onResetRepoList={resetRepoList}
        view={view}
        onViewChange={selectView}
      />

      <main className="flex-1 mx-auto w-full max-w-[1120px] px-6 py-8">
        {update && (
          <UpdateBanner
            update={update}
            onRestart={restartForUpdate}
            onDismiss={() => {
              setDismissedUpdateSha(update.latestSha)
              setUpdate(null)
            }}
          />
        )}

        {view === 'global-settings' ? (
          <GlobalSettings theme={theme} onThemeChange={setTheme} />
        ) : !selected ? (
          <div>
            <h2>Welcome to MAO</h2>
            <p className="text-muted mt-2 text-sm">
              Add a repository from the sidebar to see its issues and pull requests here.
            </p>
          </div>
        ) : (
          <div>
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 className="!mb-0">
                {selected.owner}/{selected.repo}
              </h2>
            </div>

            {repoError && (
              <p className="mb-3 text-xs" style={{ color: 'var(--color-accent-700)' }}>
                {repoError}
              </p>
            )}

            <div className="tabs">
              <button
                className={`tab ${projectTab === 'board' ? 'active' : ''}`}
                onClick={() => selectProjectTab('board')}
              >
                Board
              </button>
              <button
                className={`tab ${projectTab === 'queue' ? 'active' : ''}`}
                onClick={() => selectProjectTab('queue')}
              >
                Queue
              </button>
              <button
                className={`tab ${projectTab === 'settings' ? 'active' : ''}`}
                onClick={() => selectProjectTab('settings')}
              >
                Settings
              </button>
            </div>

            {projectTab === 'board' && <KanbanBoard repo={selected} />}
            {projectTab === 'queue' && <WorkflowQueue repo={selected} />}
            {projectTab === 'settings' && (
              <ProjectSettings repo={selected} onChange={updateSelectedRepo} onRemove={removeSelectedRepo} />
            )}
          </div>
        )}
      </main>
    </div>
  )
}
