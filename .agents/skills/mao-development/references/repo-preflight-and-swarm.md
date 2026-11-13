# Repository preflight and Swarm

Tier 3 reference — read when changing `core/repo-capabilities.ts`, `core/repo-registry.ts` or repository polling, running or changing `mao swarm`, assigning Swarm roles, or reviewing a PR. Rule summary: [AGENTS.md](../../../../AGENTS.md). Playbook: [SKILL.md](../SKILL.md).

- `mao swarm --repo-root <path>` can target any repository, so this MAO-specific file may be absent
  there; prompts name it conditionally (the shared instructions in `core/swarm/engine.ts`). Absence is no blocker.
- Engine routing and the per-stage gate: [workflow-and-routing.md](workflow-and-routing.md). Store
  concurrency and `githubRepos` recovery: [store-and-recovery.md](store-and-recovery.md).
- Swarm is native TypeScript in `core/swarm/`, reached through `core/swarm-runner.ts`; the CLI stays
  thin. Tests in `core/swarm/` cover role separation, lifecycle signals, model/effort resolution,
  capability/origin boundaries, registry recovery and process groups. `npm run test:swarm-bundle`
  checks the standalone bundle with fake commands, without Python or real GitHub/AI writes.

## When changing repository registration

- `githubRepos` has one writer: `updateRepos` (`createRepoRegistrar`, via `createMaoApp()`). Never
  write it through `store` or move read -> preflight -> write into a shell: the preflight's await
  lets a later update finish first, and the slow one resurrects a removed repo auto-trigger polls on.
- `github:setRepos` (`electron/ipc.ts`) and `repos add`/`repos remove` (`cli/index.ts`) stay thin
  delegations; the add-vs-update rule lives only in `core/repo-registry.ts`, or the paths drift.
- A shell callback may match with `sameRepoRef`; it never normalises or deduplicates.
- A callback (`RepoListUpdate`) is pure: a list another process moved is re-planned, up to
  `MAX_REPO_LIST_ATTEMPTS` (3). CLI callbacks are deltas; the GUI's edit travels as
  `github:setRepos(next, base)` wrapped in `applyRepoListEdit`. Never a bare `() => next`: it
  re-plans to the same stale mirror.
- Delete by identity, never array position: omitting one row of a duplicated pair leaves the repo
  tracked with the other row's settings, polling included.
- Both shells surface the `unverified` caveat, or they claim more than the check established: CLI
  `describeUnverifiedGrants()`, GUI `unverifiedNotice()` in `src/components/Sidebar.tsx`.
- No test pins these shell rules: a bare `() => next` in `github:setRepos`, a diff in `cli/index.ts` or
  a deleted caveat stays green. Check them in review.

| Symbol | Contract |
| --- | --- |
| `repoRefKey`, `sameRepoRef` | Lower-cased `owner/repo`, locale-independent; an invalid entry (`isRepoRef`) matches nothing, or junk lets a real repo skip preflight |
| `canonicalRepoList` | One entry per repo, stored spellings, non-repos dropped; throws on a non-array `next`, which would erase every repo |
| `reposNeedingCapabilityCheck` | Entries new to `previous` after canonicalising; ignores settings |
| `assertReposRegistrable` | Preflights those in order, stops at first failure, returns verdicts. Direct calls: tests only |
| `applyRepoListEdit` | Re-applies an edit made against `base` to the list stored now. Does not re-add a repo removed elsewhere, unless the stored list holds non-repo entries (carried forward, preflighted) or is not a list (whole edit) (JSDoc) |
| `createRepoRegistrar` | Serial `inspect` -> canonicalise -> preflight -> `setIfUnchanged`; unreadable list refuses |

## When changing repository identity

- Identity is owner/repo case-insensitively, as GitHub resolves it. A second spelling is polled twice,
  and auto-trigger enqueues before its best-effort `workflow-active` label: two PRs for one issue.
- Comparison alone is unsafe: a variant reads as tracked and the write persists a pair never
  preflighted. So `updateRepos` runs `canonicalRepoList()` in its critical section, before the
  preflight: checked and stored bytes are equal. Never in a shell.
- Never lower-case stored entries: `QueuedTask.repo` snapshots the spelling at enqueue, and the
  sidebar shows the one registered.
- Spelling: first entry in stored order, else first in `next`. Position: last occurrence.
- Settings in one list (`mergeOccurrences`): the earlier occurrence keeps every field it defines, the
  later fills the rest. The later (bare Add-form entry, stale row) knows less; letting it win restarts
  unattended polling.
- `autoTrigger: false` wins from either side: the permissive guess resumes a pipeline that opens
  branches, PRs and merges; the other only leaves polling off.
- `mao repos add` replaces settings outright: its callback drops the superseded entry.
- Stored duplicates were both live, so tasks carry either spelling: board and queue match with
  `sameRepoRef`; `startAutoTrigger` canonicalises each tick because `mao run` never writes the list.
- Proof: `core/repo-registry.test.ts`.

## When changing preflight or polling

- One non-mutating `GET /repos/{owner}/{repo}` (`GithubService.checkRepoWorkflowCapability()`): exists,
  not archived, disabled or legally unavailable, Issues on, `permissions.push`. Never a
  create-then-delete probe: that is itself an unattended write.
- Adding (sidebar, `mao repos add`) persists nothing unless it passes. Settings edits and removal skip
  it, so a revoked repo stays manageable. Never add an exemption list.
- `core/auto-trigger.ts` preflights before `fetchTasks`: unauthorized means zero `enqueueFromIssue`
  and zero `workflow-active` writes.
- `github:refreshRepo` is **not a pure read**: `pollNow()` can enqueue, and bypasses
  `autoTrigger: false`.
- `pollNow()` owns its read, latch and preflight order: [store-and-recovery.md](store-and-recovery.md).
- Test real writes on throwaway repos only. `workflow enqueue` defaults to `autoAdvance: true`:
  [workflow-and-routing.md](workflow-and-routing.md).

Verdict rules (`evaluateRepoCapability`; rationale: JSDoc in `core/repo-capabilities.ts`):

- `ok: true` means no known blocker, never proof. Only permanent conditions are gaps; they accumulate.
- `permissions.push`: `true`, `false` (`no-push-permission`), else `permissions-unknown`, never granted.
- Classic token: non-empty `x-oauth-scopes`, else `unknown` and no failure by itself. Classic needs
  `repo`, or `public_repo` unless `private: true`.
- `unverified`: Issues, Contents and Pull requests write grants, when no gaps and credential `unknown`.
  GitHub cannot enumerate them without a write; never fold them into `ok`.
- `describeRepoCapability`: lowest `REMEDY_RANK` picks the remedy, repository state first. Only
  `grant-write` reads as missing permissions. `RepoCapabilityError` carries `.capability`, no secrets.
- Rate limits, 5xx, socket errors and the 60 s deadline rethrow, never gaps, so a task stays retryable
  (`classifyLookupFailure`).

## When changing capability policy

Policy has one definition: `core/repo-capabilities.ts`. Both `GithubService` and
`SwarmPlatform.assertRepoWritable()` call `evaluateRepoCapability()`, `describeRepoCapability()` and
`describeUnverifiedGrants()` directly. Change its tests and the Swarm platform adapter tests together
when changing inputs or failure classification; never reintroduce a second verdict table.

The credential boundaries deliberately differ: `GithubService` uses the store token, while Swarm runs
`gh api --include --method GET repos/{owner}/{repo}` with the active gh credential. Parse the entire
HTTP envelope and response object, including `x-oauth-scopes`; no `--jq` projection may discard fields
and turn an omitted/false permission into a grant. Authentication and command-failure diagnostics must
name the active credential, with no raw headers, body, stdout, stderr or credential-bearing URLs.
Repeated identical unverified-grant caveats print once per observed verdict; every required capability
probe still runs, and a changed verdict re-arms the warning.

## Operator runbook: tracked repositories

- Set the token first (Global settings, or `mao config set-token` in your own terminal, since argv
  exposes it), or `repos add` and the Add form
  fail with `no GitHub token is configured`.
- `mao repos add <owner> <repo> [--no-auto-trigger] [--poll-interval-ms <ms>]`: refused means list
  untouched, repo and every missing capability printed, exit 1. Success prints `Tracking <stored
  spelling>` plus any unverified caveat. On a tracked repo it is the CLI's only settings editor: no
  preflight, entry moves to the end, and omitting `--no-auto-trigger` re-enables polling.
- `mao repos remove <owner> <repo>`: never preflighted; prints `Stopped tracking ...` or
  `No tracked repo matches ...`.
- Any spelling matches: `repos remove ACME Widgets` removes `acme/widgets`.
- GUI Add of a tracked repo (any spelling) writes nothing, so settings survive. If the repo appeared
  after its `github:getRepos` read, core merges the bare owner/repo onto the tracked entry.
- Duplicates on disk fold at the next list write.
- Board **Refresh** surfaces a failed preflight; its 30 s listing poll continues, so cards stay.

## Operator runbook: `mao swarm` modes

Needs Node.js, `git`, authenticated `gh` and the CLIs the tags name. Swarm runs inside the single
`dist-cli/index.cjs` bundle; no Python, copied script or `MAO_SWARM_PYTHON` override is used. Target: the
checkout containing the current directory, or `--repo-root <path inside it>`. `npm run cli` runs from this
package's root, so without `--repo-root` it targets MAO itself.
It can create issues and comments, push, review, merge and close issues: a real run needs explicit
task authorization.

| Invocation | GitHub | Local writes | Exit |
| --- | --- | --- | --- |
| `mao swarm --status` | none, no origin or API lookup | none | 0 |
| `mao swarm --dry-run --once` | reads only; binds origin; skips write probe, `core.sshCommand`/`GIT_SSH*` check | none | 0, or 1 on failure |
| `mao swarm --once` | real dispatch and writes | runtime paths, task branches, fast-forward of a clean local `main` (`syncMain`) | 0 after owned agents complete; 1 on failure, 45-minute wait expiry or residual trees; SIGINT 130, SIGTERM 143 |
| `mao swarm [--interval <seconds>]` | same, polling (default 30 s) | runtime paths, task branches, fast-forward of a clean local `main` (`syncMain`) | SIGINT 130, SIGTERM 143; 1 on observed failures or surviving trees |

- `--dry-run` without `--once` polls forever.
- A normal `--once` drains its owned children and records their actual terminal statuses. One monotonic
  45-minute deadline covers the entire wait, not each child separately; expiry calls bounded group
  termination and returns 1. It never treats a still-running child as successful completion.
- `--reset` is a flag on a run, never a standalone clear: after deleting the registry it goes on to the
  preflight and real dispatch (`--once`: one cycle; else polling), so it needs the same authorization.
- Its own mutation is the registry alone, even if the next preflight fails: the one write before the
  network gate, so it works during access repair. With `--dry-run` it does not clear; `--status` ignores it.
- It forgets `running`/`stuck` ownership and cooldowns: stop residual trees first. It forgets every
  item's events too: completed ones read as `new event` and can dispatch again. Proof: `SwarmEngine.run()`,
  `ProcessTracker.shouldDispatch()`.
- A startup preflight failure exits 1 and creates no runtime file.
- Runtime paths: `.worktrees/<issue>`, `.agents/.process_registry.json`, `.agents/logs/`,
  `.agents/.prompts/`. Added to `.git/info/exclude` only; it never edits or commits `.gitignore`.
- Real runs also change Git state outside runtime paths: fetch, fast-forward of a clean local `main`
  (`syncMain`), task branches (`createWorktree`), and for merged PRs `git worktree remove` plus
  `git branch -D` (`cleanupWorktree`).

| `dispatch blocked`/`deferred` reason | Action |
| --- | --- |
| `completed without confirmed lifecycle transition` | Exited 0, no GitHub signal; never re-run. Needs a new event or `--reset` |
| `exhausted <n> failed attempts` | Fix the cause, then `--reset` |
| `residual process tree requires operator cleanup` | Kill the tree outside MAO; the next poll releases it |
| `provider cooldown until <time>` | Wait |

## Swarm preflight and origin binding

- Before any real-run Git sync, worktree creation, AI dispatch or direct `gh` write: one
  `gh api --method GET repos/{owner}/{repo}`, at startup and before each later cycle, so revoked access
  stops new work.
- Credential: the active `gh` one agents inherit. The store's `githubToken` is ignored, which is why
  the native platform adapter calls shared policy directly: `GithubService` would check the wrong credential.
- Rate limits, timeouts, 5xx, unclassified 403s: `SwarmPreflightTransientError`, never "missing
  permission". Startup exits 1 for every failure, with an actionable message; later cycles log and retry.
- A pass is not proof: grants stay unverified, and `git push` may use SSH or another helper this probe
  cannot establish.
- `GH_REPO` and `GH_HOST` are overridden for its calls and every agent (`SwarmPlatform.boundEnvironment()`), so a
  caller cannot preflight one repo or host and dispatch against another.
- Never log a remote URL or raw `gh` output: either can hold a credential (`SwarmPlatform.gh()`).

| Origin | Rule |
| --- | --- |
| Every effective fetch and push URL | Must identify one host/owner/repo, or refuse |
| `http://`, HTTPS off port 443 | Rejected: the default `gh` authority cannot prove them. HTTPS binds scheme, host, port 443 |
| SSH | `ssh -G` resolves aliases; effective host, user, port compared together. Sole equivalence: `ssh.github.com:443` equals `github.com:22` |
| Effective `ProxyCommand`/`ProxyJump` | Rejected, `--dry-run` too: can redirect beyond that proof |
| `core.sshCommand`, `GIT_SSH_COMMAND`, `GIT_SSH` on SSH origins | Real runs reject: `ssh -G` would not prove their target. `core.sshCommand` is all-scope: it changes even an explicit push |

## Swarm dispatch boundary

- `SwarmPlatform.prepareDispatch()` revalidates right before each dispatch, uncached: Workers in their task
  worktree, Reviewers and Maintainers in the repository checkout.
- Effective repository-local or worktree-local `remote.pushDefault`, `branch.<name>.pushRemote` and
  `branch.<name>.remote` must name `origin`; shadowed and global values cause no false rejection.
- Every child gets highest-precedence command-scope values pinning all three to `origin`
  (`prepareDispatch()`), so inherited selectors cannot redirect a bare push.
- `GIT_CONFIG_PARAMETERS` is rejected at real-run startup (`git -c`/hook diagnostic) and at spawn: Git
  applies it after those values.
- A detached repository root stays valid for Reviewer and Maintainer: origin, transport and
  `remote.pushDefault` are checked and pinned, branch selectors omitted. Task worktrees must stay
  attached to their branch.

## Swarm revision dispatch

- Accepts a same-repository, non-empty head ref. Fork PRs are refused: `origin` cannot update them.
- `fetchPrHead` fetches `refs/pull/<number>/head`; the commit must equal `headRefOid`, else retry
  next cycle.
- A missing local branch is created from that commit, **never** `origin/main`.
- A tracked-clean local ancestor fast-forwards to it, keeping non-conflicting untracked files.
- Tracked changes, conflicting untracked or ignored files, or divergence stay put with a blocker.
- Git and process calls pass the ref as argv with no shell; prompt examples use the shell-quote helper in `core/swarm/engine.ts`:
  command-example hygiene, not a trust boundary.

## Swarm prompt-content trust boundary

- Swarm does not sandbox hostile prompts. Run it only where task-authoring surfaces are trusted or
  moderated.
- Eligible `[Task]` Issue titles and bodies have no author gate before instructing tool-enabled
  Workers. PR titles and bodies have none either.
- Comments require an author login and either the active `gh` user or an explicit
  `OWNER`/`COLLABORATOR`/`MEMBER` association (`isTrustedComment` in `core/swarm/platform.ts`). Missing
  login or association fails closed, except the authenticated user needs no association. Fetch all
  paginated REST issue comments: `gh pr view --json comments` omits the association field. Trusted
  revision feedback then passes through as instructions.

## Swarm item isolation and retry budget

- A per-item failure (worktree, prompt or log write) skips neither later items nor merged-task
  cleanup. A failed authenticated-user lookup fails its PR batch closed.
- Every selected non-preflight setup or launch failure before registration consumes the crash budget
  (3 attempts per event).
- Typed per-item preflight blockers (`SwarmPreflightError`) stay retryable and spend no budget. Dedup
  key: lifecycle, exception class, finite `causeCode`, never the message; first occurrence is reported; uninterrupted repeats are suppressed without a traceback.
- A successful dispatch or definitive no-dispatch result clears the item's keys. Incomplete observation
  and provider-cooldown deferrals retain them: neither is a clean pass.
- `classifyProviderFailure()` (`core/swarm/cooldown.ts`) pauses a provider across items for rate/usage
  limits, budget-exempt; event-local timeout/tool withdrawals spend budget after the pause. Spend
  limits fall back to 24 hours, other unparsed limits to one hour. Explicit reset durations and Codex
  local "try again at" times take precedence, with a 60-second buffer and midnight/DST handling.
- Exit 0 is authoritative success: quoted limit text in a successful log never defers the run. Restart
  healing re-parses failed/deferred log tails against their historical run timestamps, not startup
  time. Status shows local and UTC reset times together.

## Swarm registry persistence

- `.agents/.process_registry.json` is replaced atomically in its directory. An invalid root or history
  container loads as empty; malformed entries are skipped one by one.
- Every real poll reconciles inherited `running`/`stuck` records: tree gone means `unknown`, retryable,
  one attempt spent; leader gone but group alive means `stuck`.
- `history` is diagnostic, capped at 500. Dispatch authority is `lifecycle_states`: one current event
  per role per Issue or PR, so roles never erase one another while repeated heads stay bounded.
- List every dispatchable role in `LIFECYCLE_ROLES`: `shouldDispatch` blocks while any is running or
  stuck on the item; an omitted role lets a second agent rewrite a live worktree.
- Prune closed terminal items only when the open list is shorter than the 1,000-item query limit, which
  proves it complete. `running`/`stuck` always survive.
- Cooldowns have their own bounded map. Legacy registries collapse into this schema on load; a valid
  current-version lifecycle table is authoritative even when empty, so pruned events do not resurrect
  from diagnostic history. Aggregate the maximum active deadline for each provider.

## Swarm process groups and shutdown

- Each agent gets its own POSIX process group; other platforms fail before the write preflight or any
  runtime file.
- `terminateProcessGroups` signals all eligible groups in one batch, with one shared deadline and
  forced-exit grace, on shutdown and when an agent's group leader exits (`ProcessTracker.poll()`).
- Polling and `--once` share the engine's signal handlers. Spawn and in-memory adoption are synchronous,
  so JavaScript signal callbacks run only after the child is supervised, even if adoption raises. Environment
  preflight runs before that window, registry persistence after it. Both modes then stop; `--once`
  skips merged-task cleanup.
- A child found unwinding before registration persisted is saved `running` before bounded termination,
  so a hard crash stays recoverable, then once more as removed or `stuck`: at most two saves.
- Failed termination persists `stuck`, is never re-signalled by numeric PGID (it may be reused), and
  blocks every role on that Issue or PR until an operator ends the tree. Shutdown stays non-zero rather
  than leave an untracked `git push` or `gh` write alive.

## Swarm worktree preservation

- One worktree per task at `.worktrees/<issue>`. A branch checked out elsewhere is a hard blocker.
- A damaged checkout gets `git worktree repair`. A non-empty damaged or mismatched directory is kept
  for a human, never recursively deleted.
- Merged-task cleanup locates the branch in `git worktree list --porcelain`, including a registered
  alternate path. It refuses the repository root, symlinks, wrong branch ownership and tracked,
  untracked or ignored local files. Only after safe removal and a fresh ownership check may its local
  task branch be deleted.

## Role assignment

Swarm tag grammar, identical for `Worker`, `Reviewer` and `Maintainer`:

```text
[Worker: <ai> | Model: <model> | Reasoning: <level>]
```

- All fields are required. `parseRole()` in `core/swarm/models.ts` matches case-insensitively and
  lower-cases the AI name. Last matching occurrence wins. It reuses `stripQuotedText()` so fenced code, inline
  code, HTML comments and blockquotes are examples, not active directives.
- The workflow engine uses its separate `[Worker: <providerId>]` form with task-wide `[Model:]` and
  `[Effort:]`; never substitute a Swarm CLI tool name for a registered provider id. See
  [workflow-and-routing.md](workflow-and-routing.md).

| Tag | Named by | Lives in |
| --- | --- | --- |
| Worker | Issue author, or the previous Maintainer's follow-up Issue | Body of an Issue titled `[Task] ...` |
| Reviewer | Worker | Body of its PR, titled `[PR] <issue> - <summary>` |
| Maintainer | Reviewer | Its approval comment, beside its own Reviewer tag |

- Worker, Reviewer and Maintainer must be **pairwise different** AIs (`validateDistinctRoles`). Using
  another model of the same AI does not satisfy maker-checker. Missing tags are not auto-filled.
- The approval's and feedback's Reviewer AI must equal the PR body's assignment, or dispatch blocks.

| AI | Models and compatibility | Effort encoding |
| --- | --- | --- |
| `claude` | `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`, `claude-haiku-4-5`; old prose aliases normalize | `--effort`; Haiku and retained legacy no-effort ids omit it |
| `codex` | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; retired/short aliases normalize | `-c model_reasoning_effort=<effort>` explicitly overrides local config |
| `antigravity` | `gemini-4-argon`, `gemini-3.8-flash`; older Gemini aliases normalize; foreign Claude/GPT families redirect to Gemini | `-low`, `-medium`, `-high` suffix, never `--effort` |

- The shared reasoning ladder is `low -> medium -> high -> xhigh -> max -> ultra`; English/Korean
  labels and punctuation normalize through `resolveReasoning()`. Unknown labels become `medium`.
  Excessive levels clamp: Claude and Codex Luna at `max`, Codex Sol/Terra at `ultra`, agy at `high`.
- `validateModelAvailability()` accepts registered aliases or explicit `custom:`/`unlisted:` models,
  reserved Codex review ids, and `SWARM_ALLOWED_CUSTOM_MODELS` comma-separated allowlist entries.
  Unknown models warn and use defaults. Custom agy models must still be Gemini to preserve family
  separation. Unknown AIs are rejected before launch.
- Initial Worker retains its requested effort; Reviewer and `worker_revise` use `medium`, Maintainer
  `low`. A Reviewer receives the PR description and at most 50,000 diff characters, with a truncation
  notice; it can inspect omitted changes.
- Worker and revision are tool-enabled; Reviewer and Maintainer keep restricted flags (`buildAiArgv`).
- Claude/Codex receive prompt bytes through stdin after durable ownership registration. Delivery has
  a 60-second deadline, handles EPIPE, and aborts on shutdown; no task text appears in their argv.
  agy retains the verified `--print <prompt>` argv contract with ignored stdin: prompt size is subject
  to OS argument limits and text is visible in local process listings. Do not assume stdin support.

The newest recognized trusted comment sets the next action (`determinePrAction`):

- Reviewer tag alone: `revise`; the Worker gets it as feedback.
- Reviewer and Maintainer tags: `maintain` only without negative or conditional approval text.
  "not approved", "changes requested", "needs further changes" and "conditionally approved"
  remain `revise`; negative feedback wins over positive words in the same comment.
- Maintainer tag and `[Maintainer Blocked]`: `review_after_maintainer_block`.
- `[Worker] Revision complete.`: `review`. A lone Maintainer tag changes nothing.

Maintainer merge, block and follow-up-Issue duties live in `core/swarm/engine.ts`. Before merging a
Draft PR, it checks `isDraft`, runs `gh pr ready`, then rechecks merge state and CI. A verified merge
precedes Issue closure and the single non-duplicate follow-up task; the orchestrator owns cleanup.

## Review checklist

Reviewer differs from implementer. Read the change with `gh pr diff <number> --repo <owner>/<repo>`. To
run it, `node scripts/check-origin.mjs "github.com/<owner>/<repo>"`, then
`git fetch origin refs/pull/<number>/head` and `git worktree add --detach "<dir>" FETCH_HEAD`, and run the
verification matrix there ([SKILL.md](../SKILL.md)). Check, in order:

1. Architecture rules: `core/` Electron-free? Logic in shells? Does the `core` vitest project still run
   with no plugins and no DOM?
2. Lockstep files: every row of `AGENTS.md`'s table, including the stage labels/options in all three UI copies.
3. New store-shape rule: does the field latch? Do whole-file observations upgrade it to restart-only?
   Are fresh observations limited to recovery, auto-trigger and imminent public-write boundaries? Does
   the report's scope match the correction's (reported more than corrected is allowed, not the reverse)?
   Does every destructive control the report offers gate on `nothingUsable`, not the problem existing?
4. New store write: does a value derived from a read write conditionally? Does a new backend merge into
   the file as it is now and take `withFileWriteLock`?
5. Domain invariants: every item in `AGENTS.md`, starting with maker-checker, CI gate, timeouts, error-not-crash.
6. Secrets hygiene: `gitleaks git --log-opts="<base>..<head>" --redact` for a published PR.
7. Style: match surrounding code; there is no autoformatter.

For a human request this is **local verification**. A GitHub comment, approval or merge needs explicit
user authorization; "review this" grants none.

A dispatched Swarm Reviewer is authorized by its dispatch prompt to post exactly one final summary
comment on the PR, carrying its own Reviewer tag:

- Approved: also `[Maintainer: <ai> | Model: <model> | Reasoning: <level>]`, per Role assignment.
- Changes needed: describe all required changes; **no** Maintainer tag.
- After a Maintainer block: re-evaluate its evidence, then request changes or approve anew.
- Keep tags out of earlier comments: a trusted comment with a Reviewer tag is itself a `revise` signal.
- Use `gh pr comment`: Swarm reads paginated REST issue comments, not review bodies. Re-fetch to
  confirm it landed; never invent a review, push, merge or follow-up result.
