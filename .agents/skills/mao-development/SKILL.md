---
name: mao-development
description: Commands, verification matrix and step-by-step recipes for the MAO repository, with per-subsystem references. Use when building, testing or changing the MAO Electron app, headless CLI, workflow engine, GitHub automation, AI providers, renderer or agent documentation.
---

# MAO development playbook

Tier 2: read on demand. Rules live in [AGENTS.md](../../../AGENTS.md). Quote paths: the working copy can
sit on a volume named `NO NAME`.

## References

| Read | For |
| --- | --- |
| [store-and-recovery.md](references/store-and-recovery.md) | Store fields and backends, read guard, write lock, queue latch, persistence marker, `config.json` recovery runbooks |
| [workflow-and-routing.md](references/workflow-and-routing.md) | Engine stages, maker-checker, overrides, timeouts, AI providers, CLI usage, E2E harness |
| [repo-preflight-and-swarm.md](references/repo-preflight-and-swarm.md) | Repo identity, `github:setRepos`, capability preflight, `mao swarm`, role assignment, review checklist |
| [ipc-and-renderer-testing.md](references/ipc-and-renderer-testing.md) | IPC surface test, renderer isolation, vitest projects, renderer test patterns |
| [shipping-and-git.md](references/shipping-and-git.md) | Branch/commit/PR conventions, exact-SHA evidence, the ship procedure, releases |

## Setup

```bash
npm ci              # locked graph, same as CI; CI uses Node 22, the CLI bundle targets node18
python3 --version   # 3.11 in CI; required by the Swarm asset and npm run test
```

Use `npm install` only when intentionally changing dependencies and the lockfile.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Electron + Vite, hot reload. Real host (`resume: true`, auto-trigger, `userData`, not `MAO_DATA_DIR`): it can write to GitHub, so run only with explicit authorization |
| `npm run lint` | `tsc --noEmit`, the only type and style gate |
| `npm run test` | Vitest `core`, then `renderer`, then the Python Swarm tests |
| `npm run test:origin` | Standalone matrix for `scripts/check-origin.mjs` |
| `npm run build` | `vite build` + `electron-builder --dir`, unpacked into `release/` |
| `npm run dist` | Full distributable (dmg/zip on mac) |
| `npm run build:cli` | Bundle `cli/index.ts` to `dist-cli/index.cjs` and copy the Swarm asset beside it |
| `npm run cli -- <args>` | Build the bundle, then run it (`npm run cli -- config show`) |
| `npm run preview` | Vite preview of the built renderer |

- Never run the CLI via `tsx`: it fails on `@octokit/app` (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
- CLI state: `$MAO_DATA_DIR/config.json`, clones in `$MAO_DATA_DIR/workspaces`; default directory from
  `core/paths.ts`. Set it to isolate test state. Usage: [workflow-and-routing.md](references/workflow-and-routing.md).

## Verification matrix

Always, in CI's order: `npm run lint && npm run test && npm run test:origin && npx vite build`.

| Touched | Also run | Why |
| --- | --- | --- |
| `cli/` or `core/` | `npm run build:cli && node dist-cli/index.cjs --help` | CI never builds the bundle |
| `core/workflow-engine.ts` | `npx vitest run core/workflow-engine.test.ts` | Focused loop |
| `src/` | `npx vitest run --project renderer` | Nothing else sees renderer behaviour |
| IPC surface | `npx vitest run --project renderer src/electron-ipc-surface.test.ts` | Pins channel strings, not what a handler does |
| `scripts/` | Run it, except `scripts/test-workflow.ts` (real writes: needs authorization); for `scripts/build-cli.mjs`, `npm run build:cli` | Outside `tsconfig.json`'s `include` |
| `.agents/workflows/swarm_orchestrator.py` | `npm run test`, then `npm run build:cli && node dist-cli/index.cjs swarm --status` | The bundle runs its own copy of the asset |
| Agent documents | `npx vitest run --project core core/agent-docs.test.ts` | Budgets, links, rule numbers |

These commands test the filesystem, not a commit. For exact-SHA evidence use the isolated worktree in
[shipping-and-git.md](references/shipping-and-git.md).

## Recipes

### Add an IPC channel

1. Implement the logic in `core/`, not the shell.
2. `electron/ipc.ts`: `ipcMain.handle('<domain>:<camelCaseAction>', …)`, a one-line delegation.
3. `electron/preload.ts`: the same plain literal, exactly `<namespace>:<method>`.
4. `src/electron.d.ts`: mirror the signature. `npm run lint` catches a missing method, through the bridge's
   `satisfies Window['electronAPI']`, not a dropped parameter: write the return type, forward every argument.
5. `src/test/electron-api-stub.ts`: add `notStubbed('<domain>.<action>')` unless a test or mount path needs
   an answer.
6. CLI parity: add the subcommand in `cli/index.ts`.
7. `npm run lint && npm run test`. Neither proves the handler works: smoke-test in `npm run dev` if
   authorized, otherwise report it unrun.

### Add a store field

1. Add to both `MaoStoreSchema` and `MAO_STORE_DEFAULTS` in `core/store.ts`.
2. An array a hand-edit can violate gets a three-member rule (`usableEntry`, `report`, `readEntries`) in
   `STORED_SHAPE_RULES`, write refusal in `describeInvalidStoredWrite`, and a per-shape table test in
   `core/store.test.ts`; nothing forces any of them. Arrays only: a rule on a scalar reads every healthy
   value as defective. `report` tells the operator what the fallback costs and
   which unconditional write heals it. In a comment, answer: does losing it let unattended work start
   (then it needs a latch)? Does something downstream already drop invalid entries (then hand through)?
3. Choose its concurrency: a stated value uses `set`; a value derived from a read uses `setIfUnchanged`
   keyed on `inspect()`, and decides whether `'superseded'` re-plans or refuses.
4. Renderer needs it: the IPC recipe above. CLI needs it: `cli/index.ts`, keeping `config show` redaction.

Details: [store-and-recovery.md](references/store-and-recovery.md).

### Add a pipeline stage

1. `core/ai/types.ts`: extend `AGENT_STAGES`; the stage unions and engine order derive from it.
2. `core/agent-selection.ts`: `STAGE_ROLE`; stages sharing a role are exempt from maker-checker.
   `core/workflow-engine.ts`: `buildPromptForStage`,
   `applyGithubAction` (no default case: tsc stays silent and a missed stage writes nothing).
3. `STAGE_LABELS` in `src/components/KanbanBoard.tsx` and `src/components/WorkflowQueue.tsx`;
   `ALL_STAGES` and `STAGE_LABELS` in `src/components/GlobalSettings.tsx`.
4. `core/workflow-engine.test.ts`: progression, maker-checker alternation, error and retry. Details:
   [workflow-and-routing.md](references/workflow-and-routing.md).

### Add a renderer regression test

1. Put it beside what it covers: `src/App.test.tsx`, `src/components/<Name>.test.tsx`.
2. `const stub = createElectronApiStub([...repos])`. Channels it does not implement throw by name.
3. Mount for real: `render(<StrictMode><App /></StrictMode>)`. StrictMode doubles mount-path IPC calls,
   so assert what the operator sees or `toHaveBeenCalledWith`, never a bare `toHaveBeenCalledTimes`.
4. Query by role (`getByRole('button', { name: 'Confirm remove' })`). No test ids.
5. Keep real timers: `vi.useFakeTimers()` with user-event deadlocks. Races and polling patterns:
   [ipc-and-renderer-testing.md](references/ipc-and-renderer-testing.md).
6. Revert the behaviour and watch the test fail. Say in the PR which mutation you ran.

### Add an AI provider

- HTTP API shape: `core/ai/api-provider.ts`, `AI_API_FORMATS` in `core/ai/types.ts`, and the format
  picker in `src/components/GlobalSettings.tsx`.
- Local CLI: the per-CLI flag tables in `core/ai/cli-provider.ts`. Keep the 15-minute SIGKILL and keep
  `allowToolUse` flags on the `pr` path only.

## Editing these documents

- `AGENTS.md` takes only what every task needs, plus a map row per `core/` module; a subsystem detail goes
  in that subsystem's reference.
- Write rule, one-clause why, proof. PR retrospectives and code walkthroughs belong in commits and JSDoc.
