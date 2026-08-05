# SKILL.md — MAO Operational Playbook

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

Run this on the exact tree you intend to share — before the commit or at the
committed head, either verifies the same tree; just ensure nothing changes
between verification and push.

CI runs, in order, `npm ci` → `npm run lint` → `npm run test` → `npx vite build`
on Node 22 for pushes to `main` and all PRs. Locally (dependencies already
installed):

```bash
npm run lint && npm run test && npx vite build
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

1. Preflight: `git fetch origin` and branch from the **current** `origin/main`
   — a local `main` ref can lag the remote by many commits. Note the exact base
   SHA, and check for an existing same-scope PR to reuse (`gh pr list`) instead
   of opening a duplicate. Branch names: `feature/<topic>` or
   `claude/<topic>-<hex>`.
2. Stage only the paths the task intended — check `git status --short` and
   `git diff --check` first, and avoid `git add -A` in a worktree that may hold
   unrelated changes. Never stage: `.env*`, `dist/`, `dist-electron/`,
   `dist-cli/`, `release/`, store/config files, or anything containing a token.
3. Before committing, verify what is actually staged — `git diff --cached
   --stat`, `git diff --cached --check`, and read `git diff --cached` for
   anything unexpected. Plain `git diff` compares worktree↔index and misses
   already-staged content, so it cannot catch a stray staged secret or
   unrelated file.
4. Commit per AGENTS.md Git conventions (imperative subject, why-focused body).
5. Run the full verification workflow above at the committed head.
6. Push with upstream tracking (pushing and opening a PR are external writes —
   only do this when the task calls for it). Authorization to push or open a PR
   is **not** authorization to force-push: never rewrite history (`--force*`)
   unless the user explicitly approves history replacement.
7. Open the PR against `main` as a **draft** unless the user asked for
   ready-for-review or an existing PR already carries an intentional review
   state. Wait for and verify green CI (lint, test, vite build) before merging —
   as of 2026-08 `main` has no branch protection, so CI is convention, not
   GitHub-enforced.
8. Releases are a separate authorization: never tag, publish, sign, notarize,
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
