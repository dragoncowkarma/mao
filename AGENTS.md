# AGENTS.md — MAO Agent Guide (Single Source of Truth)

This file is the **single source of truth** for every AI agent (Claude Code, Codex,
Antigravity, or any other tool) working in this repository. The tool-specific entry
files (`CLAUDE.md`, `.agents/rules/pointers.md`, `codex.md`) intentionally contain
nothing but a pointer here — keep it that way to avoid context fragmentation.

Operational knowledge (commands, verification steps, recipes) lives in
[SKILL.md](SKILL.md). Read **both** files before starting any task.

## What this project is

MAO is a dev-toolkit that lets AI agents drive a GitHub workflow — **issue → PR →
review → merge** — end to end, with a **maker-checker** safeguard so the same AI does
not review its own work — effective only when two or more distinct providers are
registered; a single-provider setup falls back to the same agent. One Electron-free
core powers two frontends:

- **Electron GUI** (`electron/` + `src/`): project sidebar, kanban board, workflow
  queue, settings.
- **Headless CLI** (`cli/`, bin name `mao`): the same engine over JSON-file
  persistence, bundled by esbuild.

TypeScript throughout, `strict: true`. License: Apache-2.0.

## Architecture map

| Path | Role |
| --- | --- |
| `core/workflow-engine.ts` | The state machine: queue, stage progression, CI gate, pause/advance/retry (agent routing itself lives in `core/agent-selection.ts`) |
| `core/agent-selection.ts` | Pure, renderer-importable agent routing: `resolveStageAgent()` (maker-checker + role pins + `allowedStages` + model/effort resolution), `isStageEligible()`, `eligibleAgentsForRun()`, `previewStageAgent()`, plus the `WorkflowRole`/`STAGE_ROLE`/`ProviderOverride`/`RunOverride` definitions (re-exported by `core/workflow-engine.ts`, so `core/assignment.ts` and the shells import them unchanged) |
| `core/github-service.ts` | Octokit REST wrapper (issues, PRs, labels, reviews, merge, CI status) — plus the read-only `checkRepoWorkflowCapability()` / `assertRepoWorkflowWritable()` preflight |
| `core/repo-capabilities.ts` | Pure verdict logic for "can this credential run the pipeline in this repo?" — `evaluateRepoCapability()`, `describeRepoCapability()`, `describeUnverifiedGrants()`, `RepoCapabilityError` |
| `core/repo-registry.ts` | Repository identity and the single definition of "this repo entry is newly registered" — `repoRefKey()`/`sameRepoRef()` (case-insensitive, as GitHub resolves owner/repo), `canonicalRepoList()`, `reposNeedingCapabilityCheck()` / `assertReposRegistrable()`, and the serialized `createRepoRegistrar()` both `github:setRepos` and `mao repos add`/`remove` write through |
| `core/git-workspace.ts` | Local git clone/branch/commit/push via `execFile` (no shell) |
| `core/swarm-runner.ts` | Shell-free launcher and repository/asset validation for the autonomous Swarm Orchestrator |
| `core/auto-trigger.ts` | Per-repo polling scheduler; auto-enqueues new open issues |
| `core/assignment.ts` | Issue/PR body directive parser — `parseAssignmentTags()` for swarm_orchestrator-style `[Worker: id]`/`[Reviewer: id]`/`[Maintainer: id]` role tags, and `parseProviderOverride()` which folds those plus task-level `[Model: id]`/`[Effort: level]` tags into a `ProviderOverride` |
| `core/store.ts` | `MaoStoreSchema`, `MAO_STORE_DEFAULTS`, the `MaoStore` interface, and `FileStore` (JSON impl for the CLI) |
| `core/app.ts` | `createMaoApp()` — the **single composition root** both frontends call |
| `core/paths.ts` | Platform-appropriate data dir for the CLI (mirrors Electron's `userData`) |
| `core/ai/` | `AiProvider` interface + adapters: `api-provider.ts` (Anthropic / OpenAI-compatible HTTP) and `cli-provider.ts` (spawns `claude`, `codex`, …) |
| `electron/main.ts` | BrowserWindow, external-link handling, dev/prod load |
| `electron/ipc.ts` | All `ipcMain.handle` channels — thin delegations only |
| `electron/preload.ts` | `contextBridge` exposing `window.electronAPI` |
| `electron/store.ts` | 7-line `electron-store` adapter satisfying `MaoStore` |
| `src/` | React 18 renderer (Vite + Tailwind); `App.tsx` owns all cross-view state |
| `cli/index.ts` | Commander CLI: `config` / `repos` / `github` / `workflow` / `run` / `swarm` |
| `.agents/workflows/swarm_orchestrator.py` | Autonomous Worker/Reviewer/Maintainer lifecycle, isolated worktrees, process registry, retry/cooldown, and safe merged-task cleanup; copied beside the CLI bundle by `scripts/build-cli.mjs` |
| `.agents/workflows/swarm_orchestrator_test.py` | Standalone Python worktree-safety regressions, included in `npm run test` |
| `scripts/test-workflow.ts` | Standalone e2e harness against a real (throwaway) repo |
| `scripts/check-origin.mjs` | Publish-preflight guard: validates every effective `origin` fetch/push URL against an expected host/owner/repo; failure output is fixed-category-only, never remote-derived strings (see SKILL.md) |
| `scripts/check-origin.test.mjs` | Committed negative/positive matrix for the guard incl. its no-leak contract — `npm run test:origin`, also run in CI |

## Non-negotiable architecture rules

1. **`core/` stays Electron-free.** Nothing under `core/` (or `cli/`) may import
   `electron`, `electron-store`, or anything under `electron/`. The dependency
   direction is `electron/* → core/*` and `cli/* → core/*`, never the reverse.
   Persistence is injected through the `MaoStore` interface (`core/store.ts`).
2. **Business logic lives in `core/`, never in the shells.** Every handler in
   `electron/ipc.ts` and every CLI action in `cli/index.ts` must stay a thin
   delegation to the store / `GithubService` / `WorkflowEngine` / auto-trigger. A
   feature added only in one shell breaks GUI↔CLI parity.
   The one scoped exception is Issue #31's CLI-only autonomous Swarm engine:
   `.agents/workflows/swarm_orchestrator.py` owns that long-lived process lifecycle,
   while `cli/index.ts` must remain a thin delegation to `core/swarm-runner.ts` for
   validation and shell-free launch. Do not duplicate Swarm behavior in the CLI shell.
3. **`createMaoApp()` (`core/app.ts`) is the only boot path.** Both shells call it;
   it wires token/providers/workspace, subscribes queue persistence to the engine's
   `'change'` event, and restores tasks. Workflow mutations must go through
   `WorkflowEngine` so persistence happens automatically — never write
   `workflowTasks` to the store directly.
4. **The `resume` flag is deliberately required (no default).** One-shot commands
   must pass `false` so inspecting config never side-effect-resumes real GitHub/AI
   calls. Current reality: `electron/ipc.ts` passes `resume: true`; `mao run` passes
   `false` and instead calls `workflowEngine.resumeProcessing()` **after** attaching
   its `'change'` stdout listener, so no transition is missed. (The docstring in
   `core/app.ts` claiming `mao run` passes `true` is stale — trust the code.)
5. **Never start the auto-trigger poller inside `createMaoApp()`.** Its
   `setInterval` keeps the process alive forever; only long-lived hosts
   (`electron/ipc.ts`, `mao run`) start it themselves.
6. **Renderer isolation.** `src/` never imports Node/Electron modules and reaches
   the main process only through `window.electronAPI`. It imports **types only**
   from `core/` (`import type`, extensionless). There are no IPC push events — the
   UI polls and re-fetches after each mutation; keep that pull model.
7. **Electron security posture.** `webPreferences` set only `preload` so Electron 33
   defaults apply (contextIsolation on, nodeIntegration off, sandbox on) — never
   weaken them. `setWindowOpenHandler` must keep returning `{ action: 'deny' }` and
   routing http/https to `shell.openExternal`.
8. **Tests must stay runnable under plain Node.** `vitest.config.ts` is deliberately
   separate from `vite.config.ts` (the electron/renderer plugins shim node builtins
   and break `core/` under Node). Vitest tests live in `core/**/*.test.ts` only;
   the one exception to the vitest layout is `scripts/check-origin.test.mjs`, a
   dependency-free standalone matrix invoked as `npm run test:origin`.
   The autonomous Swarm asset is the second explicit exception: its worktree-safety
   regressions live in `.agents/workflows/swarm_orchestrator_test.py` and run through
   `npm run test`, so Python 3 is required for the repository test matrix.

## Files that must change together

There is no codegen — these couplings are maintained by hand and only `npm run lint`
(tsc) catches part of the drift:

- **New IPC channel** → 3 files in lockstep: `electron/ipc.ts`
  (`ipcMain.handle('<domain>:<camelCaseAction>', …)`, domains `ai`/`github`/`workflow`),
  `electron/preload.ts` (same channel string, same namespace), `src/electron.d.ts`
  (mirror the signature). Channel strings are duplicated literals; a typo surfaces
  only at runtime.
- **Repository registration** → the add-vs-update rule lives ONLY in `core/repo-registry.ts`;
  `electron/ipc.ts`'s `github:setRepos` and `cli/index.ts`'s `repos add`/`repos remove` must all stay
  thin delegations to `createMaoApp()`'s `updateRepos`. Re-implementing the diff in either shell is how the two paths silently drift.
  A shell's update callback may match entries with core's `sameRepoRef`, but must never normalise or
  deduplicate the list itself — `updateRepos` owns that (see the identity invariant below).
  Both shells must also surface `describeUnverifiedGrants()` for the verdicts it returns — a passing
  preflight is not proof of write access, and a shell that stays silent about that claims more than
  the check established.
- **New store field** → both `MaoStoreSchema` and `MAO_STORE_DEFAULTS` in
  `core/store.ts` (tsc enforces the pair). `electron/store.ts` and `FileStore` pick
  the field up automatically.
- **New pipeline stage** → `STAGE_ORDER` + `buildPromptForStage` + `applyGithubAction`
  in `core/workflow-engine.ts`, **plus** the `STAGE_LABELS` record that is
  copy-pasted in both `src/components/KanbanBoard.tsx` and
  `src/components/WorkflowQueue.tsx`, plus `core/workflow-engine.test.ts`.
- **Build outputs** → `electron/main.ts` resolves `preload.js` and
  `../dist/index.html` relative to its own compiled location; the `dist-electron`
  directory name itself lives in `vite.config.ts` (`outDir`) and `package.json`
  (`main`, `build.files`), while the renderer's `dist/` is Vite's implicit
  default. Renaming any output means auditing all three files.

## Workflow-engine domain invariants

- Stages: `issue → pr → review → merge` (`STAGE_ORDER`). Task statuses:
  `pending | running | done | error | paused`.
- **Maker-checker**: `selectAgent()` excludes the `agentId` of the last
  `task.history` entry; falls back to the sole provider if only one is registered.
  Preserve this in any routing change.
- **Explicit provider assignment (`ProviderOverride`)**: a task can carry a preferred
  `providerId` (global, applies to every stage) and/or a per-role `roles` pin
  (`worker` → `issue`+`pr`, `reviewer` → `review`, `maintainer` → `merge`; a role pin
  wins over `providerId` for the stage(s) it names). Either is still fully subordinate
  to maker-checker — a preference/pin that would hand a stage back to the agent that
  ran immediately before it is passed over for another registered provider, or the
  stage fails clearly if none exists. The one deliberate exception: a Worker pin
  reusing itself across `issue → pr` is *not* a violation (same role, not a check on
  its own work), so that specific case skips the guard. `roles` is normally populated
  by `core/assignment.ts`'s `parseAssignmentTags()` reading `[Worker: id]` /
  `[Reviewer: id]` / `[Maintainer: id]` tags out of an auto-triggered issue's body
  (mirroring `dev-toolkit`'s `swarm_orchestrator.py` role-tag convention, but with its
  Model/Reasoning sub-fields split out into the separate task-level tags below rather
  than nested in the role tag) — or set directly via
  `mao workflow enqueue --worker/--reviewer/--maintainer`.
  An id that doesn't match a registered provider throws (retryable), same as an
  invalid `providerId`.
- **Model/effort overrides are preferences, not selection inputs**: `providerOverride`'s
  `model`/`effort` are applied to whichever provider maker-checker ends up choosing (on a
  copy — the saved provider config is never mutated), falling back to that provider's own
  `model`/`effort` or its active preset. Auto-triggered issues set them via task-level
  `[Model: <id>]` / `[Effort: <level>]` tags in the issue body, parsed by
  `parseProviderOverride()` — the body equivalent of `mao workflow enqueue --model/--effort`.
  A resolved effort is dropped entirely when the resolved model is flagged `noEffort` in
  `PROVIDER_OPTIONS` (`core/ai/provider-options.ts`) — no layer of the preference chain knows which
  model it will land on, and `core/ai/cli-provider.ts` would otherwise append a literal `--effort`
  flag to an invocation that doesn't take one.
  The model value is passed through verbatim (an unusable one fails provider-side); the
  effort value is validated against `AI_EFFORTS` in `core/ai/types.ts` — that list is the
  single definition the `AiEffort` union is derived from, so a new level must be added
  there and nowhere else. Validation runs *after* last-occurrence-wins, never as a
  per-match filter: an invalid amendment drops the override instead of falling back to the
  tag it superseded. Every directive tag is ignored inside code fences, inline code
  spans, HTML comments, and blockquotes, so documenting the syntax never acts as a directive.
- **A step records the tool it ran on, not a pointer to one**: `runStage()` snapshots
  `providerKindId` onto `task.active` and each `WorkflowStepResult` alongside name/model/effort.
  `ai:save` replaces the whole provider list at any time — including mid-stage, while a child process
  is still running on the config `selectAgent()` captured — so resolving a past or in-flight run's
  tool by looking its `agentId` up in the *current* list can describe it by a configuration it never
  used, or lose it when the provider is deleted. Only a *prediction* (`previewStageAgent()`) may read
  the live config, because that is what it is predicting from.
- **One-shot run overrides (`RunOverride`) are a third, stricter tier**: `retry(taskId, runOverride?)`
  / `advance(taskId, runOverride?)` accept a `{ providerId?, model?, effort? }` choice — what the
  Tool/Model/Effort dropdowns on a board or queue card send. It is stored as
  `QueuedTask.nextRunOverride`, and `runStage()` reads it into a local and clears it from the task
  **before the entry `notify()` and before any await**, so it applies to exactly one stage execution:
  neither a failure in that stage nor the next stage auto-advancing can reuse it, and it never
  touches the saved provider config or the task's durable `providerOverride`. It deliberately
  survives `restore()` — a crash between the click and the run should still honor the choice.
  Its `providerId` outranks both `providerOverride.roles[role]` and `providerOverride.providerId`,
  and it is guarded *more* strictly than either: where a stored pin that would violate maker-checker
  is silently passed over for another provider, a one-shot **throws** (the operator named this agent
  for this run; quietly running a different one would be worse than an error). The two exceptions
  match the stored rules — a Worker re-picking itself across `issue -> pr` is the same role carrying
  on, and a setup with no other stage-eligible provider relaxes rather than failing.
  `retry()`/`advance()` validate the override — effort against `AI_EFFORTS`, plus a dry-run
  `resolveStageAgent()` — *before* mutating the task, so a bad pick rejects the call itself instead
  of pushing the task to `'error'`.
- **Every stage is preflighted for repository write access**: `runStage()` awaits
  `github.assertRepoWorkflowWritable(task.repo…)` inside its `try`, after the entry `notify()` and
  **before** `selectAgent()` — so no AI provider call, git clone/push, or GitHub write can happen
  against a repo this credential cannot write. It is the single chokepoint every execution path
  funnels through (direct `enqueue`, `enqueueFromIssue`, `restore()`/resume, `retry()`, `advance()`),
  which is what makes registration-time validation non-bypassable. A failure lands in the existing
  catch: `'error'` at the *same* stage, retryable once the grant is restored. The verdict comes from
  one non-mutating `repos.get` — never a create-then-delete write probe — and `ok: true` means "no
  *known* blocker", not proof: a fine-grained token's or GitHub App installation's per-resource
  grants are unprovable without a write, so they are reported in `capability.unverified` and never
  folded into `ok`. Only permanent conditions become gaps; rate limiting, 5xx, socket errors and the
  60s deadline are rethrown so they stay transient. **No repo is exempt, `dragoncowkarma/mao`
  included.** It sits *after* the one-shot `nextRunOverride` is read and cleared (see the bullet
  above), so a preflight rejection consumes that choice along with the attempt — deliberately:
  keeping it armed would only look like it survived, because `retry()`/`advance()` re-arm from their
  own argument and the plain retry an operator actually clicks discards it anyway.
- **Single-flight queue**: `processQueue()` runs one stage at a time globally.
  Therefore every external call must be time-bounded. The API provider aborts
  after 5 min, the CLI provider SIGKILLs after 15 min, each actual Octokit HTTP
  attempt/page in `core/github-service.ts` gets a fresh 60 sec deadline, and every
  `execFile`-based git operation in `core/git-workspace.ts` has a 15 min watchdog
  that rejects independently after sending SIGKILL. A top-level Octokit call can
  take longer than 60 sec across plugin backoff, throttling, or pagination. Don't
  add unbounded calls. Timeouts must surface as task errors, never silent stalls.
- **Failures should be retryable states, not crashes**: any throw inside
  `runStage()`'s `try/catch` (including synchronous setup like `selectAgent()` —
  keep it inside) sets `status: 'error'` without advancing the stage, so `retry()`
  re-runs the same stage. Known gaps currently violate this — don't widen
  them; fixing them (with regression tests) is welcome:
  - the entry and exit `notify()` calls in `runStage()` (two of its three) sit
    outside the `try` (listeners run
    synchronously, and `createMaoApp` subscribes a synchronous `store.set`). A
    throwing listener on the entry `notify()` leaves the task stuck in
    `'running'`; on the exit `notify()` it loses the *persisted* advance after
    the stage's GitHub writes already succeeded — after a restart the stage
    re-runs and duplicates those writes;
  - `core/ai/cli-provider.ts` routes `child.stdin` `'error'` events through
    `settle()` to reject the execution promise, so a fast-exiting CLI or broken
    pipe surfaces as a normal task failure instead of an unhandled `EPIPE` crash.
- **`retry()` re-runs the stage, but stage actions are not idempotent**: the
  notes-only `pr` path runs branch → commit → PR, and `createBranch` rejects an
  existing ref — so a failure after branch creation leaves retry permanently
  stuck on `Reference already exists`. "Retryable" describes the state
  machine, not side-effect safety — making these actions idempotent (with
  regression tests) is welcome. (The merge stage merges before posting the
  summary comment to avoid duplicate comments when retry re-runs after a failed
  merge attempt, and treats post-merge comment failure as non-fatal so an already
  merged PR does not fail the task or invite re-merge retries.)
- **CI gate**: the merge stage only proceeds when `getChecksStatus` reports
  `'success'` or `'none'`; `'pending'` and `'failure'` throw (retryable). No CI
  configured on the target repo means "nothing to wait for". Note the check
  inspects the then-current PR head and the merge call doesn't pin an expected
  SHA — head movement between check and merge is a known race, not a guarantee.
- **Entry points differ by origin**: MAO-created tasks start at `issue`
  (`enqueue()`); already-existing GitHub issues (human-filed or auto-triggered)
  enter at `pr` via `enqueueFromIssue()`.
- **`restore()` replaces and normalizes the queue without emitting `'change'`**
  — account for that before changing startup persistence.
- **`allowToolUse` elevation** (`claude --dangerously-skip-permissions`,
  `codex -s workspace-write`) applies **only** to the `pr` stage's real-checkout
  path with a CLI provider. Never extend it to API providers or other stages.
- Issues entering the workflow get the `workflow-active` label, which is the
  **only** duplicate-enqueue protection (auto-trigger never checks the queue
  itself; the poller also enqueues **before** labeling) — and both label writes
  swallow failures via `.catch(() => {})`, so a
  failed label write means the same issue re-enqueues on every poll. Treat the
  label as best-effort, not a guarantee. Finished tasks are capped at 50 (oldest
  dropped).

## Safety rails — this app performs real GitHub writes

- **External writes need explicit task authorization.** A request to analyze,
  review, or verify something never authorizes GitHub writes. Do not create or
  close issues, push branches, open/comment/approve/merge PRs, create releases,
  or delete refs — on this repo or any target repo — unless the user's task
  explicitly calls for that specific write. Enqueueing a workflow task, `mao
  run`, `mao swarm` (except `--dry-run`/`--status`), `refreshRepo`, and the e2e
  harness all count: they drive the pipeline,
  which performs those writes unattended.
- **`githubRepos` has exactly one writer: `updateRepos` (`core/repo-registry.ts`).** It reads,
  preflights and writes as one *serialized* unit. The preflight is a network call, so it puts an await
  between the read and the write; without the queue a second update that arrives during it completes
  first, and the slow one then writes the list it was handed at request time — resurrecting a repo the
  operator removed while its registration was still checking (the store keeps it, the sidebar does
  not, and auto-trigger keeps polling it). Never write `githubRepos` through `store` directly, and
  never move this sequence into a shell.
- **Repository identity is case-insensitive, and the list is canonicalised before it is stored**:
  GitHub resolves owner/repo without regard to case, so `sameRepoRef()`/`repoRefKey()` lower-case
  both halves — otherwise `mao repos add DragonCowKarma MAO` registered a *second* entry for an
  already-tracked `dragoncowkarma/mao`, `startAutoTrigger` polled it twice, and (auto-trigger
  enqueues before writing the best-effort `workflow-active` label) both pollers could enqueue one
  issue and open two branches and PRs for it; `repos remove` spelled the other way matched neither
  entry. A case-insensitive comparison **alone** is unsafe: it makes `reposNeedingCapabilityCheck()`
  read a case variant as already-tracked, and the write would then persist a pair the preflight never
  checked. So `updateRepos` runs `canonicalRepoList()` inside its critical section, *before* the
  preflight — folding each entry that names an already-registered repo back onto the **stored**
  owner/repo strings and dropping duplicates (last occurrence wins, settings and position). Checked
  list and stored list are therefore the same bytes, and the guarantee holds by construction. Keep
  canonicalisation there, not in a shell. Deliberately **not** a lower-casing of stored entries:
  `QueuedTask.repo` is snapshotted at enqueue time and the board and queue views filter tasks by an
  exact `t.repo.owner === repo.owner`, so rewriting stored spellings would hide every task queued
  before the change — and it would misspell repositories back at the operator in the sidebar.
- **Registration and every stage are gated on a read-only permission preflight**
  (`core/repo-capabilities.ts`). Adding a repo — via the GUI sidebar or `mao repos add` —
  persists nothing unless the check passes; *updating* and *removing* an already-tracked repo
  deliberately skip it, so a repo whose access was revoked stays manageable. Auto-trigger runs
  the same check before `fetchTasks`, so an unauthorized repo yields zero `enqueueFromIssue` and
  zero `workflow-active` label writes. Never add an exemption list.
- The pipeline creates real issues, branches, PRs, reviews, and merges. Test only
  against throwaway repos (see SKILL.md).
- `github:refreshRepo` is **not a pure read**: it calls `autoTrigger.pollNow()`
  first, which can enqueue tasks — and `pollNow` bypasses the per-repo
  `autoTrigger: false` setting. Be deliberate when touching refresh/poll paths.
- `workflow enqueue` defaults to `autoAdvance: true` — an unattended full-pipeline
  run. One-shot CLI enqueue/retry/advance commands fire `void processQueue()` and
  keep the foreground process alive with **no progress output** until done.
- **Secrets**: never commit `.env` / `.env.*` (real tokens/API keys live in
  `.env.test`), never print `githubToken` or provider `apiKey` values (follow
  `config show`'s `'[set]'` redaction). The GitHub token is stored in plain text by
  the store backends — never log or commit store files.
- **`mao config set-token <token>` passes the token through argv** — it can land
  in shell history and process listings. Prefer the Electron settings UI for real
  tokens; never run it with a real token from an agent terminal or paste one
  into examples.
- **The real-edit `pr` path stages everything and force-pushes**: `commitAndPush`
  runs `git add -A` + `push --force` on the workflow branch. Never point
  `workspaceRoot` at a checkout holding unrelated work.
- **Keep child processes shell-free**: git and CLI providers use argument-array
  `execFile`/`spawn` with no shell — never introduce shell interpolation for
  user-controlled values.
- **Known token-exposure path**: `ensureClone` (`core/git-workspace.ts`) embeds
  the GitHub token in the HTTPS remote URL
  (`https://x-access-token:<token>@github.com/…`). That URL persists in each
  workspace clone's `.git/config`, so treat workspace `.git/config` files as
  secret-bearing: never paste them into issues, PRs, or logs. Git-command error
  output is already redacted — `core/git-workspace.ts`'s internal `run()` wrapper
  scrubs `err.message`, `err.stderr`, `err.stdout`, and `err.cmd` of the
  credential URL (added in `0a517e4` "secure exec wrapper", tightened in
  `b884f24` "resolve cmd leakage") — so task errors and the queue store no longer
  leak the token. Removing the credential from the URL would be a welcome fix.

## Code conventions

- **Formatting**: no semicolons, single quotes, 2-space indent, trailing commas,
  lines up to ~110 chars. There is no ESLint/Prettier — match surrounding code by
  hand; `npm run lint` is only `tsc --noEmit`.
- **Files**: kebab-case `.ts` in `core/`/`cli/`/`electron/`; PascalCase `.tsx`
  components in `src/components/` (one default-exported component per file; small
  helpers and subcomponents live in the same file above the export).
- **Imports**: Node-side code (`core/`, `cli/`, `electron/`) uses explicit `.ts`
  extensions; renderer code (`src/`) is extensionless (Vite). Node builtins always
  via `node:` prefix. Type-only imports always `import type`.
- **Exports**: named exports for core classes/functions/types; `export default`
  only for React components.
- **Comments**: rationale-heavy JSDoc on exported symbols and interface fields —
  explain *why* and cross-process implications (`core/app.ts` is the exemplar).
  Preserve and extend these doc comments when editing.
- **Errors**: guard clauses that throw early with contextual messages
  (`'GitHub token is not set'`); providers prefix `[${this.name}]`; renderer
  normalizes via `err instanceof Error ? err.message : String(err)`.
- **Async**: async/await; deliberate fire-and-forget marked with `void`; raw
  `Promise` constructor only for event-based child processes, with a `settled`
  guard and cleared timeouts.
- **Renderer/UI**: design tokens are CSS variables in `src/index.css` (`:root`);
  `tailwind.config.js` stays stock — never add tokens to the Tailwind theme or
  hardcode hex in TSX. Reusable visuals are semantic classes (`.btn`, `.card`,
  `.tag`, …) in `@layer components`; Tailwind utilities only for one-off layout
  tweaks on top. The design is intentionally sharp-cornered (`--radius-md: 0px`) —
  no `rounded-*`. Plain `useState`/`useEffect`, props-down/callbacks-up, no
  context/store/data-fetching libraries. Polling effects must `clearInterval` in
  cleanup and tolerate StrictMode double-invocation.

## Git conventions

- **Full rules**: see `.agents/rules/git-conventions.md` for the complete
  specification covering branches, commits, PRs, and tags.
- **Commits**: Conventional Commits format — `<type>(<scope>): <subject>`.
  Imperative subject, sentence case, no trailing period, 50-char limit.
  Non-trivial commits carry a ~72-char-wrapped body explaining root cause and why.
  Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `perf`, `ci`.
  Scopes: `core`, `cli`, `electron`, `ui`, `ai`, `workflow`, `github`.
- **Branches**: `<type>/<issue-number>-<kebab-description>` for manual branches.
  AI-agent branches (`claude/`, `codex/`) and engine branches (`workflow/`)
  keep their automated patterns. PRs merge into `main` via merge commits.
- **CI runs on every PR and push to `main`** (Node 22, Python 3.11): `npm ci`, `npm run lint`,
  `npm run test`, `npm run test:origin`, `npx vite build`. As of 2026-08 `main` has **no branch
  protection** (no required checks, no rulesets), so a green CI is convention,
  not a GitHub-enforced merge gate — treat it as required anyway. (Separate
  concept: the *app's own* merge stage checks the target repo's CI via
  `getChecksStatus` — that gate lives in the workflow engine, not in this repo's
  settings.) CI does **not** build the CLI bundle — run `npm run build:cli`
  yourself when touching `cli/` or `core/`.

## Agent roles & division of labor

Mirror the product's own maker-checker principle in how you work:

- **Planner/Architect**: reads this file + SKILL.md, scopes the change, lists the
  lockstep files affected (see "Files that must change together").
- **Implementer**: makes the change in `core/` first, then wires shells (Electron
  IPC chain and/or CLI command) so GUI/CLI parity holds, then UI.
- **Reviewer**: a *different* agent/session than the implementer whenever
  possible. Verifies invariants above, runs the SKILL.md verification workflow,
  and checks that no secrets or build outputs are staged.

## Known documentation drift — do not trust these

- `core/app.ts` docstring says `mao run` passes `resume: true` — it doesn't (see
  rule 4 above).
- README says "Copy the env template", but no `.env.example` exists — the only
  template is the inline block in the README.
- `src/index.css` references the 'Archivo' font, but nothing loads it; the UI
  renders the fallback stack. Don't add external font links (offline Electron).
