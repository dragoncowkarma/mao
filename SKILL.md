---
name: mao
description: Operate and contribute to the MAO Electron and headless CLI repository. Use when analyzing, implementing, testing, reviewing, or publishing MAO changes, especially workflow-engine, GitHub automation, AI provider, IPC, renderer, packaging, CLI, or repository-guidance work.
---

# MAO development workflow

Read `AGENTS.md` first. Use this file for executable commands and repeatable
procedures; keep architectural rules in `AGENTS.md`.

## Start every task

1. Run `git status --short --branch` and identify the exact base commit, current
   branch or detached state, and pre-existing changes.
2. Read the requested code path and its tests before editing. Verify README
   claims against the current tree when they disagree.
3. Classify the change as documentation, core/domain, Electron/IPC, renderer,
   CLI, packaging, or external workflow work.
4. Identify any command that can mutate GitHub, a target repository, persisted
   MAO state, credentials, or release artifacts. Obtain authorization before
   expanding the requested external side effects.
5. Keep unrelated working-tree changes out of the diff and staging area.

## Install and runtime baseline

Match CI with Node.js 22 when possible. The CLI bundle targets Node.js 18, but
the repository does not currently declare an `engines` field.

Install the locked dependency graph in a fresh checkout:

```bash
npm ci
```

Use `npm install` only when intentionally changing dependencies and the lockfile.
Do not diagnose broad missing-module errors until dependencies are installed.

## Command catalog

| Purpose | Command | Notes |
| --- | --- | --- |
| Start Electron development | `npm run dev` | Runs Vite with Electron main/preload and renderer hot reload. |
| Type-check | `npm run lint` | Runs `tsc --noEmit`; this is not ESLint. |
| Run unit tests | `npm test` | Runs Vitest in Node for `core/**/*.test.ts`. |
| Build CI application bundles | `npx vite build` | Matches the build step in `.github/workflows/ci.yml`. |
| Build CLI | `npm run build:cli` | Bundles `cli/index.ts` to `dist-cli/index.cjs`. |
| Smoke-test CLI surface | `node dist-cli/index.cjs --help` | Run after `npm run build:cli`. |
| Start CLI through npm | `npm run cli -- --help` | Rebuilds the CLI before passing arguments. |
| Build unpacked desktop app | `npm run build` | Runs Vite and `electron-builder --dir`; platform-sensitive. |
| Build distributables | `npm run dist` | Produces platform artifacts; run only for packaging work. |
| Preview renderer build | `npm run preview` | Serves the built Vite renderer. |

Do not stage generated `dist*` or `release/` output.

## Validate by change surface

Always run:

```bash
git diff --check
git status --short
```

Then use the smallest sufficient matrix:

| Change surface | Required checks |
| --- | --- |
| Documentation or agent configuration only | Validate Markdown/TOML/frontmatter and links, then run `npm run lint`, `npm test`, and `npx vite build` when dependencies are available. |
| `core/` domain, persistence, GitHub, git, polling, or AI provider | Run focused Vitest coverage, then `npm run lint`, `npm test`, and `npx vite build`. |
| `electron/`, preload, IPC, or `src/` | Run `npm run lint`, `npm test`, and `npx vite build`; manually verify every changed IPC contract surface. |
| `cli/` or shared CLI behavior | Run `npm run lint`, `npm test`, `npm run build:cli`, `node dist-cli/index.cjs --help`, and `npx vite build`. |
| Packaging configuration | Run the checks above, then the relevant `npm run build` or `npm run dist` only on an appropriate host. |

For a focused workflow-engine run, use:

```bash
npx vitest run core/workflow-engine.test.ts
```

Do not report a platform package as verified when only the Vite bundles built.

## Operate the headless CLI safely

Use an isolated data directory when inspecting or experimenting so personal MAO
state is not overwritten:

```bash
MAO_DATA_DIR=/path/to/isolated-mao-data npm run cli -- config show
MAO_DATA_DIR=/path/to/isolated-mao-data npm run cli -- repos list
MAO_DATA_DIR=/path/to/isolated-mao-data npm run cli -- workflow list
```

Treat these commands according to their side effects:

- `config show`, `repos list`, and `workflow list` are one-shot inspection paths;
  they load the app with `resume: false`.
- `config import-providers`, repo mutations, queue mutations, retry, and advance
  persist local state and may start work.
- `config set-token <token>` also persists state, but its positional token can be
  exposed through argv, process listings, or shell history. Prefer the trusted
  Electron settings UI; do not run it with a real token from an agent terminal.
- `mao run` is a long-lived foreground process. It restores pending work, polls
  configured repositories, invokes providers, and can progress real GitHub
  operations until interrupted.
- Queue registration or a running process is not proof that a PR, review, CI
  result, or merge exists. Query persisted state and GitHub separately.

Never place real tokens in shell history, examples, committed provider JSON, or
logs. Treat MAO's data directory and cloned workspace `.git/config` files as
secret-bearing because authenticated origin URLs may persist there. Use a
durable user-controlled terminal for long-running `mao run` work.

## Run the real integration harness only when authorized

The following is not a unit test:

```bash
node --experimental-strip-types --env-file=.env.test scripts/test-workflow.ts
```

Before running it:

1. Obtain explicit authorization for external GitHub writes.
2. Confirm `.env.test` is ignored and contains a throwaway repository.
3. Confirm the configured providers, branch permissions, and CI behavior.
4. Expect creation of issues, branches, commits, PRs, reviews, and possibly a
   merge.
5. Verify the resulting GitHub state and exact SHAs after the process exits.

Never use a production repository as an implicit test fixture.

## Review a pull request

1. Resolve the repository and PR number explicitly.
2. Inspect metadata and the exact head before reviewing:

   ```bash
   gh pr view <number> --json number,title,state,isDraft,baseRefName,headRefName,headRefOid,reviewDecision,statusCheckRollup,url
   gh pr diff <number>
   ```

3. Trace changed behavior through `core/`, adapters, persistence, and tests.
4. Run the applicable validation matrix at the reviewed head.
5. Report findings in severity order with file/line evidence. Distinguish an
   independent review from self-review and local test evidence.
6. Do not approve, request changes, comment, or merge unless the task authorizes
   that GitHub write.

## Publish a change

Publish only when requested.

1. Recheck `git status --short --branch`, the base SHA, remote, and existing PRs
   for the intended head branch. Reuse an existing same-scope PR instead of
   creating a duplicate.
2. Inspect `git diff --stat`, `git diff`, and `git diff --check`.
3. Stage only intended paths; avoid `git add -A` in a mixed worktree.
4. Use a Conventional Commit such as:

   ```bash
   git commit -m "chore(ai): improve AI agent configuration"
   ```

5. Run the validation matrix at the committed head.
6. Push with upstream tracking. Never force-push unless the user explicitly
   authorizes history replacement; prefer a normal fast-forward push.
7. Open a draft PR unless the user requests ready-for-review or an existing PR
   already has an intentional review state.
8. Include these PR sections:

   - why the change is needed;
   - what changed, with each file's role;
   - how agents should use the configuration;
   - validation commands and results;
   - risks, limitations, and intentionally unrun external checks.

9. Verify the PR URL, base branch, head branch, head SHA, draft state, and checks
   from GitHub after creation or update.

Do not equate commit, push, PR creation, passing CI, approval, and merge; report
each state separately.

## Package and release

MAO currently has CI for type-check, unit tests, and Vite build, but no automated
release or deployment workflow in this repository. Treat `npm run build` and
`npm run dist` as local packaging commands, not deployment proof. Do not tag,
publish, sign, notarize, or announce a release without explicit authorization
and platform-appropriate evidence.
