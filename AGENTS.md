# AGENTS.md — MAO Agent Guide

Tier 1: loaded in every session; holds only what every task needs. Target 12 KB (`core/agent-docs.test.ts` fails above 16 KB). Tool entry files only point here.

## Route by task

| Touching | Read on demand |
| --- | --- |
| `npm` commands, verification, recipes | [SKILL.md](.agents/skills/mao-development/SKILL.md) |
| `core/store.ts`, `core/persistence-guard.ts`, recovery | [store-and-recovery.md](.agents/skills/mao-development/references/store-and-recovery.md) |
| Engine, agent routing, `core/ai/`, CLI usage | [workflow-and-routing.md](.agents/skills/mao-development/references/workflow-and-routing.md) |
| `core/repo-registry.ts`, `github:setRepos`, `mao swarm`, Swarm roles, review | [repo-preflight-and-swarm.md](.agents/skills/mao-development/references/repo-preflight-and-swarm.md) |
| `electron/ipc.ts`, `src/`, vitest config | [ipc-and-renderer-testing.md](.agents/skills/mao-development/references/ipc-and-renderer-testing.md) |
| `git` branch, commit, push; PR, release | [shipping-and-git.md](.agents/skills/mao-development/references/shipping-and-git.md) |

## Project

AI agents drive GitHub issue → PR → review → merge, with a maker-checker safeguard that needs two or more providers. One Electron-free core powers an Electron GUI (`electron/` + `src/`) and a headless CLI (`cli/`, bin `mao`).

## Architecture map

| Path | Role |
| --- | --- |
| `core/app.ts` | `createMaoApp()`, the single composition root |
| `core/workflow-engine.ts` | Queue state machine, CI gate, retry |
| `core/agent-selection.ts` | Pure routing: maker-checker, pins, model/effort |
| `core/assignment.ts` | Issue-body tags → `ProviderOverride` |
| `core/auto-trigger.ts` | Per-repo poller; enqueues new open issues |
| `core/github-service.ts` | Octokit wrapper + read-only write preflight |
| `core/repo-capabilities.ts` | Pure write-capability verdict |
| `core/repo-registry.ts` | Pure repo identity + `updateRepos` registrar |
| `core/store.ts` | `MaoStore`, schema, read guard, write refusal |
| `core/store-file.ts` | Cross-process write lock, atomic replace |
| `core/persistence-guard.ts` | Durable persistence-broken marker |
| `core/provider-import.ts` | CLI-only provider import |
| `core/git-workspace.ts` | Local git via `execFile` |
| `core/swarm-runner.ts` | Shell-free Swarm launcher |
| `core/self-update.ts` | GUI self-update guard |
| `core/paths.ts` | CLI data dir |
| `core/ai/` | `AiProvider`, API and CLI adapters, `provider-options.ts` |
| `electron/main.ts` | Window, external links, load |
| `electron/ipc.ts` | `ipcMain.handle` channels, thin delegations |
| `electron/preload.ts` | `window.electronAPI` bridge |
| `electron/store.ts` | One call: `openGuardedStoreFile()` |
| `src/` | React 18 renderer; `src/App.tsx` owns cross-view state |
| `src/electron-api.ts` | Only bridge accessor |
| `cli/index.ts` | Commander CLI |
| `.agents/workflows/swarm_orchestrator.py` | Swarm lifecycle |
| `scripts/test-workflow.ts` | E2E harness (throwaway repo) |
| `scripts/check-origin.mjs` | Origin guard |

## Non-negotiable architecture rules

Code comments cite these numbers: never renumber (`core/agent-docs.test.ts`).

1. **`core/` stays Electron-free.** `core/` and `cli/` never import `electron`, `electron-store` or `electron/`; persistence goes through `MaoStore`. No test yet (#82): `git grep --untracked -E "from '[./]*electron" -- core cli` must be empty.
2. **Business logic lives in `core/`, never in the shells.** `electron/ipc.ts` and `cli/index.ts` stay thin, or GUI↔CLI parity breaks. Sole exception: `.agents/workflows/swarm_orchestrator.py` owns the CLI-only Swarm lifecycle; `cli/index.ts` only calls `core/swarm-runner.ts`. Partial proof: `core/shell-queue-gate.test.ts`.
3. **`createMaoApp()` (`core/app.ts`) is the only boot path.** Mutate through `WorkflowEngine` so persistence is automatic. Partial proof: `core/app.test.ts`.
4. **The `resume` flag is deliberately required (no default).** One-shot commands pass `false`; `electron/ipc.ts` passes `true`; `mao run` passes `false`, then calls `resumeProcessing()` after attaching its listener. Proof: `npm run lint` (flag required); shell values and order: review.
5. **Never start the auto-trigger poller inside `createMaoApp()`.** Its `setInterval` keeps the process alive; only `electron/ipc.ts` and `mao run` start it. No test: `git grep "auto-trigger.ts'" -- core/app.ts` must print nothing.
6. **Renderer isolation.** `src/` reaches main only through `electronApi()`. Outside tests, from `core/` it imports types, plus values from `core/agent-selection.ts`, `core/ai/provider-options.ts`, `core/repo-registry.ts` only. No IPC push: the UI polls and re-fetches after each mutation. Partial proof: `src/electron-api.test.ts` (bridge door only).
7. **Electron security posture.** `webPreferences` sets only `preload`; never weaken Electron 33 defaults. `setWindowOpenHandler` keeps `{ action: 'deny' }`, routing http/https to `shell.openExternal`. No test: review `electron/main.ts`.
8. **`core/` tests must stay runnable under plain Node.** `vitest.config.ts` keeps two projects: `core` (node, zero plugins, no `extends`) and `renderer` (jsdom). `npm run test` runs them separately: combined, an empty project exits 0. Partial proof: `core/node-environment.test.ts`.

## Lockstep files

| Change | Move together | Proof |
| --- | --- | --- |
| IPC channel | `electron/ipc.ts`, `electron/preload.ts`, `src/electron.d.ts`, `src/test/electron-api-stub.ts`; literal `<domain>:<camelCaseAction>` | `src/electron-ipc-surface.test.ts` |
| Store field | `MaoStoreSchema` + `MAO_STORE_DEFAULTS`; array: `STORED_SHAPE_RULES` + table test | Lint (pair); rule: review |
| `MaoStore` backend | `createGuardedStore()`, strict `getFresh`, `withFileWriteLock` | `core/store.test.ts` |
| Repo registration | Rule only in `core/repo-registry.ts`; shells call `updateRepos` and surface unverified grants | `core/repo-registry.test.ts` (shells: review) |
| Capability policy | `core/repo-capabilities.ts` + tables in `.agents/workflows/swarm_orchestrator.py` | Both suites |
| Pipeline stage | `AGENT_STAGES` (`core/ai/types.ts`); `STAGE_ROLE` (`core/agent-selection.ts`); `buildPromptForStage`, `applyGithubAction`; `STAGE_LABELS` in `KanbanBoard.tsx`, `WorkflowQueue.tsx`; `ALL_STAGES` + `STAGE_LABELS` in `GlobalSettings.tsx` | Partial: `core/workflow-engine.test.ts` |
| Build outputs | `electron/main.ts`, `vite.config.ts`, `package.json` | Hand audit; `npm run build` checks only `main` |

## Domain invariants

1. **Maker-checker:** a stage never returns to the agent that just ran, except a pinned or one-shot Worker carrying `issue → pr`. Stored pins yield; with no other eligible provider a role pin throws and the rest relax. A violating `RunOverride` otherwise throws.
2. **Every stage preflights repo write access** in `runStage()`, before `selectAgent()`; no exemptions. A pass means "no known blocker", not proof.
3. **Single-flight `processQueue()`:** every external call is time-bounded (API 5 min, CLI 15 min, Octokit attempt 60 s, git 15 min). A timeout is a task error.
4. **Failures are retryable `error` states, not crashes.** `retry()` re-runs the stage, and `createIssue` and `reviewPullRequest` are not idempotent.
5. **CI gate:** merge proceeds only on `'success'` or `'none'`.
6. **`allowToolUse` elevation** applies only to the `pr` stage's real-checkout path with a CLI provider.
7. **`workflow-active`**, the only duplicate-enqueue protection, is best-effort.

## Safety rails

1. **Each external write needs explicit task authorization;** analyze, review and verify requests grant none. Enqueueing, `mao run`, `npm run dev` (real host), `mao swarm` (except `--dry-run`/`--status`), `github:refreshRepo` (bypasses `autoTrigger: false`), the E2E harness, and closing the last item of a `vX.Y.Z` milestone (`release.yml` publishes) count. Test only against throwaway repos.
2. **Writers are fixed.** `githubRepos`: only `updateRepos`. `workflowTasks`: two conditional writers, both in `core/app.ts`.
3. **Reads coerce, writes refuse.** An unreadable `config.json` refuses every write; invalid `aiProviders`/`workflowTasks` lists never reach a backend.
4. **A value derived from a read writes with `setIfUnchanged`.** Only a value stated outright (token, theme) may use `set`.
5. **Two separate halts.** Unusable `workflowTasks` at boot latches queue recovery (`mao workflow confirm-queue-recovery`, which deletes invalid entries); never run it beside a live host. A confirmed write failure sets `workflowPersistenceBroken`: queue work stays blocked until an operator reconciles GitHub, clears the marker (`mao config clear-persistence-broken`, or the GUI's own action) and restarts.
6. **Repo identity is case-insensitive:** match with `sameRepoRef()`, never lower-case stored entries.
7. **`mao swarm` is a separate engine and credential:** a latched queue does not stop it.
8. **Secrets:** never commit `.env*` or print `githubToken`/`apiKey`. `config.json` and workspace `.git/config` hold secrets. Never run `mao config set-token` with a real token from an agent terminal, or interpolate a backend error into a report.
9. **The real-checkout `pr` path runs `git add -A` + `push --force`.** Never point `workspaceRoot` at a checkout with unrelated work.
10. **Child processes stay shell-free:** argument-array `execFile`/`spawn`.

## When Writing Code

Order: `core/`, both shells, then UI.

1. **Format** (`tsc` only; match by hand): no semicolons, single quotes, 2-space indent, trailing commas, ~110 columns.
2. **Files:** kebab-case `.ts` with named exports in `core/`, `cli/`, `electron/`; one PascalCase `.tsx` default export per file in `src/components/`.
3. **Imports:** `.ts` extensions Node-side, extensionless in `src/`, `node:` builtins, `import type`.
4. **Comments:** rationale-heavy JSDoc on exports and interface fields: why, and cross-process effects (exemplar: `core/app.ts`). Preserve and extend it; the references cite it.
5. **Errors:** early guard clauses with context; providers prefix `[${this.name}]`.
6. **Async:** `void` for fire-and-forget; raw `Promise` only for child processes.
7. **Renderer:** CSS variables from `src/index.css`, no hex in TSX, no Tailwind theme additions, no `rounded-*`. Polling effects `clearInterval` in cleanup and survive StrictMode. No external font links.

## When Reviewing Code

1. The reviewer differs from the implementer; in `mao swarm`, Worker, Reviewer and Maintainer are pairwise different.
2. Follow **Review checklist** in `repo-preflight-and-swarm.md`.

## When Releasing

Never tag, publish or sign without an explicit request. Commit `<type>(<scope>): <subject>`: imperative, sentence case, no period, subject ≤50 chars. Conventional Commits types; scopes `core cli electron ui ai workflow github`. Manual branches `<type>/<issue-number>-<kebab-description>`. Before any fetch, branch or push: `node scripts/check-origin.mjs "github.com/<owner>/<repo>"`. Procedure: `shipping-and-git.md`.

## Definition of Done

Every command exits 0; nothing enforces this on `main`:

```bash
npm run lint && npm run test && npm run test:origin && npx vite build
npm run build:cli && node dist-cli/index.cjs --help  # touched cli/ or core/; not in CI
```

1. Renderer behaviour changes get a test under `src/`; new regression tests are seen failing with the fix reverted.
2. A PR that closes a documented gap or moves a rule updates that entry (`AGENTS.md` or a reference) in the same commit.

## When Blocked

Priority 1: `npm run test` and the invariants hold. Priority 2: finish quickly. Stop and report when a check fails unexplained or a task needs an unauthorized external write. A doc that misdescribes the code gets fixed; code that breaks a rule gets reported.

Never: force-push without explicit approval, delete a file to clear an error, skip or weaken a test, commit a store file, switch branches in the main checkout (use `git worktree`), overwrite a sibling tool's branch.
