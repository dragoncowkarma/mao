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
npm run cli -- workflow enqueue "<title>" --owner <o> --repo <r> \
  --worker <providerId> --reviewer <providerId> --maintainer <providerId>  # pin specific agents per role
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

**Assigning specific AI agents to an issue/PR (swarm_orchestrator-style):** `--provider`
(global) / `--worker` / `--reviewer` / `--maintainer` (per-role, take priority over
`--provider` for the stage(s) they name — `--worker` covers `issue`+`pr`, `--reviewer`
covers `review`, `--maintainer` covers `merge`) all reference a provider **id** from
`mao config show`, not a raw CLI tool name — every value is still checked against
maker-checker (see AGENTS.md). For issues that already exist on GitHub and get picked
up by auto-trigger (`mao run`, or `github:refreshRepo`), write the same tags directly
into the issue body instead — `[Worker: <providerId>]`, `[Reviewer: <providerId>]`,
`[Maintainer: <providerId>]` — and `core/assignment.ts` parses them automatically when
the issue is enqueued; an issue with none of these tags enqueues exactly as before
(default maker-checker rotation).

**Pinning model/effort from an issue body:** the same parser reads task-level
`[Model: <modelId>]` and `[Effort: <level>]` tags — the auto-trigger equivalent of
`enqueue --model/--effort`. They apply to the whole task (every stage, whichever provider
maker-checker picks), never to a single role, and never influence *which* provider runs.
`<level>` must name one of the levels in `AI_EFFORTS` (`core/ai/types.ts`: `low`, `medium`,
`high`, `xhigh`, `max`, `ultracode`, `extra high`, `ultra`), matched case-insensitively;
anything else is ignored and the provider keeps its configured effort. `<modelId>` is
passed through as written, so a typo surfaces later as a provider error. All directive
tags are ignored inside code fences, inline code spans, HTML comments, and blockquotes —
quote the syntax freely when documenting it. A repeated tag keeps its last occurrence, so
an amendment can simply be appended further down the body — and that applies even when the
amendment is invalid: `[Effort: high]` later amended to `[Effort: turbo]` leaves the task
with no effort override rather than the superseded `high`.

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
   Branch names: see `.agents/rules/git-conventions.md` (`<type>/<issue-number>-<kebab-description>` for manual branches, or automated agent/workflow prefixes).
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
