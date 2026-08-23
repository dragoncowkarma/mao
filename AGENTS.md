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
| `core/workflow-engine.ts` | The state machine: queue, stage progression, maker-checker agent routing, CI gate, pause/advance/retry |
| `core/github-service.ts` | Octokit REST wrapper (issues, PRs, labels, reviews, merge, CI status) |
| `core/git-workspace.ts` | Local git clone/branch/commit/push via `execFile` (no shell) |
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
| `cli/index.ts` | Commander CLI: `config` / `repos` / `github` / `workflow` / `run` |
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

## Files that must change together

There is no codegen — these couplings are maintained by hand and only `npm run lint`
(tsc) catches part of the drift:

- **New IPC channel** → 3 files in lockstep: `electron/ipc.ts`
  (`ipcMain.handle('<domain>:<camelCaseAction>', …)`, domains `ai`/`github`/`workflow`),
  `electron/preload.ts` (same channel string, same namespace), `src/electron.d.ts`
  (mirror the signature). Channel strings are duplicated literals; a typo surfaces
  only at runtime.
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
  The model value is passed through verbatim (an unusable one fails provider-side); the
  effort value is validated against `AI_EFFORTS` in `core/ai/types.ts` — that list is the
  single definition the `AiEffort` union is derived from, so a new level must be added
  there and nowhere else. Every directive tag is ignored inside code fences, inline code
  spans, HTML comments, and blockquotes, so documenting the syntax never acts as a directive.
- **Single-flight queue**: `processQueue()` runs one stage at a time globally.
  Therefore every external call must be time-bounded. Today only the AI-provider
  calls are: the API provider aborts after 5 min, the CLI provider SIGKILLs after
  15 min. **Octokit calls (`core/github-service.ts`) and git operations
  (`core/git-workspace.ts`) have no timeout** — a hang there stalls the whole
  queue indefinitely. Don't add more unbounded calls; adding timeouts to the
  existing gaps is welcome. Timeouts must surface as task errors, never silent
  stalls.
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
  - `core/ai/cli-provider.ts` never handles `child.stdin` `'error'` events, so
    writing a large prompt to a fast-exiting CLI crashes the process with an
    unhandled `EPIPE` instead of failing the task.
- **`retry()` re-runs the stage, but stage actions are not idempotent**: the
  notes-only `pr` path runs branch → commit → PR, and `createBranch` rejects an
  existing ref — so a failure after branch creation leaves retry permanently
  stuck on `Reference already exists`; the merge stage comments before merging,
  so a failed merge means retry posts a duplicate comment. "Retryable" describes
  the state machine, not side-effect safety — making these actions idempotent
  (with regression tests) is welcome.
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
  run`, `refreshRepo`, and the e2e harness all count: they drive the pipeline,
  which performs those writes unattended.
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
  workspace clone's `.git/config`, and when a git command fails, the `execFile`
  error message echoes the credential URL — which lands in `task.error`, the
  persisted queue, and `mao run` stderr / the UI. Treat task errors, the queue
  store, and workspace `.git/config` files as secret-bearing: never paste them
  into issues, PRs, or logs. Removing the credential from the URL (or redacting
  git errors) would be a welcome fix.

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
- **CI runs on every PR and push to `main`** (Node 22): `npm ci`, `npm run lint`,
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

- `README.md` "Architecture" section predates the `core/` extraction: it claims
  `ai/`, `workflow-engine.ts`, `github-service.ts`, etc. live under `electron/`.
  They live under `core/`. The README also doesn't mention the CLI at all.
- `core/app.ts` docstring says `mao run` passes `resume: true` — it doesn't (see
  rule 4 above).
- README says "Copy the env template", but no `.env.example` exists — the only
  template is the inline block in the README.
- `src/index.css` references the 'Archivo' font, but nothing loads it; the UI
  renders the fallback stack. Don't add external font links (offline Electron).
