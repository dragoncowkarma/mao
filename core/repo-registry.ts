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

/** Repository identity is the owner/repo pair — nothing else. See `reposNeedingCapabilityCheck()`. */
export function sameRepoRef(a: RepoRef, b: RepoRef): boolean {
  return a.owner === b.owner && a.repo === b.repo
}

/**
 * The entries in `next` whose owner/repo pair is absent from `previous` — i.e. genuine registrations.
 *
 * Identity deliberately ignores `autoTrigger` and `pollIntervalMs`. Comparing whole objects would
 * re-run the credential check on every settings edit, which would make an already-tracked repository
 * *unmanageable* the moment its access was revoked: the operator could no longer turn its polling
 * off, even though issue #48 exempts removal for exactly that reason. Editing settings on a repo you
 * already registered is not a new registration; removal and reordering are not either.
 */
export function reposNeedingCapabilityCheck(previous: RepoRef[], next: RepoRef[]): RepoRef[] {
  return next.filter((candidate) => !previous.some((existing) => sameRepoRef(existing, candidate)))
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
      const next = update(previous)
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
