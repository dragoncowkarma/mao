import type { GithubService } from './github-service.ts'
import type { RepoWorkflowCapability } from './repo-capabilities.ts'
import type { MaoStore } from './store.ts'
import type { RepoRef } from './workflow-engine.ts'

/**
 * The single definition of "this repository entry is newly registered, so the credential must be
 * checked before we persist it" — shared verbatim by the Electron `github:setRepos` handler and the
 * CLI's `mao repos add`.
 *
 * It lives in core rather than in either shell for two reasons. It is a security-relevant policy, not
 * a delegation, so AGENTS.md rule 2 puts it here; and it is the *only* thing keeping the two
 * registration paths from drifting apart — the GUI persists a whole list while the CLI replaces one
 * entry, and a hand-written copy of the rule on each side would silently diverge the first time
 * either shape changed.
 */

/**
 * The identity of a repository entry, as GitHub itself resolves it: owner and repo compared without
 * regard to case. `GET /repos/DragonCowKarma/MAO` and `GET /repos/dragoncowkarma/mao` address one
 * repository, so treating the two spellings as different entries produced a duplicate registration
 * that `startAutoTrigger` polled twice — and because auto-trigger enqueues *before* it writes the
 * best-effort `workflow-active` label, the two pollers could each enqueue the same issue and open two
 * branches and PRs for it. `mao repos remove` spelled the other way then matched neither entry.
 *
 * `toLowerCase()` rather than `toLocaleLowerCase()` on purpose: the mapping must not depend on the
 * machine's locale, or the same store would compare differently under a Turkish locale (`I` -> `ı`).
 *
 * Coerced rather than trusted, because the store is unvalidated JSON: `RepoRef` says both halves are
 * strings, but a hand-edited or older-build `config.json` can hold an entry missing one. The `===`
 * this replaced merely returned false for such an entry, whereas a bare `.toLowerCase()` would throw
 * — and since every list write funnels through here, that would wedge `repos remove` too, leaving the
 * operator no way to delete the bad entry from inside the app.
 */
export function repoRefKey(ref: RepoRef): string {
  return `${String(ref.owner ?? '').toLowerCase()}/${String(ref.repo ?? '').toLowerCase()}`
}

/** Repository identity is the owner/repo pair, case-insensitively — nothing else. */
export function sameRepoRef(a: RepoRef, b: RepoRef): boolean {
  return repoRefKey(a) === repoRefKey(b)
}

/**
 * `next`, rewritten into the list that is actually safe to store: at most one entry per repository,
 * and every entry naming an already-registered repository carrying the *stored* owner/repo spelling
 * rather than whatever the caller typed.
 *
 * That second half is what keeps case-insensitive identity from quietly defeating the preflight.
 * Comparing case-insensitively alone would make `DragonCowKarma/MAO` look already-tracked to
 * `reposNeedingCapabilityCheck()`, and the write would then persist that never-checked pair — the
 * exact bypass `assertReposRegistrable()` exists to prevent. Folding the entry back onto the stored
 * spelling instead means an owner/repo pair only ever reaches the store after being preflighted with
 * those same strings, so the guarantee holds by construction rather than by an argument about how
 * GitHub happens to resolve names.
 *
 * Deliberately *not* a lower-casing normalisation of the whole list. Rewriting stored entries would
 * change strings that other state already copied verbatim — `QueuedTask.repo` is snapshotted at
 * enqueue time, and the board and queue views filter tasks by an exact `t.repo.owner === repo.owner`
 * comparison — so canonicalising the sidebar's spelling would hide every task queued before the
 * change. It would also misspell repositories back at the operator (`microsoft/typescript`), and the
 * casing shown in the sidebar is the one they registered.
 *
 * The last occurrence of a repository wins its *position*, matching `mao repos add`'s documented "adds
 * or replaces its entry" and letting the GUI's add path find the entry it just registered at the end
 * of the stored list. Its *settings* do not: see `mergeOccurrences()`.
 *
 * When `previous` itself names one repository twice — the duplicate an earlier build could write, and
 * the reason this heals rather than only prevents — the entry appearing **first in stored order**
 * supplies the surviving spelling. (First in order, not necessarily first ever registered: `mao repos
 * add` moves the entry it replaces to the end; for a repository nothing has registered yet, the first
 * occurrence in `next` supplies it instead.) Keeping the later one instead would rename the
 * project, which matters because `QueuedTask.repo` is snapshotted at enqueue time and never rewritten.
 * Note that this only narrows the problem: both duplicate rows were live, so tasks can carry either
 * spelling, and a heal drops one of the rows. That is why the board and queue match a task to its
 * repo with `sameRepoRef` rather than `===` — otherwise healing would hide every task queued under
 * the losing spelling, with no row left to reach them from while they kept running.
 */
/**
 * Combines two entries in the same list that name one repository.
 *
 * The earlier occurrence wins every field it defines and the later fills in the rest, because the
 * later is characteristically the *less* informed of the two: the sidebar's Add form submits a bare
 * `{owner, repo}` which `App.addRepo` appends to the list it is already showing, and a stale second
 * row left over from a pre-fix duplicate carries whatever settings it had when it was written. Taking
 * the later wholesale is what blanked a tracked repo's `autoTrigger`/`pollIntervalMs` and restarted
 * unattended polling at the default interval. `mao repos add` still replaces settings outright, as
 * documented, because its update callback drops the entry it supersedes — only one occurrence reaches
 * the fold, so nothing is merged.
 *
 * `autoTrigger: false` is then the one field that wins from *either* side. Direction alone cannot make
 * this safe: the disagreement is genuinely ambiguous — nothing in `RepoRef` records which row the
 * operator touched — and getting it wrong in the permissive direction silently resumes an unattended
 * pipeline that opens branches, PRs and merges on a repository whose polling was deliberately switched
 * off. Getting it wrong the other way leaves polling off until the operator turns it back on. Those
 * costs are not symmetric, so the tie breaks toward not polling.
 *
 * The residual ambiguity is real and deliberately not papered over: an edit to a *second* duplicate
 * row's poll interval is dropped in favour of the first row's. It is reachable only from a store an
 * earlier build wrote, and the same write that drops it removes the duplicate, so re-applying it on
 * the now-single entry sticks — which holds only because `App.updateSelectedRepo` adopts the collapsed
 * list. Without that the renderer would keep re-sending the duplicate and the edit would never take.
 */
function mergeOccurrences(earlier: RepoRef, later: RepoRef): RepoRef {
  const merged: RepoRef = { ...later, ...earlier }
  if (earlier.autoTrigger === undefined) merged.autoTrigger = later.autoTrigger
  if (earlier.pollIntervalMs === undefined) merged.pollIntervalMs = later.pollIntervalMs
  if (earlier.autoTrigger === false || later.autoTrigger === false) merged.autoTrigger = false
  return merged
}

/**
 * Whether a stored value can be treated as a repository entry at all.
 *
 * `repoRefKey()` already tolerates an entry missing `owner` or `repo`, but `config.json` is
 * unvalidated JSON and can hold `null` or a bare string where an object belongs — which would throw on
 * property access before the key is ever built. Since canonicalisation walks `previous` on *every*
 * list write, one such value would wedge writes entirely, including the empty-list write that used to
 * be the way to clear it. Unusable entries are therefore dropped rather than preserved: they cannot be
 * polled (`startAutoTrigger` skips anything without both halves) and cannot be named on a command
 * line, so keeping them would only re-wedge the next write.
 */
function isRepoRef(ref: unknown): ref is RepoRef {
  return typeof ref === 'object' && ref !== null
}

export function canonicalRepoList(previous: RepoRef[], next: RepoRef[]): RepoRef[] {
  const stored = new Map<string, RepoRef>()
  for (const ref of previous) {
    if (!isRepoRef(ref)) continue
    const key = repoRefKey(ref)
    if (!stored.has(key)) stored.set(key, ref)
  }

  const canonical = new Map<string, RepoRef>()
  for (const candidate of next) {
    if (!isRepoRef(candidate)) continue
    const key = repoRefKey(candidate)
    const earlier = canonical.get(key)
    const merged = earlier ? mergeOccurrences(earlier, candidate) : candidate
    const spelling = stored.get(key) ?? merged
    // Re-inserting an existing key would keep the *first* insertion's position, so drop it first.
    canonical.delete(key)
    canonical.set(key, { ...merged, owner: spelling.owner, repo: spelling.repo })
  }
  return [...canonical.values()]
}

/**
 * The entries in `next` whose repository is absent from `previous` — i.e. genuine registrations.
 *
 * Identity deliberately ignores `autoTrigger` and `pollIntervalMs`. Comparing whole objects would
 * re-run the credential check on every settings edit, which would make an already-tracked repository
 * *unmanageable* the moment its access was revoked: the operator could no longer turn its polling
 * off, even though issue #48 exempts removal for exactly that reason. Editing settings on a repo you
 * already registered is not a new registration; removal and reordering are not either.
 *
 * `next` is canonicalised first rather than trusted, so the answer cannot depend on a caller having
 * remembered to call `canonicalRepoList()` — and so the returned entries carry exactly the strings
 * that will be persisted for them.
 */
export function reposNeedingCapabilityCheck(previous: RepoRef[], next: RepoRef[]): RepoRef[] {
  return canonicalRepoList(previous, next).filter(
    (candidate) => !previous.some((existing) => sameRepoRef(existing, candidate)),
  )
}

/**
 * Guards a repository-list write: throws before the caller touches the store if any newly registered
 * entry fails the non-mutating preflight (`GithubService.assertRepoWorkflowWritable()`).
 *
 * Checked sequentially and aborting on the first failure, so a rejected write leaves the stored list
 * untouched and the operator sees one actionable message naming one repository, rather than a race of
 * partial results. The thrown error is `RepoCapabilityError` (or the transient error the lookup
 * raised), whose message already names the repo and the missing capabilities and contains no secrets.
 *
 * Returns the passing verdicts so a caller can surface their `unverified` grants (see
 * `describeUnverifiedGrants()`) without paying for a second lookup.
 *
 * Checks whatever is new relative to `previous` *after canonicalisation*, so a caller must persist
 * `canonicalRepoList(previous, next)` rather than its own `next` — otherwise it can store a spelling
 * this never checked. `createRepoRegistrar()` below is the only supported writer for exactly that
 * reason; call this directly only from tests.
 */
export async function assertReposRegistrable(
  github: Pick<GithubService, 'assertRepoWorkflowWritable'>,
  previous: RepoRef[],
  next: RepoRef[],
): Promise<RepoWorkflowCapability[]> {
  const capabilities: RepoWorkflowCapability[] = []
  for (const repo of reposNeedingCapabilityCheck(previous, next)) {
    capabilities.push(await github.assertRepoWorkflowWritable(repo.owner, repo.repo))
  }
  return capabilities
}

/** Computes the list to persist from the list currently in the store. */
export type RepoListUpdate = (previous: RepoRef[]) => RepoRef[]

/**
 * Serializes read -> preflight -> write of the tracked-repository list, and owns that sequence so
 * neither shell has to.
 *
 * The preflight is a network call, which puts an await between reading the stored list and writing
 * the new one. Without serialization a second update that arrives during that await runs to
 * completion first, and the slow one then writes the list it was handed at request time — resurrecting
 * a repository the operator removed in the meantime. That is not hypothetical: the GUI shows a
 * repository optimistically while its preflight is still running, so removing it right then is a
 * couple of clicks. The store would keep it, the sidebar would not, and auto-trigger would go on
 * polling a repository the operator believes is gone.
 *
 * Queueing rather than rejecting on conflict is deliberate: each update is computed from the caller's
 * latest view, so letting the later one land last is exactly the operator's most recent intent. The
 * update is applied to the list read *inside* the critical section, so a queued call never plans
 * against a list that has since changed, and `assertReposRegistrable()` still preflights whatever is
 * new relative to that fresh read.
 */
export function createRepoRegistrar(
  github: Pick<GithubService, 'assertRepoWorkflowWritable'>,
  store: Pick<MaoStore, 'get' | 'set'>,
) {
  let queue: Promise<unknown> = Promise.resolve()

  return function updateRepos(update: RepoListUpdate): Promise<RepoWorkflowCapability[]> {
    const run = queue.then(async () => {
      const previous = store.get('githubRepos')
      // Canonicalised inside the critical section, before the preflight — so the list that gets
      // checked is byte-for-byte the list that gets stored. This is the single chokepoint that keeps
      // a differently capitalised duplicate from reaching the store unchecked, which is why neither
      // shell has to know the rule exists (see canonicalRepoList()).
      const next = canonicalRepoList(previous, update(previous))
      const checked = await assertReposRegistrable(github, previous, next)
      store.set('githubRepos', next)
      return checked
    })
    // A rejected update must not wedge the queue for every update after it, and its rejection belongs
    // to its own caller — so the chain follows the settled promise while `run` keeps the error.
    queue = run.catch(() => undefined)
    return run
  }
}
