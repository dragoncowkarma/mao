# AGENTS.md — MAO Agent Guide (Single Source of Truth)

This file is the **single source of truth** for every AI agent (Claude Code, Codex,
Antigravity, or any other tool) working in this repository. The tool-specific entry
files (`CLAUDE.md`, `.agents/rules/pointers.md`, `codex.md`) intentionally contain
nothing but a pointer here — keep it that way to avoid context fragmentation.

Operational knowledge (commands, verification steps, recipes) is now merged below.

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
| `scripts/check-origin.mjs` | Publish-preflight guard: validates every effective `origin` fetch/push URL against an expected host/owner/repo; failure output is fixed-category-only, never remote-derived strings (see below) |
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
  against throwaway repos (see End-to-end pipeline test).
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

- **Commits**: imperative subject, sentence case, no trailing period, often
  stating the consequence ("Fix external links being silently swallowed").
  Non-trivial commits carry a ~72-char-wrapped body explaining root cause and why.
- **Branches**: historically `claude/<kebab-topic>-<hex>`; feature branches like
  `feature/<topic>` are also fine. PRs merge into `main` via merge commits.
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

- **Planner/Architect**: reads this file, scopes the change, lists the
  lockstep files affected (see "Files that must change together").
- **Implementer**: makes the change in `core/` first, then wires shells (Electron
  IPC chain and/or CLI command) so GUI/CLI parity holds, then UI.
- **Reviewer**: a *different* agent/session than the implementer whenever
  possible. Verifies invariants above, runs the verification workflow,
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
# MAO Operational Playbook

Commands, verification workflows, and step-by-step recipes for working in this repo.
Architecture rules, invariants, and conventions live in [AGENTS.md](AGENTS.md) — read
that first; this file assumes you have.

> ⚠️ Paths may contain spaces (the working copy can live on a volume like
> `NO NAME`) — always quote paths in shell commands.

## Setup

```bash
npm ci             # locked graph, same as CI; Node 22 is what CI uses (CLI bundle targets node18)
```

Use `npm install` only when intentionally changing dependencies + lockfile.

## Command reference

| Command | What it does |
| --- | --- |
| `npm run dev` | Electron + Vite dev server with hot reload |
| `npm run lint` | `tsc --noEmit` — the only automated style/type gate (no ESLint/Prettier) |
| `npm run test` | `vitest run` — node env, `core/**/*.test.ts` only |
| `npm run test:origin` | Standalone matrix for `scripts/check-origin.mjs` (verdicts + no-credential-leak contract) |
| `npm run build` | `vite build` + `electron-builder --dir` (fast unpacked build → `release/`) |
| `npm run dist` | Full distributable (dmg/zip on mac) |
| `npm run build:cli` | esbuild-bundle `cli/index.ts` → `dist-cli/index.cjs` (CJS, node18) |
| `npm run cli -- <args>` | Build the CLI bundle, then run it (e.g. `npm run cli -- config show`) |
| `npm run preview` | Vite preview of the built renderer |

**Never run the CLI via `tsx`** — it fails on `@octokit/app`
(`ERR_PACKAGE_PATH_NOT_EXPORTED`). Always go through the esbuild bundle
(`npm run cli` / `npm run build:cli`). Note `build:cli` ends with `chmod +x`,
which fails under Windows' default npm shell — on Windows run the esbuild step
manually (the bundle is invoked via `node` anyway) or use Git Bash/WSL.

## Verification workflow

Verification runs the current **filesystem**, not a Git object. A blank
`git status --short` proves only that there are no **non-ignored** source
changes — ignored artifacts (`dist/`, `dist-electron/`, `dist-cli/`,
`node_modules/`) and `.env*` files or ambient environment variables still
influence the commands, and in a dirty/mixed worktree unstaged edits can make
validation pass for code the commit doesn't contain. When you need strong
evidence that an exact SHA passes, use an isolated detached worktree with a
fresh install and a controlled environment:

```bash
git worktree add --detach "<dir>" "<sha>"
```

then run `npm ci` and the matrix below inside `<dir>`.

CI runs, in order, `npm ci` → `npm run lint` → `npm run test` →
`npm run test:origin` → `npx vite build` on Node 22 for pushes to `main` and
all PRs. Locally (dependencies already installed):

```bash
npm run lint && npm run test && npm run test:origin && npx vite build
```

Additionally, because CI does **not** cover them:

- Touched `cli/` or `core/`? → also run `npm run build:cli` and smoke-test
  `node dist-cli/index.cjs --help` (CLI bundle breakage is invisible to CI).
- Iterating on the engine? → focused run: `npx vitest run core/workflow-engine.test.ts`.
- Touched `scripts/`? → note `scripts/` is not in `tsconfig.json`'s `include`, so
  tsc/CI never typechecks it — verify by actually running the harness.
- Touched the IPC surface? → **nothing automated** checks that
  `electron/preload.ts` and `src/electron.d.ts` stay consistent (`contextBridge`
  takes an untyped object, so tsc checks each file only against core types, not
  against each other). Diff the two by eye and smoke-test with `npm run dev` —
  channel-string typos and preload/d.ts drift both fail only at runtime.

## Headless CLI usage

State lives at `$MAO_DATA_DIR/config.json` (default: the platform data dir from
`core/paths.ts`, e.g. `~/Library/Application Support/mao` on macOS); clones go to
`$MAO_DATA_DIR/workspaces`. Set `MAO_DATA_DIR` to isolate test state.

```bash
npm run cli -- config set-token <token>          # store GitHub token
npm run cli -- config import-providers <file>    # JSON array of AiProviderConfig
npm run cli -- config show                       # secrets redacted as '[set]'
npm run cli -- repos add <owner> <repo> [--no-auto-trigger] [--poll-interval-ms <ms>]
npm run cli -- repos list
npm run cli -- github check <owner> <repo>       # open issues/PRs as JSON
npm run cli -- github view <owner> <repo> <number>  # full body + comments for one issue/PR as JSON
npm run cli -- workflow enqueue "<title>" --owner <o> --repo <r> [--no-auto-advance]
npm run cli -- workflow list
npm run cli -- workflow retry <taskId>
npm run cli -- workflow advance <taskId>
npm run cli -- workflow clear-completed
npm run cli -- run                               # foreground: auto-trigger + resume queue
```

⚠️ `workflow enqueue` without `--no-auto-advance` runs the **entire pipeline
unattended** (real GitHub writes) in the foreground with no progress output; only
`run` streams status. Use `--no-auto-advance` + `workflow advance` to step through
stages one at a time.

## End-to-end pipeline test (real GitHub repo)

Use a **throwaway repo** — the harness creates real issues/branches/PRs and can
merge them. Create `.env.test` (gitignored; the template is the inline block in
README.md — there is no `.env.example` file):

```bash
node --experimental-strip-types --env-file=.env.test scripts/test-workflow.ts
```

Required: `TEST_GITHUB_OWNER`, `TEST_GITHUB_REPO`, `TEST_GITHUB_TOKEN`, plus at
least one provider — either `TEST_AI_API_KEY` (with optional `TEST_AI_API_FORMAT`
`anthropic|openai`, `TEST_AI_MODEL`) or `TEST_AI_CLI_COMMAND` (+
`TEST_AI_CLI_ARGS`, space-split). A second provider uses the `TEST_AI2_*` prefix —
register two so maker-checker has somewhere to route. Optional:
`TEST_TASK_TITLE`, `TEST_WORKSPACE_ROOT`.

Two traps:

- **Omit unused optional vars entirely** — don't leave them blank as in the
  README's inline template: `TEST_AI_MODEL=` sends an empty-string model, and
  `TEST_AI_CLI_ARGS=` becomes a `['']` argv.
- **The harness exits 0 even when the task ends in `error`** — judge the run by
  the printed final task JSON, not the exit code (don't gate automation on it).

## Recipes

### Add an IPC channel (renderer ↔ main)

1. Implement the logic in `core/` (engine/service method), not in the shell.
2. `electron/ipc.ts` — `ipcMain.handle('<domain>:<camelCaseAction>', …)` as a
   one-line delegation (domains: `ai`, `github`, `workflow`).
3. `electron/preload.ts` — same channel string, same namespace, positional args.
4. `src/electron.d.ts` — mirror the method signature.
5. If the CLI should have parity, add the matching subcommand in `cli/index.ts`.
6. `npm run lint`, then smoke-test in `npm run dev` (typos fail only at runtime).

### Add a store field

1. Add to **both** `MaoStoreSchema` and `MAO_STORE_DEFAULTS` in `core/store.ts`.
2. Backends (`electron/store.ts`, `FileStore`) pick it up automatically.
3. Renderer needs it? Add get/set IPC channels (recipe above). CLI needs it?
   Extend `cli/index.ts` (keep `config show` redaction for anything secret).

### Add a pipeline stage

1. `core/workflow-engine.ts`: the `WorkflowStageName` union, `STAGE_ORDER`,
   `buildPromptForStage`, `applyGithubAction` (+ `runPrWithCodeEdits`-style
   special-casing if needed).
2. Update `STAGE_LABELS` in **both** `src/components/KanbanBoard.tsx` and
   `src/components/WorkflowQueue.tsx` (duplicated by convention).
3. Extend `core/workflow-engine.test.ts` — stage progression, maker-checker
   alternation, and error/retry behavior against the existing fakes.

### Add an AI provider integration

- New HTTP API shape → extend `core/ai/api-provider.ts`, the `apiFormat` union
  in `core/ai/types.ts`, and the format picker in
  `src/components/GlobalSettings.tsx`.
- New local CLI → extend the per-CLI flag tables in `core/ai/cli-provider.ts`
  (system-prompt and tool-use flags). Keep the 15-min SIGKILL timeout; keep
  `allowToolUse` flags scoped to the `pr` stage path only.

### Ship a change (PR workflow)

1. Preflight — **before creating any branch**, record the starting state:
   `git status --short --branch` (current branch or detached HEAD, and any
   pre-existing changes — note them now, because a dirty checkout's edits
   follow the new branch and their provenance is lost afterwards). Then
   Confirm the identity of **`origin` itself** before fetching or branching —
   not the GH CLI's notion of the repo: `gh repo set-default` can point a bare
   `gh repo view` at a different repository than `origin`, so it is no
   evidence of where you will branch from and push to. A field-split
   one-liner is not enough either: it blesses deceptive paths
   (`https://evil.example/github.com/<owner>/<repo>.git`), can echo
   credentials from malformed URLs, and never sees a divergent
   `remote.origin.pushurl` (git pushes to **every** configured push URL).
   Use the tested helper, which enumerates all effective fetch/push URLs,
   isolates userinfo/query without printing them, and anchored-matches
   scheme, real authority, and exact path — failing closed on anything else:

   ```bash
   node scripts/check-origin.mjs "github.com/<owner>/<repo>"
   ```

   (The argument form works in every shell — PowerShell/cmd have no inline
   env syntax; `MAO_EXPECTED_REMOTE` remains a fallback.) Its failure output
   is deliberately fixed-category-only, never remote-derived strings, and its
   committed matrix runs as `npm run test:origin` locally and in CI. It must
   print `OK` (exit 0) before any fetch/branch/push, and
   every subsequent `gh` command must pin `--repo <owner>/<repo>` explicitly.
   Then `git fetch origin` and branch from the **current** `origin/main` — a
   local `main` ref can lag the remote by many commits. Note the exact base
   SHA, and check for an existing same-scope PR to reuse
   (`gh pr list --repo <owner>/<repo>`) instead of opening a duplicate.
   Branch names: `feature/<topic>` or `claude/<topic>-<hex>`.
2. Stage only the paths the task intended — avoid `git add -A` in a worktree
   that may hold unrelated changes. Never stage: `.env*`, `dist/`,
   `dist-electron/`, `dist-cli/`, `release/`, store/config files, or anything
   containing a token.
3. Verify the staged scope **without printing potential secret values**, in
   this order (plain `git diff` compares worktree↔index and misses
   already-staged content entirely):
   1. `git diff --cached --name-status` — every listed path must be one the
      task intended; unstage anything else.
   2. A staged-secret scan with a **vetted, version-pinned scanner** that
      reports only rule/path/line and redacts values. The current gitleaks
      staged invocation is `gitleaks git --pre-commit --staged --redact
      --verbose` (`protect` is deprecated/hidden since v8.19 — verify the
      installed, pinned version actually supports the flags before trusting
      its exit code; an uninstalled scanner exits 127, which is not "clean").
      A keyword grep is **not** a secret gate: generic terms miss real
      credential formats (`sk-proj-…`, `AKIA…`) while flagging legitimate
      code that merely says `token`, its exit code inverts on a clean result,
      and `grep` is absent from Windows' default shell. If no vetted scanner
      is available, do **not** print the content diff to hunt for secrets —
      hand off to a human: they review the staged **content** (not just the
      path list) in a safe local viewer that doesn't persist to shared
      terminal/agent logs, and explicitly attest it contains no secrets.
      That attestation substitutes for a clean scan; with neither a scanner
      result nor an attestation, stop — the workflow does not resume.
   3. Only once the paths are approved and the scan is clean (or a human has
      attested the content per step 2): `git diff --cached --check` and the
      content diff of those paths. Never treat a scan result — least of all
      a keyword-grep zero — as permission to dump unrestricted content
      diffs.
4. Commit per AGENTS.md Git conventions (imperative subject, why-focused body).
5. Run the full verification workflow above at the committed head. A blank
   `git status --short` vouches only for non-ignored files — for strong
   exact-SHA evidence use the verification section's isolated-worktree path
   (`git worktree add --detach` + `npm ci` + controlled environment).
6. **Re-run the origin guard immediately before pushing, on the final
   branch** — `node scripts/check-origin.mjs "github.com/<owner>/<repo>"`
   must print `OK` again: branch-scoped config
   (`includeIf "onbranch:…"`) can swap `origin.pushurl` the moment the
   branch exists, so the pre-branch preflight is stale evidence by push
   time (the committed matrix includes this exact regression). Then push
   with the remote and ref pinned explicitly —
   `git push --set-upstream origin <branch>` — never a bare `git push`:
   `remote.pushDefault` (and `branch.<name>.pushRemote`) can silently point an
   argument-less push at a remote the guard never validated. Pushing and
   opening a PR are external writes — only do this when the task calls for
   it. Authorization to push or open a PR is **not** authorization to
   force-push: never rewrite history (`--force*`) unless the user explicitly
   approves history replacement.
7. Open the PR against `main` as a **draft** unless the user asked for
   ready-for-review or an existing PR already carries an intentional review
   state.
8. Postflight — re-query what was actually published, pinning the repo and PR
   number explicitly (never rely on current-branch inference; it exits 1 on a
   detached checkout):

   ```bash
   gh pr view <number> --repo <owner>/<repo> --json url,state,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup
   ```

   The result must match the intended base branch, head branch, **exact head
   SHA** (`headRefOid`), and draft state — green CI alone proves none of
   these. Record the returned `baseRefOid` as a snapshot, but do **not**
   require it to equal the preflight base SHA: `baseRefOid` is the base ref's
   *current* tip, which legitimately moves when `main` advances after
   branching. Verify lineage instead — `git merge-base --is-ancestor
   <recorded-base-sha> <head-sha>` must succeed.

   If the base **has** advanced past the recorded SHA, do not credit the
   existing green rollup as current-base evidence: CI here uses a bare
   `pull_request` trigger (runs on opened/synchronize/reopened), so a
   base-only move starts **no** new run, and the old run's `GITHUB_SHA` was
   the merge commit against the *then-current* base. Cross-check which SHA a
   run actually validated before crediting it. For real current-base
   evidence, either (with explicit authorization — it rewrites the published
   head) update the head branch against the current base so a `synchronize`
   run re-validates the true merge, or build the current base+head merge in
   an isolated worktree, run the verification matrix there, and report that
   as **local** evidence, explicitly distinct from GitHub CI. With neither,
   report current-base CI as unverified and stop before merging.

   Then wait for and verify green CI (lint, test, test:origin, vite build)
   before merging — as of 2026-08 `main` has no branch protection, so CI is
   convention, not GitHub-enforced. Report commit, push, PR creation, CI,
   review, and merge as separate states — never equate one with another.
9. Releases are a separate authorization: never tag, publish, sign, notarize,
   or announce without an explicit request and platform-appropriate evidence —
   `npm run build` / `npm run dist` are local packaging, not deployment proof.

### Review a PR (checker role)

Per AGENTS.md, the reviewer should be a different agent than the implementer.
Check, in order: architecture rules (core Electron-free? logic in shells?),
lockstep files all updated (IPC 3-file chain, store pair, STAGE_LABELS × 2),
domain invariants (maker-checker, CI gate, timeouts, error-not-crash), secrets
hygiene, then style (match surrounding code — there is no autoformatter).

This checklist is **local verification**. Posting an actual GitHub review
(comment, approval) or merging requires explicit authorization from the user —
a "review this" request alone does not grant it (see AGENTS.md safety rails).
