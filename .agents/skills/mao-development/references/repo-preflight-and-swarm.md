# Repository preflight and Swarm

Tier 3 reference — read when changing `core/repo-capabilities.ts`, `core/repo-registry.ts` or repository polling, running or changing `mao swarm`, assigning Swarm roles, or reviewing a PR. Rule summary: [AGENTS.md](../../../../AGENTS.md). Playbook: [SKILL.md](../SKILL.md).

- `mao swarm --repo-root <path>` can target any repository, so this MAO-specific file may be absent
  there; prompts name it conditionally (`SWARM_REVIEW_RULES_INSTRUCTION`). Absence is no blocker.
- Engine routing and the per-stage gate: [workflow-and-routing.md](workflow-and-routing.md). Store
  concurrency and `githubRepos` recovery: [store-and-recovery.md](store-and-recovery.md).
- Swarm proof: `.agents/workflows/swarm_orchestrator_test.py`. It does not pin Role assignment's
  `validate_distinct_roles` rejection, Reviewer-AI equality, `Model:`/`Reasoning:` maps, or the
  `maintain`, `review_after_maintainer_block` and `[Worker] Revision complete.` signals.

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

Tables are intentionally duplicated. Audit together; add regressions to both suites
(`core/repo-capabilities.test.ts` and the Swarm one).

| Must stay aligned | `core/repo-capabilities.ts` | `.agents/workflows/swarm_orchestrator.py` |
| --- | --- | --- |
| Gap ids, reasons | `RepoCapabilityGap`, `GAP_REASONS` | `_CAPABILITY_GAP_REASONS` |
| Remedy kinds, text, rank | `GAP_REMEDY`, `REMEDY_TEXT`, `REMEDY_RANK` | `_CAPABILITY_GAP_REMEDIES`, `_CAPABILITY_REMEDY_TEXT`, `_CAPABILITY_REMEDY_RANK` |
| Public/private scopes, three-state push | `evaluateRepoCapability` | `_evaluate_repo_workflow_capability` |
| Unverified grants | `PIPELINE_GRANTS`, `UNVERIFIED_LABELS` | `_PIPELINE_GRANTS`, `_UNVERIFIED_GRANT_LABELS` |

Deliberately different, because Swarm checks the active `gh` credential: credential acquisition
(`token-missing` vs `gh-not-authenticated`), failure
classification (`classifyLookupFailure` vs `_classify_gh_api_failure`), wording naming that credential.

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

Needs Python 3 (`MAO_SWARM_PYTHON`), `git`, authenticated `gh` and the CLIs the tags name. Target: the
checkout containing the current directory, or `--repo-root <path inside it>`. `npm run cli` runs from this
package's root, so without `--repo-root` it targets MAO itself.
It can create issues and comments, push, review, merge and close issues: a real run needs explicit
task authorization.

| Invocation | GitHub | Local writes | Exit |
| --- | --- | --- | --- |
| `mao swarm --status` | none, no target resolution | none | 0 |
| `mao swarm --dry-run --once` | reads only; binds origin; skips write probe, `core.sshCommand`/`GIT_SSH*` check | none | 0, or 1 on failure |
| `mao swarm --once` | real dispatch and writes | runtime paths, task branches, fast-forward of a clean local `main` (`sync_main_branch`) | 0, with dispatched agents left running detached; 1 if an item failed, or if a signal's cleanup left a tree; 130 on signal |
| `mao swarm [--interval <seconds>]` | same, polling (default 30 s) | runtime paths, task branches, fast-forward of a clean local `main` (`sync_main_branch`) | 0 on signal; 1 if a tree survives |

- `--dry-run` without `--once` polls forever.
- `--reset` is a flag on a run, never a standalone clear: after deleting the registry it goes on to the
  preflight and real dispatch (`--once`: one cycle; else polling), so it needs the same authorization.
- Its own mutation is the registry alone, even if the next preflight fails: the one write before the
  network gate, so it works during access repair. With `--dry-run` it only logs; `--status` ignores it.
- It forgets `running`/`stuck` ownership and cooldowns: stop residual trees first. It forgets every
  item's events too: completed ones read as `new event` and can dispatch again. Proof: `main()`,
  `should_dispatch`.
- A startup preflight failure exits 1 and creates no runtime file.
- Runtime paths: `.worktrees/<issue>`, `.agents/.process_registry.json`, `.agents/logs/`,
  `.agents/.prompts/`. Added to `.git/info/exclude` only; it never edits or commits `.gitignore`.
- Real runs also change Git state outside runtime paths: fetch, fast-forward of a clean local `main`
  (`sync_main_branch`), task branches (`create_worktree`), and for merged PRs `git worktree remove` plus
  `git branch -D` (`cleanup_worktree`).

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
  this stays in Python: `GithubService` would check the wrong credential.
- Rate limits, timeouts, 5xx, unclassified 403s: `SwarmPreflightTransientError`, never "missing
  permission". Startup exits 1 for every failure, with an actionable message; later cycles log and retry.
- A pass is not proof: grants stay unverified, and `git push` may use SSH or another helper this probe
  cannot establish.
- `GH_REPO` and `GH_HOST` are overridden for its calls and every agent (`_bound_gh_environment`), so a
  caller cannot preflight one repo or host and dispatch against another.
- Never log a remote URL or raw `gh` output: either can hold a credential (`_run_gh`).

| Origin | Rule |
| --- | --- |
| Every effective fetch and push URL | Must identify one host/owner/repo, or refuse |
| `http://`, HTTPS off port 443 | Rejected: the default `gh` authority cannot prove them. HTTPS binds scheme, host, port 443 |
| SSH | `ssh -G` resolves aliases; effective host, user, port compared together. Sole equivalence: `ssh.github.com:443` equals `github.com:22` |
| Effective `ProxyCommand`/`ProxyJump` | Rejected, `--dry-run` too: can redirect beyond that proof |
| `core.sshCommand`, `GIT_SSH_COMMAND`, `GIT_SSH` on SSH origins | Real runs reject: `ssh -G` would not prove their target. `core.sshCommand` is all-scope: it changes even an explicit push |

## Swarm dispatch boundary

- `_prepare_ai_process_spawn` revalidates right before each dispatch, uncached: Workers in their task
  worktree, Reviewers and Maintainers in the repository checkout.
- Effective repository-local or worktree-local `remote.pushDefault`, `branch.<name>.pushRemote` and
  `branch.<name>.remote` must name `origin`; shadowed and global values cause no false rejection.
- Every child gets highest-precedence command-scope values pinning all three to `origin`
  (`_bound_dispatch_environment`), so inherited selectors cannot redirect a bare push.
- `GIT_CONFIG_PARAMETERS` is rejected at real-run startup (`git -c`/hook diagnostic) and at spawn: Git
  applies it after those values.
- A detached repository root stays valid for Reviewer and Maintainer: origin, transport and
  `remote.pushDefault` are checked and pinned, branch selectors omitted. Task worktrees must stay
  attached to their branch.

## Swarm revision dispatch

- Accepts a same-repository, non-empty head ref. Fork PRs are refused: `origin` cannot update them.
- `fetch_pr_head` fetches `refs/pull/<number>/head`; the commit must equal `headRefOid`, else retry
  next cycle.
- A missing local branch is created from that commit, **never** `origin/main`.
- A tracked-clean local ancestor fast-forwards to it, keeping non-conflicting untracked files.
- Tracked changes, conflicting untracked or ignored files, or divergence stay put with a blocker.
- Git and process calls pass the ref as argv with no shell; prompt examples use `shlex.quote`:
  command-example hygiene, not a trust boundary.

## Swarm prompt-content trust boundary

- Swarm does not sandbox hostile prompts. Run it only where task-authoring surfaces are trusted or
  moderated.
- Eligible `[Task]` Issue titles and bodies have no author gate before instructing tool-enabled
  Workers. PR titles and bodies have none either.
- Comments count only from the active `gh` user or `OWNER`/`COLLABORATOR`/`MEMBER`; revision feedback
  then passes through as instructions.

## Swarm item isolation and retry budget

- A per-item failure (worktree, prompt or log write) skips neither later items nor merged-task
  cleanup. A failed authenticated-user lookup fails its PR batch closed.
- Every selected non-preflight setup or launch failure before registration consumes the crash budget
  (`MAX_DISPATCH_ATTEMPTS`, 3).
- Typed per-item preflight blockers (`SwarmPreflightError`) stay retryable and spend no budget. Dedup
  key: lifecycle, exception class, finite `reason_code`, never the message; first at error, repeats at
  debug, no traceback.
- A successful dispatch or definitive no-dispatch result clears the item's keys. Incomplete observation
  and provider-cooldown deferrals retain them: neither is a clean pass.
- `PROVIDER_LIMIT_PATTERNS` pause that AI on every item, budget-exempt. `EVENT_DEFER_PATTERNS` spend
  budget after the pause, so they cannot retry forever.

## Swarm registry persistence

- `.agents/.process_registry.json` is replaced atomically in its directory. An invalid root or history
  container loads as empty; malformed entries are skipped one by one.
- Every real poll reconciles inherited `running`/`stuck` records: tree gone means `unknown`, retryable,
  one attempt spent; leader gone but group alive means `stuck`.
- `history` is diagnostic, capped at 500. Dispatch authority is `lifecycle_states`: one current event
  per role per Issue or PR, so roles never erase one another while repeated heads stay bounded.
- List every dispatchable role in `LIFECYCLE_ROLES`: `should_dispatch` blocks while any is running or
  stuck on the item; an omitted role lets a second agent rewrite a live worktree.
- Prune closed terminal items only when the open list is shorter than `OPEN_ITEMS_LIMIT` (1,000), which
  proves it complete. `running`/`stuck` always survive.
- Cooldowns have their own bounded map. Legacy registries collapse into this schema on load.

## Swarm process groups and shutdown

- Each agent gets its own POSIX process group; other platforms fail before the write preflight or any
  runtime file.
- `terminate_process_groups` signals all eligible groups in one batch, with one shared deadline and
  forced-exit grace, on shutdown and when an agent's group leader exits (`poll_all`).
- Polling and `--once` share `_shutdown_signal_controller`. A signal between spawn and in-memory
  adoption defers until the child is supervised, even if spawn or adoption raises. Environment
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

## Role assignment

Swarm tag grammar, identical for `Worker`, `Reviewer` and `Maintainer`:

```text
[Worker: <ai> | Model: <model> | Reasoning: <level>]
```

- All fields required, or no match (`WORKER_PATTERN` and siblings). Case-insensitive; first match wins;
  `parse_role` lower-cases `<ai>`.
- No code-fence exclusion: a concrete tag quoted anywhere parses; a literal `<ai>` never does.
- Two systems, neither parser reading the other's: this form vs the workflow engine's
  `[Worker: <providerId>]` plus separate `[Model:]`, `[Effort:]`
  ([workflow-and-routing.md](workflow-and-routing.md)).

| Tag | Named by | Lives in |
| --- | --- | --- |
| Worker | Issue author, or the previous Maintainer's follow-up Issue | Body of an Issue titled `[Task] ...` |
| Reviewer | Worker | Body of its PR, titled `[PR] <issue> - <summary>` |
| Maintainer | Reviewer | Its approval comment, beside its own Reviewer tag |

- Worker, Reviewer and Maintainer must be **pairwise different** AIs within one issue->PR lifecycle
  (`validate_distinct_roles`). The same AI with another model still violates it; nothing is dispatched.
- A Worker and Reviewer thus leave one valid Maintainer. `DEFAULT_ROTATION` is a convention no code
  reads: a missing tag is never filled in.
- The approval's and feedback's Reviewer AI must equal the PR body's, or dispatch is blocked.

| `<ai>` | CLI (`build_ai_argv`) | `Model:` | `Reasoning:` |
| --- | --- | --- | --- |
| `claude` | `claude -p` | `sonnet 5`, `opus 5`, `fable 5`, `haiku 4.5`, full IDs (`_CLAUDE_MODEL_MAP`); others verbatim | `--effort` from `_CLAUDE_EFFORT_MAP` |
| `codex` | `codex exec` | `5.6`, `5.6 sol`, `5.6 terra`, `5.6 luna`, `5.5`, `5.4`, `5.4 mini` (`_CODEX_MODEL_MAP`); others verbatim. All but sol, luna run `gpt-5.6-terra` | Ignored: no flag |
| `antigravity` | `agy` (not a valid `<ai>`) | Ignored: `Gemini 3.6 Flash (<effort>)` (`_resolve_agy_model`) | Suffix from `_AGY_EFFORT_LABEL` |

| `Reasoning:` | Claude | Antigravity |
| --- | --- | --- |
| `high`, `높음`, `울트라`, `매우 높음`, `thinking` | `high` | `High` |
| `medium`, `중간` | `medium` | `Medium` |
| `low`, `낮음`, `light` | `low` | `Low` |
| `엑스트라` | `xhigh` | `High` |
| `최대`, `ultracode` | `max` | `High` |
| Anything else, including literal `xhigh`, `max` | `medium` | `High` |

- `_map_reasoning_to_effort` has no caller; it is not the authority.
- Any other `<ai>` raises at dispatch and spends the budget.
- Worker and revision run tool-enabled; Reviewer and Maintainer restricted (flags: `build_ai_argv`).

The newest recognized trusted comment sets the next action (`determine_pr_action`):

- Reviewer tag alone: `revise`; the Worker gets it as feedback.
- Reviewer and Maintainer tags: `maintain`.
- Maintainer tag and `[Maintainer Blocked]`: `review_after_maintainer_block`.
- `[Worker] Revision complete.`: `review`. A lone Maintainer tag changes nothing.

Maintainer merge, block and follow-up-Issue duties: its prompt in `dispatch_maintainer`.

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
- Use `gh pr comment`: Swarm reads `gh pr view --json comments`, not review bodies. Re-fetch to confirm
  it landed (`EXECUTION_INTEGRITY_NOTICE`).
