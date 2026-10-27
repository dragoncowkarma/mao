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
| `core/repo-registry.ts` | Pure, renderer-importable repository identity plus the single definition of "this repo entry is newly registered" — `repoRefKey()`/`sameRepoRef()` (case-insensitive, as GitHub resolves owner/repo), `canonicalRepoList()`, `reposNeedingCapabilityCheck()` / `assertReposRegistrable()`, and the serialized `createRepoRegistrar()` both `github:setRepos` and `mao repos add`/`remove` write through |
| `core/provider-import.ts` | CLI-only provider-file import for `mao config import-providers` (no IPC channel): reads and parses input, validates through the store write guard, persists, then logs imported IDs; rejection messages omit parser/backend errors and provider values |
| `core/git-workspace.ts` | Local git clone/branch/commit/push via `execFile` (no shell) |
| `core/swarm-runner.ts` | Shell-free launcher and repository/asset validation for the autonomous Swarm Orchestrator |
| `core/auto-trigger.ts` | Per-repo polling scheduler; auto-enqueues new open issues |
| `core/assignment.ts` | Issue/PR body directive parser — `parseAssignmentTags()` for swarm_orchestrator-style `[Worker: id]`/`[Reviewer: id]`/`[Maintainer: id]` role tags, and `parseProviderOverride()` which folds those plus task-level `[Model: id]`/`[Effort: level]` tags into a `ProviderOverride` |
| `core/store.ts` | `MaoStoreSchema`, `MAO_STORE_DEFAULTS`, the `MaoStore` interface, `FileStore` (JSON impl for the CLI), `createStoredReadGuard()` — the read-path guard every backend applies so a field's declared type survives contact with unvalidated JSON — `describeStoredProblems()` behind `MaoStore.problems()`, which answers *which* values it had to replace, and the whole-file tier below those — `classifyStoreReadFailure()`/`UnreadableStoreError` plus the write refusal in `createGuardedStore.set()` that closes issue #67 |
| `core/app.ts` | `createMaoApp()` — the **single composition root** both frontends call |
| `core/paths.ts` | Platform-appropriate data dir for the CLI (mirrors Electron's `userData`) |
| `core/ai/` | `AiProvider` interface + adapters: `api-provider.ts` (Anthropic / OpenAI-compatible HTTP) and `cli-provider.ts` (spawns `claude`, `codex`, …) |
| `electron/main.ts` | BrowserWindow, external-link handling, dev/prod load |
| `electron/ipc.ts` | All `ipcMain.handle` channels — thin delegations only |
| `electron/preload.ts` | `contextBridge` exposing `window.electronAPI` |
| `electron/store.ts` | One call: `openGuardedStoreFile(configPath, () => new Store(…))`. The file is judged before conf is constructed, because conf writes merged defaults from its own constructor; the instance is never bound to a name, exported, or read anywhere else |
| `src/` | React 18 renderer (Vite + Tailwind); `App.tsx` owns all cross-view state |
| `src/electron-api.ts` | The renderer's only door to the preload bridge: `setElectronApi()` binds it (production from `src/main.tsx`, tests from a stub), `electronApi()` reads it |
| `src/test/` | Renderer test harness — `setup.ts` (jsdom polyfills, unmount + unbind between tests) and `electron-api-stub.ts` (a typed fake bridge, `satisfies ElectronApi`) |
| `cli/index.ts` | Commander CLI: `config` / `repos` / `github` / `workflow` / `run` / `swarm` |
| `.agents/workflows/swarm_orchestrator.py` | Autonomous Worker/Reviewer/Maintainer lifecycle, credential-aligned write preflight, origin fetch/push identity binding, isolated worktrees, process registry, retry/cooldown, and safe merged-task cleanup; copied beside the CLI bundle by `scripts/build-cli.mjs` |
| `.agents/workflows/swarm_orchestrator_test.py` | Standalone Python preflight, credential non-disclosure, dry-run, and worktree-safety regressions, included in `npm run test` |
| `core/node-environment.test.ts` | Architecture rule 8 as a test: asserts the `core` vitest project still runs with no DOM in scope |
| `core/renderer-importable.test.ts` | Architecture rule 6's other half as a test: bundles each module `src/` may value-import and asserts its real import graph stays inside that allowlist (esbuild + `verbatimModuleSyntax`, no DOM, ~30ms) |
| `src/electron-ipc-surface.test.ts` | The IPC lockstep's untypeable half as a test: channel strings in `electron/ipc.ts` and `electron/preload.ts` must be the same set, registered and exposed once each, and each named after the bridge method that calls it — plus a pin that the bridge still carries `satisfies Window['electronAPI']` |
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
   validation and shell-free launch. Its repository write preflight also stays in Python:
   Swarm writes with the active `gh` CLI credential, not the store's `githubToken`, so routing
   this check through `GithubService` would validate the wrong credential. Do not duplicate
   Swarm behavior in the CLI shell.
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
6. **Renderer isolation.** `src/` never imports Node/Electron modules (its **tests** are
   the one exception: they run in a Node-hosted jsdom environment that is never shipped,
   and `src/electron-api.test.ts` walks the tree with `node:fs`), and reaches the main
   process only through `electronApi()` (`src/electron-api.ts`) — the single accessor for
   the preload bridge, bound once by `src/main.tsx`. Reading `window.electronAPI` anywhere
   else in `src/` is a **test failure** (`src/electron-api.test.ts`), not a style note: a
   component wired to the global is a component no renderer test can hand a fake. From
   `core/` it imports
   types, plus values from the modules marked *renderer-importable* in the
   architecture map above — `core/agent-selection.ts`, `core/ai/provider-options.ts`
   and `core/repo-registry.ts`, which are pure and whose own `core/` imports are all
   `import type`, so nothing Node-side is pulled into the bundle. Importing a value
   from any other `core/` module is not allowed; re-implementing one of these rules
   in `src/` instead is worse, and is what let the board and the registry disagree
   about whether two spellings were the same repository. Imports stay extensionless.
   The "all `import type`" half of this is load-bearing in a second direction that is easy to miss:
   `core/store.ts` **value**-imports `isRepoRef` from `core/repo-registry.ts`, because a dropped-entry
   report must count with the same predicate that actually drops the entries (`canonicalRepoList()`,
   `github:getRepos`) or it tells the operator two vanished while three did. That edge is safe only
   because `repo-registry.ts` imports nothing from `core/` at runtime; drop a `type` keyword there and
   the pair becomes a module-initialisation cycle. `core/renderer-importable.test.ts` asserts it for all
   three modules, by bundling each with esbuild and checking the real import graph — a regex over
   import statements is not fail-closed (it misses double quotes, multiline clauses, side-effect
   imports, `export … from` and dynamic `import()`), and `tsc` stays green for every one of them.
   Two esbuild settings there are load-bearing and were each verified in both directions:
   `verbatimModuleSyntax` (without it esbuild elides `import { type X } from './y'`, the exact form that
   defeated the regex) and `platform: 'neutral'` (under `'node'` a reach for `node:fs` is merely
   *external*, so it never appears among the metafile inputs and a planted `import 'node:fs'` left the
   suite green). Graph paths are normalised to `/`, since `path.relative()` yields backslashes on
   Windows and `package.json` declares a Windows ZIP target that CI does not cover.
   There are no IPC push events — the
   UI polls and re-fetches after each mutation; keep that pull model.
7. **Electron security posture.** `webPreferences` set only `preload` so Electron 33
   defaults apply (contextIsolation on, nodeIntegration off, sandbox on) — never
   weaken them. `setWindowOpenHandler` must keep returning `{ action: 'deny' }` and
   routing http/https to `shell.openExternal`.
8. **`core/` tests must stay runnable under plain Node.** `vitest.config.ts` is
   deliberately separate from `vite.config.ts` (the electron/renderer plugins shim node
   builtins and break `core/` under Node). It declares **two projects**, and a project
   inherits nothing from the root config unless it opts in with `extends` — that is what
   keeps them apart, by construction rather than by convention:
   - **`core`** — `core/**/*.test.ts`, `environment: 'node'`, **zero** vite plugins.
   - **`renderer`** — `src/**/*.test.ts(x)`, `environment: 'jsdom'`, `@vitejs/plugin-react`
     and `src/test/setup.ts`, exercising real components through Testing Library.

   Never give the `core` project a plugin, a DOM environment, or an `extends`; never pull
   `vite-plugin-electron`/`-renderer` into the `renderer` project — they exist to shim node
   builtins for the packaged bundle, which is the drift this rule is written against.
   `npm run test` runs the two projects as two `vitest run` invocations, deliberately: a
   combined run **tolerates a project whose `include` matches nothing** — it is not even
   named in the output and the run still exits 0 — so renaming test files out from under a
   glob would retire an entire suite with CI green. Selecting a project that found nothing
   exits 1, which is the only form that fails loudly (`passWithNoTests: false` does not
   help, at either level). `core/node-environment.test.ts` pins the half a test can reach:
   give the `core` project a DOM — by setting `environment` on it, by collapsing the two
   projects back into one root `test` block, or by pointing `extends` at a config that has
   one — and it fails, instead of the boundary dissolving with every suite still green.
   Note what is *not* a route: a root-level `test.environment` sitting beside `projects`
   never reaches an inline project, and neither does a root plugin (vitest builds each
   project's server from that project's own plugin list). A stray plugin therefore leaves
   nothing for a test to observe; keep that one out by reading the config.
   Two test suites sit outside vitest entirely: `scripts/check-origin.test.mjs`, a
   dependency-free standalone matrix invoked as `npm run test:origin`, and the autonomous
   Swarm asset's worktree-safety regressions in
   `.agents/workflows/swarm_orchestrator_test.py`, which run through `npm run test` — so
   Python 3 is required for the repository test matrix.

## Files that must change together

There is no codegen — these couplings are maintained by hand and only `npm run lint`
(tsc) catches part of the drift:

- **New IPC channel** → 3 files in lockstep: `electron/ipc.ts`
  (`ipcMain.handle('<domain>:<camelCaseAction>', …)`, domains
  `app`/`ai`/`github`/`workflow`/`ui`), `electron/preload.ts` (same channel string, same
  namespace), `src/electron.d.ts` (mirror the signature). Two more files follow
  automatically, and between them most of this is no longer maintained by eye:
  `src/test/electron-api-stub.ts` builds its fake bridge with `satisfies ElectronApi`, and
  the bridge in `electron/preload.ts` itself carries `satisfies Window['electronAPI']` —
  `contextBridge.exposeInMainWorld` takes `any`, so without that annotation tsc checked the
  bridge against nothing at all. With it, a method missing from either side, an extra one,
  or a signature that disagrees is a lint error. **Never remove it**; a test pins that it is
  still there, because deleting it would silence every check it performs without anything
  going red.
  What no type can reach is the channel **strings** — `invoke('app:storeProblms')` is a
  valid `string`, and `ipcMain.handle` is keyed by the same untyped literal in another file.
  `src/electron-ipc-surface.test.ts` owns that half: the two sets must be equal, each
  channel registered and exposed exactly once, and every channel named
  `<namespace>:<method>` after the bridge method that invokes it. Keep that naming — it is
  what turns a typo into a message naming the offending method rather than two sorted lists.
  It also pins the **global the bridge is installed under**, which is the one string whose
  being wrong removes the entire bridge: `exposeInMainWorld`'s first argument has to equal
  the member `src/electron.d.ts` declares on `Window` *and* the property `src/main.tsx`
  reads back off it, and there has to be exactly one install (a second one for the same key
  is not additive — the renderer gets one of them). Pinned against those two files rather
  than a literal in the test, so a rename has to land everywhere or the suite says which
  side was missed.
  That test reads the **TypeScript AST**, not the source text, and keep it that way. Regex
  collectors recognised exactly one spelling and silently skipped the rest, which is worse
  than not checking: both sides of a channel rewritten as `handle("x")`/`invoke("x_typo")`
  left both collections together, the set comparison still balanced, and a runtime-broken
  bridge shipped green. So the parser now **fails closed** — every `ipcMain.handle` and
  `ipcRenderer.invoke` must name its channel as a plain string literal, and every `invoke`
  must sit inside a namespace object, or the suite names the file and line. A channel moved
  into a shared constant or built from a template is refused there for that reason: not
  because it would not work, but because it would remove this protection without telling
  anyone.
  Failing closed on the *argument* is only half of it, so the **call form** fails closed
  too. A shape the matcher did not recognise never entered the collection at all, which made
  the literal check vacuous for it: `ipcMain['handle'](…)` paired with a mistyped
  `ipcRenderer['invoke'](…)` is type-valid and left every assertion green over a channel with
  no handler. The rule is therefore inverted — every *reference* to `ipcMain`,
  `ipcRenderer` or `contextBridge` must be the object of a recognised direct call, so
  destructuring the method out, aliasing the binding into a local, a namespace import, and
  `ipcMain.on` (a send/on channel this test does not model) are all reported by file and line.
  Recognition resolves the **import**, not an identifier spelling, so `import { ipcMain as
  main }` is read rather than refused — while a **default** (`import electron from
  'electron'`) or namespace import reaches the same functions through a shape this file does
  not read, and is refused on use for that reason. Ignoring the default binding let a channel
  be split across two `electron.ipcMain`/`electron.ipcRenderer` helpers with mismatched
  strings that the built bundles kept. Runtime re-exports from `electron`, import-equals and
  `require('electron')` are refused too; otherwise a local facade can rename a binding before
  the scanner ever sees its import.
  The surface is built from the modules that **actually run** — the runtime import graph from
  `electron/main.ts` and `electron/preload.ts` — never from a directory listing, which is not
  a statement about what executes. A listing was wrong both ways: an unimported
  `electron/dead-ipc.ts` was parsed as live, so moving a registration there left the suite
  green while production registered nothing, and an imported `electron/ipc-parts/theme.ts`
  was outside the flat scan, so a real refactor failed for no reason.
  Which edges count is the subtle part. `verbatimModuleSyntax: true` is load-bearing and
  pinned by the suite: ordinary imports stay in the bundle even when used only as types, so
  the syntax walk cannot disagree with Vite about them. Only a whole-clause `import type` or
  `export type` erases an edge; `import { type Marker }` emits an empty side-effect import and
  still executes the module. Dynamic `import()` is refused even with a literal target,
  because its presence proves neither that its branch/function runs nor that an asynchronously
  loaded handler registers before the renderer invokes it. Static relative edges resolve
  through TypeScript (including `./x.js` → `./x.ts` substitution), and an unresolved one is
  refused rather than mistaken for an external package. Paths are compared POSIX-normalised,
  because `node:path.relative()` answers `electron\main.ts` on Windows — a platform this repo
  ships to — and the reachability assertions hard-code forward slashes.
- **Repository registration** → the add-vs-update rule lives ONLY in `core/repo-registry.ts`;
  `electron/ipc.ts`'s `github:setRepos` and `cli/index.ts`'s `repos add`/`repos remove` must all stay
  thin delegations to `createMaoApp()`'s `updateRepos`. Re-implementing the diff in either shell is how the two paths silently drift.
  A shell's update callback may match entries with core's `sameRepoRef`, but must never normalise or
  deduplicate the list itself — `updateRepos` owns that (see the identity invariant below).
  Both shells must also surface `describeUnverifiedGrants()` for the verdicts it returns — a passing
  preflight is not proof of write access, and a shell that stays silent about that claims more than
  the check established.
- **New store field** → both `MaoStoreSchema` and `MAO_STORE_DEFAULTS` in
  `core/store.ts` (tsc enforces the pair). Both backends pick
  the field up automatically.
- **New `MaoStore` backend** → write the raw key/value surface (`StoredValueBackend`) and hand it to
  `createGuardedStore(backend, source)` (`core/store.ts`). Do not re-implement the composition: both
  shipped backends *are* that function, which is what makes "the two shells cannot answer differently
  for the same corrupt file" true by construction. Nothing in the compiler enforces it — the interface's
  `get<K>(key): MaoStoreSchema[K]` is an assertion over unvalidated JSON, so a backend that reads past
  the guard compiles and then hands every reader a value of the wrong shape — so `core/store.test.ts`
  reads `electron/store.ts`'s source and fails if the instance is referenced anywhere but the
  composition. A field whose shape is checked goes in `STORED_SHAPE_RULES`, not only in the pair above.
- **Repository capability policy** → `core/repo-capabilities.ts` and the intentionally
  duplicated policy tables/verdict logic in `.agents/workflows/swarm_orchestrator.py` must be
  audited together. Gap ids and reasons, remedy kinds/ranking, public-vs-private scope rules,
  three-state `permissions.push`, and the unverified pipeline grants must stay aligned, with
  regressions in both TypeScript and Python suites. Credential acquisition and command-failure
  classification deliberately differ because Swarm checks the active `gh` credential.
- **New pipeline stage** → the ordered `AGENT_STAGES` (both the `AgentStage` union and workflow-engine
  stage order derive from it) in `core/ai/types.ts`, then `buildPromptForStage` + `applyGithubAction` in
  `core/workflow-engine.ts`, **plus** the `STAGE_LABELS` record in
  `src/components/KanbanBoard.tsx` and `src/components/WorkflowQueue.tsx`, and both
  `ALL_STAGES` + `STAGE_LABELS` in `src/components/GlobalSettings.tsx`, plus
  `core/workflow-engine.test.ts`.
- **Build outputs** → `electron/main.ts` resolves `preload.js` and
  `../dist/index.html` relative to its own compiled location; the `dist-electron`
  directory name itself lives in `vite.config.ts` (`outDir`) and `package.json`
  (`main`, `build.files`), while the renderer's `dist/` is Vite's implicit
  default. Renaming any output means auditing all three files.

## Workflow-engine domain invariants

- Stages: `issue → pr → review → merge` (`AGENT_STAGES`; the engine aliases it as `STAGE_ORDER`). Task statuses derive from
  `WORKFLOW_TASK_STATUSES`: `pending | running | done | error | paused`.
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
- **A stored field's declared type is an assertion, not a guarantee — every array field is read through
  a guard.** Both shipped backends read unvalidated JSON and fill in only the keys that are *missing*
  (`FileStore` spreads the parsed file over `MAO_STORE_DEFAULTS`; electron-store's `defaults` works the
  same way), so a key that is present but the wrong shape survives and is handed to every reader as
  `MaoStoreSchema[K]`. A `githubRepos` that was not an array therefore broke every repository path at
  once: `.filter` threw for `mao repos remove` and `github:getRepos`, `canonicalRepoList` threw on a
  non-iterable `previous` for `mao repos add` and for auto-trigger's per-tick canonicalisation, and `mao
  repos list` printed the malformed value as if it were the list — and because nothing could write the
  list either, the only way out was hand-editing JSON. `createStoredReadGuard()` (`core/store.ts`)
  answers `[]` for a wrong container and filters invalid `aiProviders` / `workflowTasks` entries from a
  mixed array, reporting once per process through `console.warn` with the field, config file path and
  invalid count — never an entry, prompt, token or API key. Coercing rather than throwing is what makes
  recovery possible —
  `updateRepos` reads before it writes, so a throwing read takes `repos add`/`repos remove` down with it.
  The read is deliberately **not** a repair: nothing in the guard writes, so a read-only command leaves
  the file as it found it and the operator can still salvage what the unusable value named. Entry policy
  is field-specific: `githubRepos` still belongs to `isRepoRef`/`canonicalRepoList` (#72), while the
  guard validates the complete declared shapes of `aiProviders` and `workflowTasks` (#75), preserving
  valid entries in order. Do not make the guard silent, and do not add a field to
  `STORED_SHAPE_RULES` without answering the question that field raises: what does the fallback cost,
  which write heals it, and **does losing it let unattended work start against state MAO can no longer
  account for?** All three array-typed fields are guarded now. `aiProviders` is reported and filtered but
  halts nothing — an empty provider list stops every stage at `selectAgent()` before any GitHub write,
  so latching for it would be a larger outage than the fault. A mixed list that leaves exactly one valid
  provider is different: the supported single-provider fallback may reuse it for review, so the report
  explicitly warns that maker-checker cannot select a distinct reviewer. `MaoApp.saveProviders()` refuses
  a GUI save while the raw list is unusable; otherwise the filtered editor snapshot would permanently
  delete the hidden provider and its `apiKey`. Repair the file or explicitly replace the complete list
  with `mao config import-providers`. Any unusable `workflowTasks` entry halts everything; see the next
  bullet.
  The recovery is not silent in either shell, and that is a contract, not a log line: `get()` returns only
  the corrected value (a default or a filtered subset), so the fact cannot ride on the value. `MaoStore`
  therefore carries `problems()` — evaluated on demand against what the backend holds *now*, never
  accumulated as reads happen, because the renderer polls it over a channel of its own and the order of
  two IPC calls must not decide whether the operator is told. `mao config show` prints it; the GUI polls
  `app:storeProblems` and the sidebar shows the report with a **Reset stored list** action, because the
  guard's `console.warn` reaches a main-process console a packaged-app operator never sees and an
  unusable list leaves no row to select, hence no Settings tab and no Remove button. That reset writes an
  *empty* list on purpose: an unusable value names no tracked repository, so every row would count as a
  new registration and be preflighted — a missing or revoked token would block the one recovery left.
  Two properties of that button are load-bearing and tested: it re-reads `problems()` and **aborts** if
  that read shows something already healed the store (a separate IPC round trip, so it narrows the
  cross-process race rather than closing it — `github:setRepos` writes unconditionally) (the report sends the operator to `config.json`, and a `mao repos
  add` in a terminal heals it — writing `[]` blind would then delete the healthy list they just built),
  and it is offered only for a `githubRepos` problem, never for another field's report, because the
  write it performs deletes `githubRepos` and nothing else. The renderer **polls** it rather than only
  reading it at mount: the report sends the operator to `config.json`, and an edit made there while
  the window is open would otherwise stay invisible until the next list write — which is the thing
  that destroys the value, so reading it only afterwards cannot warn anyone in time. It narrows that
  to one poll interval rather than eliminating it: an Add is not gated on a fresh read, deliberately,
  because gating it would make the GUI refuse a recovery `mao repos add` still performs. The poll
  also re-reads the *list* on the one transition that matters — a report that said the list was
  unusable followed by one that does not. A repair from outside this window heals the store without
  the renderer writing anything, so nothing else would re-read it, and taking only the diagnostic
  down leaves the card gone and the sidebar still insisting there are no projects. Only on that
  transition: re-reading every poll would reintroduce the round-trip-lands-mid-typing hazard
  `persistRepos`' success path exists to avoid. The transition is observable **once**, so it is not
  consumed until the list is actually in hand — a read that fails leaves the repair pending and the
  renderer's current list untouched, and the next poll tries again. Clearing it first, or adopting
  `[]` on failure, strands the sidebar on "No projects yet" until the window restarts, with the
  diagnostic already gone and nothing left to say why. The adoption is also **generation-guarded**,
  because repairs are observed on a poll but adopted through a read that takes its own time, so the
  two interleave: a counter is bumped whenever the observed state changes or this window writes the
  list, and a read whose generation has moved is dropped rather than applied. Without it a read
  started for one repair could land after the store had broken and been repaired again — showing
  the list from before that second repair, spending the pending flag so nothing ever read the
  current one, and leaving a stale mirror for the next list write to persist. A generation alone is
  not enough, so two more rules hold: adoption does not **start** while a write from this window is
  in flight (a read taken across one answers with a list the write is about to replace, and its
  generation — captured after the write began — would still look current), and only the
  most-recently-started adoption may apply, because reads sharing a generation can finish out of
  order and a late older answer rolls the sidebar back. The write's own completion re-enters
  adoption, which is what retries the one it held back — releasing that hold is load-bearing and
  tested: leak it and the window never adopts another repair, silently, for the rest of its life.
  Two backend details make "the two shells cannot answer differently" true rather than aspirational.
  `STORED_SHAPE_RULES` is the registry of checked fields, and `describeStoredProblems()` iterates it
  to decide what to *read* — electron-store re-reads and re-parses the whole file on every `get`, so
  walking all six schema keys cost six full file reads per call on the main process. And conf merges
  `defaults` only when it first writes the file, so a key an operator deletes by hand comes back
  `undefined` where `FileStore`'s constructor substitutes the schema default; `createGuardedStore()`
  closes that for both. That composition is also what makes the Electron backend *testable*: it cannot
  be imported from `core/` (rule 1) and electron-store needs a live Electron app, so its only possible
  coverage was a regex over its source — which a mutation feeding `problems()` the **guarded** value
  rather than the raw one passed, while making the GUI permanently blind. `problems()` must read raw:
  the guard has already substituted the default, so asking it what is wrong always answers "nothing".
  The **write** side is the mirror image and deliberately refuses rather than coerces:
  `createGuardedStore.set()` throws for an invalid `aiProviders` or `workflowTasks` list, while
  `setIfUnchanged()` returns `'invalid'`; both decide before a backend read or write. The shared
  `validateWrite()` lets `WorkflowEngine` validate `[...queue, task]` before adopting a new task, so a
  rejected enqueue cannot pollute memory, make every later persistence attempt fail, or create a false
  `persistenceBroken` marker. That single boundary protects both shells:
  notably `mao config import-providers` cannot persist `[null]` and then crash while printing `p.id`, and
  Electron's `ai:save` cannot swap the engine to a list the store refused. Read filtering recovers bytes
  that already exist; write rejection preserves the last durable value. Validators walk array indexes
  rather than using hole-skipping `every`/`reduce` semantics: a sparse hole becomes `null` after JSON
  serialization and therefore has to be rejected before the write too. For repositories,
  `canonicalRepoList` throws when `next` is not an array, because every non-array it can still iterate
  folds to an empty list (a string yields characters `isRepoRef` rejects; a `Set` yields entries in an
  unpromised order) and
  `createRepoRegistrar` would persist that over every tracked repository with no error. The check runs
  before `previous` is walked so auto-trigger — which passes the stored list as both arguments — reports
  the refusal rather than a bare `previous is not iterable`. Coerce on read so recovery is possible;
  refuse on write so a caller's mistake cannot delete the list. Same rule's other half: `FileStore`
  **clones** `MAO_STORE_DEFAULTS` rather than spreading it, so a read never hands out a mutable reference
  into the module-level defaults — a shallow spread let a caller that pushed into the empty list it read
  leak a phantom entry into the default, which the next `FileStore` in that process read back as a
  tracked repository for auto-trigger to poll.
- **Queued tasks snapshot repository identity, not registry policy.** `RepoRef` owns optional
  `autoTrigger` / `pollIntervalMs`; `QueuedTask.repo` is only `{ owner, repo }`. Both enqueue paths strip
  registry settings before prospective validation and mutation, and restore strips settings written by
  older builds. Task validation reuses `isRepoRef()` for the non-empty identity rule, so it cannot both
  reject a registry-only value the queue never reads and accept an empty owner/repo.
- **An unusable `workflowTasks` container or entry halts unattended automation, and the latch is derived —
  no marker, no `clear-` command.** Review of PR #69 established why correcting the queue and carrying on
  is not enough: both long-lived hosts call `startAutoTrigger()` immediately after `createMaoApp()` and
  it ticks at once rather than after its first interval, so the first poll's `enqueueFromIssue()` would `notify()`,
  the `'change'` listener would `store.set('workflowTasks', …)`, and that single write both destroys the
  only salvageable copy of the unusable value or entries **and** starts an unattended pipeline on a host that
  cannot know what was already in flight (the `workflow-active` label is best-effort, so a task lost with
  the queue may carry no label to stop its issue running twice). `createMaoApp` therefore reads
  `store.inspect(QUEUE_GATING_FIELD)` once and calls `workflowEngine.requireQueueRecovery(problem)`
  **before** it subscribes the `'change'` listener and before `restore()`, and the engine then refuses
  `enqueue`, `enqueueFromIssue`, `retry`, `advance`, `setAutoAdvance` and `clearCompleted` (each before
  any mutation and before `notify()`) plus `processQueue` at entry and in its per-task loop. `clearCompleted`
  is gated for a reason that is easy to get wrong: it emits `'change'` too, so leaving it open would let a
  GUI "Clear completed" replace the unreadable value with no confirmation at all.
  No new persisted state, because the corruption is already durable — both backends rewrite the blob from
  a snapshot whose `workflowTasks` the guard never repaired, so only a write to *that field* heals it and
  the next boot re-derives. That is also why the persistence-broken marker must **not** be reused: it
  records a confirmed *write* failure, so `mao config show` would answer `workflowPersistenceBroken: true`
  while persistence is fine, and it is sticky and operator-gated where this heals itself. The two are
  reported as separate fields. A real persistence marker is carried into `WorkflowEngine` before
  restore and blocks public queue mutation, auto-trigger/manual polling and stage processing until the
  operator reconciles GitHub with the durable queue, clears the marker and starts a fresh process. The
  CLI clears its own data directory with `mao config clear-persistence-broken`; the GUI has a two-step
  **Clear marker after verification** action wired to Electron's actual `userData` directory. These are
  deliberately separate because a packaged GUI need not ship the CLI and their default directories can
  differ. The GUI refuses while any stage is still active in that process, so reconciliation cannot go
  stale while a provider or GitHub operation is still in flight. Clearing never releases the current
  engine — restart is still required.
- **Fresh observations live only at recovery and imminent public-write boundaries.** `processQueue`'s
  checks, `safeToResume` and `core/app.ts`'s `'change'` backstop read `queueRecoveryReason` /
  `isQueueRecoveryLatched()` and nothing else. The recovery observation belongs to `healStoredQueue()`,
  which **both** operator actions go through — `confirmQueueRecovery()` (discard while halted) and
  `resaveStoredQueue()` (rewrite from the live queue after a clean start). Separately, every public queue
  mutator already calls `assertQueueWritable()` immediately before changing memory and synchronously
  emitting the persistence write; that method runs one fresh whole-file readiness probe supplied by
  `createMaoApp`. It probes before returning even an existing field-only latch, so a later whole-file
  outage upgrades that latch to restart-only. Auto-trigger likewise keeps making only this fresh
  observation while a field-only latch blocks polling. A failure latches before mutation. This is required
  for snapshot-backed `FileStore`: if a repaired process continued, its next write would replace the
  complete repair with its startup token, providers, repositories and queue. `runStage()` repeats the
  same readiness assertion after long awaits and before each external write, so auto-trigger or the stage
  itself can stop an in-flight run before its next side effect. Composite helpers must preserve that last
  boundary internally: `GithubService.createBranch()` and `commitFile()` invoke the engine's guard after
  their awaited reads and immediately before the REST write, while `commitAndPush()` invokes it after the
  local commit and before spawning `git push`. A caller-side check only after those helpers return is too
  late. Do **not** move the probe into `notify()`:
  recovery writes do not emit, and a generic emitter cannot distinguish storage from other observers.
  The composition root's `'change'` listener reads the monotone field and throws a nominal,
  value-free `QueuePersistenceError` while halted. Public mutators roll back only a guard refusal known
  to occur before the backend write; an arbitrary backend throw has an unknown postcondition, so memory
  is retained and `persistenceBroken` is recorded instead. For an in-flight stage, the throwing listener
  makes `notifyAfterStage()` record that same marker. A silent return is unsafe: it leaves durable
  `running`, which restart normalizes to `pending` and can replay. `notify()` itself is deliberately not a
  gate — the listener and gated callers preserve the write-postcondition distinction. Once set,
  `persistenceBroken` is also an input to every public queue gate and auto-trigger: otherwise the first
  failed enqueue remains in memory but skips its best-effort label, and the next poll can append the same
  issue again and later persist both. `createMaoApp()` rehydrates the same block from the durable marker;
  `resume: false` alone is not enough because a later enqueue invokes `processQueue()` and wakes restored
  pending tasks. A wrong-shaped
  `workflowTasks` **field** is latched only when observed at boot; after a
  clean boot the engine holds the true queue and can restore that field. A whole-file read failure is
  different: the first fresh observation by auto-trigger, a public queue mutation, or either recovery
  action latches the process monotonically and records `restartRequired`, before a GitHub call, memory
  mutation or recovery write. That harder state also replaces any earlier field-only reason with fixed
  restart guidance, so refused actions cannot keep recommending recovery. The origin survives a repair
  which leaves only a field-level problem;
  otherwise the now-readable shape would reopen recovery and let `FileStore` serialize its stale startup
  snapshot over the repair. `clearQueueRecovery()` refuses that state. Only restart can load the complete
  repaired snapshot. The GUI has to distinguish both late states in its own wording: the field-only state
  can offer to save the live queue, while a whole-file-origin state offers no write action. Filtering
  either report out while the halted card did not render hid it entirely.
- **`inspect()` and `setIfUnchanged()` read fresh; `get()` may not.** conf re-reads and re-parses the whole
  config file on every `get`, so for Electron the two are the same call. `FileStore` answers `get` from the
  snapshot taken in its constructor, so it supplies `StoredValueBackend.getFresh` — without it a CLI
  recovery would compare against a value taken at construction and miss a repair that had already landed.
  That fresh read uses a *strict* loader: a file that exists and cannot be loaded throws, so an unreadable
  file becomes "unknown" rather than "unchanged". `loadStrict()` also rejects a top-level `null`, array,
  string or number — those parse cleanly and then spread to nothing (a string, to numeric index keys), so
  they used to arrive as `readable: true` with nothing anywhere to report them. The constructor still keeps
  the swallowing `load()`, and deliberately so: boot coerces, which is what keeps every read-only command
  answering while the file is broken. Issue #67 is answered on the **write** side instead — see the
  write-refusal rail below — which is what the earlier reservation here ("do not quietly change what every
  boot does while fixing a write path") was asking for.
- **One observation decides the latch and feeds `restore()`.** `createMaoApp` calls
  `store.inspect(QUEUE_GATING_FIELD)` once (through one guarded helper) and uses that single result for
  both. `get()` and `problems()` are two reads and conf re-reads and re-parses the whole file on every
  `get`, so deciding from one and restoring from the other left a window: a value turning non-array in
  between read as *healthy* — no latch — and was then restored as the guard's coerced `[]`, so the host
  ran unlatched holding an empty queue and the immediate auto-trigger tick overwrote the unreadable
  original. `inspect()` also answers a third state, `readable: false` (the store could not be read at
  all), which is **not** a flavour of "unusable": a caller about to write must refuse on it rather than
  assume the value is the corrupt one it last saw.
- **`workflowTasks` has two writers, both in `core/app.ts`.** The engine's `'change'` listener, and
  `healStoredQueue()`'s conditional replacement — the single write behind *both* operator actions. It
  cannot go through the listener, because it must be refused when the stored value has moved and `emit()`
  cannot report that back; and it must not go through the engine, which holds no store reference (rule 3).
  Two call sites in the composition root, and still nothing outside it: no shell, and no other `core/`
  module, writes the field.
- **The recovery and the late re-save share one implementation, deliberately.** They use the same
  observe/conditional-write sequence with different preconditions and replacement sources. A halted
  confirmation writes the *fresh observation's* valid subset, then restores the engine from that subset
  without directly resuming; later queue activity in an already-running host may process it after the
  latch is released. Using the boot-time engine queue would delete a valid task another process added
  while leaving the stored list mixed. A clean session's late re-save writes its live engine queue. They were
  built separately once, and the second one promptly drifted into an unconditional write that overwrote a
  repair with a stale queue. Keep them on `healStoredQueue()` so that cannot recur, and keep
  `resaveStoredQueue()`'s refusal-while-halted — without it the repair path is a silent deletion.
- **An action's result must outlive the condition it reports on.** `src/components/Sidebar.tsx` renders
  queue-action messages *outside* the problem card. `already-readable` means the file is genuinely
  repaired, so the refresh that follows empties the problem list and unmounts the card — a message
  rendered inside it disappeared along with the thing it was explaining, leaving a click that looked like
  it did nothing. Pinned by a renderer test that empties the list after the action.
- **`confirmQueueRecovery()` lives on `MaoApp`, owns its own postcondition, and writes conditionally.** It
  returns a typed `QueueRecoveryOutcome` so the CLI command and the GUI button cannot disagree about whether
  confirmation worked — a bare boolean had the CLI re-deriving success while the GUI reported it. **Seven**
  kinds, each saying only what was established: `'replaced'` (still unusable at the conditional write's
  compare, and the write did not throw), `'already-readable'` (readable again, so **nothing is written** —
  the latch is monotone, so after a repair made outside this process the store reads clean while this
  process still holds only its filtered startup subset, and persisting it would overwrite that repair
  with exactly the loss the latch exists to prevent; the operator has to restart), `'restart-required'`
  (this process observed a whole-file read failure, so it writes nothing and cannot release the halt even
  if the current file has become readable), `'superseded'` (the value moved
  between the observation and the compare, so the write refused and nothing was written),
  `'unverified'` (the requested action could not establish a safe replacement, so nothing is written),
  `'invalid-replacement'` (prospective validation rejected the replacement before any backend read or
  write, so nothing was written) and `'write-failed'` (the attempt threw, so what reached the file is
  unknown; the engine records the independent persistence-broken marker and requires reconciliation plus
  restart). The write itself goes through `store.setIfUnchanged`, and the latch is
  cleared **after** it is confirmed — not before, and not through an emit. None interpolates the backend's error text:
  an I/O or parse failure can quote the file's own bytes and that file holds `githubToken` in plaintext,
  so the reasons come from a closed set.
- **Observing before writing is not the same as writing conditionally, and only the second is safe.** An
  earlier revision observed the queue "immediately before" an unconditional `store.set` and claimed that
  closed the destructive interleaving. It did not: `'already-readable'` only catches a repair that finished
  *before* the observation, so a repair landing between the observation and the write was still destroyed
  and still reported as success. `MaoStore.setIfUnchanged()` is what *narrows* it — the write is keyed on
  the raw value the observation saw, and answers `'superseded'` without writing if it moved. A still-mixed
  value can contain a newer valid subset, so halted confirmation must derive its replacement from that
  same observation rather than from the queue captured at boot.
  It does **not** close the race, and must not be described as doing so. Two residues remain, both real
  and both pinned as tests: a repair landing inside the compare → `writeFileSync` interval is still
  overwritten and still reported `'written'` (the pair is atomic only against callers *in this process*),
  and so is a write landing *after* this one. Both are the multi-process lost update every field in this
  single-blob file shares (issue #73). A real cross-process
  postcondition needs a primitive neither backend has (an advisory lock, or `O_EXCL` + rename keyed on a
  stored version with a retry loop); a `version` token on `MaoStore` would not be one either, since
  read-compare-write still leaves a window before the write lands. So keep the word *atomic* out of the
  comments, the operator-facing text and the member names — `inspect` and `setIfUnchanged` say exactly
  what they do, and `MaoStore.setIfUnchanged`'s doc states the limit where a reader will meet it.
- **What the halt does *not* cover, so it is not read as more than it is.** A `config.json` that is not
  valid JSON at all no longer slips past the *queue* latch, and that changed with the fresh read: the boot
  observation goes through `inspect()` → `getFresh()` → `loadStrict()`, which throws on a file that exists
  and cannot be parsed, so it arrives as `readable: false` and latches. Every **other** field still reads
  as its schema default, because the constructor keeps the swallowing `load()`. That is no longer a route to
  data loss — the write refusal below stops the destroying write for every field — but it does mean the
  *halt* is still only about the queue: the latch says "this host runs no unattended pipeline work", never
  "the file is fine".
  Element-level validation covers the complete declared `aiProviders` and `workflowTasks` shapes, but
  deliberately does not add semantic policy such as requiring non-empty credentials, known models, or a
  PR number at a particular stage; those remain the owning settings/engine paths' errors.
  **`githubRepos` is reported at entry level but never filtered or replaced there (issue #72).** Entry
  validity is `isRepoRef`/`canonicalRepoList`'s policy and they need to *see* the junk in order to drop
  it, so `usableStoredValue()` has an explicit pass-through arm for it: without that arm the function's
  fallthrough replaces the value with `[]` the moment a report exists, turning PR #57's recovery — a
  list write drops the junk while keeping the good rows — into "delete every tracked repository".
  Every surface that prints or renders the list therefore goes through the single `usableRepoList()` in
  `core/repo-registry.ts` — `github:getRepos`, `mao config show` and `mao repos list`. That is a secrets
  rail, not tidiness: `config show` promises redaction, and a `githubRepos` holding a pasted token
  printed it verbatim on stdout before this. It **projects** rather than filters, and the difference is
  a second exposure: `isRepoRef` only asks that `owner` and `repo` are non-empty strings, so a row
  carrying `{..., credentialFragment: "ghp_…"}` passes it, and handing that row back put the property
  on stdout with `storeProblems: []` — nothing was wrong with it by the schema's lights. Each row is
  rebuilt from the fields `RepoRef` declares and nothing else. The two optional settings are
  type-checked in the directions their failures point: `autoTrigger` present but not exactly `true`
  becomes `false` (the same asymmetry `mergeOccurrences` applies — a stored `"false"` must not read as
  "poll"), and a `pollIntervalMs` that is not a finite positive number is dropped so the global default
  applies. Filtering never hides the fault, only the values; the report still carries the count.
  **`core/auto-trigger.ts` normalizes through the same helper before canonicalising, and that is not
  optional.** A normalization that reaches only the display is worse than none, because it makes the
  display lie: the scheduler read the stored rows directly, so a `"false"` stayed truthy and polled
  while the sidebar showed *off*, and a `pollIntervalMs: 0` polled on every tick (the destructuring
  default only fills in `undefined`) — a matching open issue could enter the unattended auto-advancing
  pipeline under a UI claiming auto-trigger was disabled. `mao repos add --poll-interval-ms` rejects a
  non-positive or non-integer value at the boundary for the same reason: core makes such a row harmless
  on read, but substituting the default for a number the operator deliberately typed is its own
  surprise. Any new consumer of `githubRepos` goes through `usableRepoList()` too. The other guarded fields need no such rule
  because `usableStoredValue()` filters *them*, so their readers never see a junk entry at all. Reporting it is the other half: the drop used to be
  silent, which is the same dead end for an operator as the unguarded crash was — a `config.json`
  holding `[null]`, a half-written `[{"owner":"acme"}]` or a bare `["acme/widgets"]` left the sidebar
  reading *"No projects yet"* and `mao repos list` printing `[]` on a clean stderr, and with no token
  (or revoked access) even Add was refused by the registration preflight, so there was no in-app
  recovery at all.
  **A report and a destructive recovery are separate things.** `StoredValueProblem.nothingUsable`
  (optional and only-ever-`true`, like `wholeFile`) is the gate a shell must hang a
  "replace this with the schema default" control off — never the report's mere existence.
  `[null, {owner:'acme',repo:'one'}]` is worth reporting, because the next list write erases that entry
  from the file for good, while acme/one is on screen and working: writing an empty list to clear the
  notice would delete the operator's own data. So the sidebar shows every report and withholds **Reset
  stored list** unless nothing usable would be lost, and `resetRepoList` re-checks the same flag before
  it writes, because a hand-edit can make a list partly usable after the card rendered. The flag is
  judged per field by `storedValueNothingUsable()`, with that field's *own* entry predicate, so a value
  kept in memory can never be reported as nothing-usable. Entry reports stay **counted and value-free**
  — how many entries of how many, never their contents: `githubToken` lives in the same JSON blob, and
  these messages reach piped output, agent logs, an IPC payload and a possibly screen-shared window.
  The count is the one fact the operator cannot get elsewhere, since the sidebar and `github:getRepos`
  show only the survivors. `mao swarm`
  reads none of this: it is a separate
  Python engine with a separate credential, so "the queue is latched" must never be read as "this host
  performs no unattended GitHub writes".
- **A write is refused when the file it would rewrite could not be read (issue #67).** Both backends
  persist the whole schema as one JSON blob on every `set()`, so a write performed while the load failed
  does not change one field — it replaces the file with the schema defaults the failed load left in memory.
  `githubToken` is stored there in plain text and exists nowhere else, so this was credential loss, and it
  was reachable from any ordinary command: `mao config set-theme dark`, or a `mao repos remove` that
  matched nothing, printed `No tracked repo matches …` and destroyed the file in the same breath. The gate
  is `assertStoredFileLoadable()` inside `createGuardedStore.set()` — one place, so it covers `FileStore`
  and electron-store together, and covers a file corrupted *after* a clean boot — but only because the
  fresh read it consults is strict for **both** backends; see the conf rail below for why that does not
  come free. It is the action `StoredObservation.readable` already documented ("a caller about to write
  must refuse") generalised from the one field `saveProviders` applied it to.
  **Refuse the write, never the boot.** A throwing constructor was the other candidate and is wrong here:
  it would take `mao config show`, `mao repos list` and the Sidebar's diagnostic poll down together with
  the destructive write, leaving an operator a dead process and no statement of what broke. Reads keep
  coercing; `problems()` is what tells them. Nothing is renamed or copied aside either — not writing
  preserves the file more completely than moving it, and `config.json` is secret-bearing, so an automatic
  rename would plant the token at a second path the operator never chose.
  `problems()` probes the whole file *before* the per-field rules, because when the load failed those
  rules read an already-defaulted snapshot and answer "nothing is wrong" — which is how `mao config show`
  printed `storeProblems: []` beside `githubToken: '[unset]'` for a file that still held the token. The one
  entry is carried on `QUEUE_GATING_FIELD` so `findStoredQueueProblem()` and the Sidebar's queue card still
  find it; it deliberately does not claim to be a `githubRepos` problem, which would put that card's
  destructive "Reset stored list" button under a message that is not about repositories. That entry also
  carries `wholeFile: true`, and `src/components/Sidebar.tsx` must branch on it rather than on the report
  text: a wrong-shaped *field* in a file that loaded really is healed by this session's next queue write,
  so the card offers to save now, while a file that did not load refuses every write — there the same copy
  promises a rewrite that cannot happen and the button can only answer `'restart-required'`.
  A read that fails must not escape a caller that cannot catch it, either. `core/auto-trigger.ts`'s
  `tick()` is invoked bare and from `setInterval`, so both long-lived hosts pass a fresh
  `store.inspect('githubRepos')` observation and the scheduler guards it before polling. This is also
  required for `FileStore`, whose ordinary `get()` is a constructor snapshot and therefore cannot see a
  late whole-file failure. The fixed, deduplicated headless diagnostic never interpolates the caught
  error. Any new long-lived consumer of a fresh store read owes the same guard.
  Manual `pollNow()` owns current tracked-list membership, that fresh read/latch and the repository
  capability preflight in that order, and propagates its recorded poll error to the caller. Shells must
  not read the repository list or preflight before it: either operation would bypass the latch on a late
  whole-file failure, or spend a GitHub call for a repository the current list no longer tracks.
  Never interpolate the underlying read error into any of these reports, and never give
  `UnreadableStoreError` a `cause`. V8 puts the input's first ten characters into `SyntaxError.message`
  (`Unexpected token 'g', "ghp_SENTIN"... is not valid JSON`), and a `config.json` clobbered down to a bare
  token is exactly that input.
- **conf is judged *before* it is constructed, because its constructor writes.** The write gate above is
  not enough for the GUI, and this is the one place ordering is the fix rather than a detail. conf builds
  its store inside its own constructor: for an **unparseable** file it rethrows (`clearInvalidConfig`
  defaults to `false`) and the bytes survive, but for `null`, an array, a string or a number its `store`
  getter *succeeds* (`Object.assign({}, [1,2,3])`), the `assert.deepEqual` against the merged defaults then
  fails, and it writes those defaults straight back — destroying the file *before any `set()` exists to
  refuse it*. Measured against the installed conf 14.0.0 for all four shapes. So
  `openGuardedStoreFile()` runs `loadStoredFileStrict()` first and never reaches `new Store(...)` for a
  file it cannot use. A check placed after construction would run on a file conf had already overwritten.
  The `try` around the construction is the second half and is not redundant: conf rethrows V8's own parse
  error, which quotes the input's first ten characters, so for a `config.json` clobbered down to a bare
  token letting that escape publishes the credential into the main process's logs. It is rewrapped
  value-free, which also covers the window where the file changes between the check and the construction.
  `electron/store.ts` must therefore pin `cwd` and `name`: the gate needs the path before an instance
  exists, so there is no `backing.path` to read, and leaving those to conf's defaults would make the judged
  file and the opened file agree only by coincidence. Never pass `clearInvalidConfig: true` — conf would
  answer `{}` for an unparseable file and write the defaults over it, inside the library where no gate can
  intercept it.
  **Judging the file at construction is only half of it, because conf does not fail for a root it can
  coerce.** Its getter is `Object.assign({}, parsed)`, so a `config.json` replaced with `[1,2,3]`, `null`, a
  bare string or a number *after* a clean boot comes back as a property bag with every schema key simply
  absent — no error at all. `readRawFresh`'s fallback to `backend.get` therefore saw a healthy store, the
  write gate passed, and the next `set()` rewrote the file from defaults: issue #67 again on the far side
  of boot, measured for all four shapes. So `openGuardedStoreFile` also *supplies* `getFresh` from
  `loadStoredFileStrict(filePath)` rather than letting the backend's own read stand in for it. A backend
  opened from a path gets the path's rules, not the library's. The invariant is not "never call
  `createGuardedStore` directly" — `FileStore` does exactly that and is correct, because it supplies its
  own `getFresh` built on `loadStoredFileStrict`. It is: **any backend handed to `createGuardedStore` must
  supply a `getFresh` that applies the root-shape rule**, and `openGuardedStoreFile` is how a backend that
  reads the file itself gets one for free.
  **A pre-check cannot cover a backend that reads again, so conf is given the rule itself.** Two intervals
  sit past the check, and both were measured destroying the file or leaking on the real library. A
  replacement landing between `loadStoredFileStrict()` and `new Store(...)` was coerced and written back
  from conf's constructor with no exception — the `try` never fired, and a `getFresh` installed afterwards
  cannot recover bytes already gone. And conf's `set()` re-reads to merge *after* the write gate's own
  fresh read, so a replacement at that moment surfaced as V8's error, quoting the file. Narrowing those
  windows is not a fix; `electron/store.ts` therefore passes `deserialize: createStoredFileParser(configPath)`
  so the root-shape rule applies to the bytes **conf itself** parses — in its constructor, on every later
  read, and on the merge inside a write. There is then no read of the backend's own that escapes the rule.
  The write path also converts through `withoutStoredBytes`, which is deliberately narrower than
  `asUnreadableStoreError`: only a parse failure can carry the file's bytes, and relabelling an errno
  write failure as "could not be read" would send an operator after the wrong thing.
  **No backend's own read error may reach a caller.** conf re-reads and re-parses on every `get`, so an
  ordinary read can fail, and its error is V8's — which quotes the file. `get()` and `problems()` convert
  through `asUnreadableStoreError`, and `problems()` keeps the probe *and* the per-field rules inside one
  boundary, because `describeStoredProblems` reads every guarded field and each of those is another parse.
  Converted, never swallowed: answering schema defaults for a file MAO could not read is the silence #67
  was about, and the write gate already stops anything persisting over it.
  Still open, tracked as **issue #91**: this throws at module load, and `electron/main.ts` reaches it
  through `electron/ipc.ts`, so the app exits before a window exists and the operator sees **no dialog**.
  The bytes survive. Do not repeat the claim that `mao config show` is the recovery path without checking
  it — `build.files` ships no `dist-cli`, and Electron's `userData` uses `productName` (`MAO`) while the
  CLI resolves `defaultDataDir('mao')`, which are different paths on a case-sensitive filesystem.
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
  owner/repo strings and collapsing duplicates. Checked list and stored list are therefore the same
  bytes, and the guarantee holds by construction. Two details there are load-bearing, both with
  regression tests. When one list names a repository twice, the **earlier** occurrence keeps every
  setting it defines and the later fills in only the rest — the later is characteristically the less
  informed (a bare `{owner, repo}` from the sidebar's Add form, or a stale row from a pre-fix
  duplicate), and letting it win blanked a tracked repo's `autoTrigger`/`pollIntervalMs` and silently
  restarted unattended polling. `mao repos add` still replaces settings outright, because its callback
  drops the entry it supersedes so only one occurrence arrives. `autoTrigger: false` is the exception
  that wins from either side: the two ways of guessing wrong are not symmetric, since one of them
  resumes a pipeline that opens branches, PRs and merges unattended. The entry first in stored order
  supplies the surviving spelling. That is *not* enough to protect queued work on its own — both
  duplicate rows were live, so tasks can carry either spelling — which is why the board and queue match
  tasks with `sameRepoRef`, and why `startAutoTrigger` deduplicates the list it polls rather than
  waiting for a list write to heal the store (an unattended `mao run` never performs one). An update
  callback must also **delete by identity, never by array position**: omitting one row of a duplicated
  pair hands core a list that still names the repository, so it stays tracked *and* inherits the other
  row's settings — which is how the GUI's Remove button re-enabled polling on a repo it was asked to
  delete. Keep
  canonicalisation there, not in a shell. Deliberately **not** a lower-casing of stored entries:
  `QueuedTask.repo` snapshots only owner/repo at enqueue time and the board and queue views filter tasks by an
  exact `t.repo.owner === repo.owner`, so rewriting stored spellings would hide every task queued
  before the change — and it would misspell repositories back at the operator in the sidebar.
- **Registration and every stage are gated on a read-only permission preflight**
  (`core/repo-capabilities.ts`). Adding a repo — via the GUI sidebar or `mao repos add` —
  persists nothing unless the check passes; *updating* and *removing* an already-tracked repo
  deliberately skip it, so a repo whose access was revoked stays manageable. Auto-trigger runs
  the same check before `fetchTasks`, so an unauthorized repo yields zero `enqueueFromIssue` and
  zero `workflow-active` label writes. Never add an exemption list.
- **Real `mao swarm` runs have their own credential-aligned preflight.** Before Git sync, worktree
  creation, AI dispatch, or direct `gh` writes, the Python orchestrator performs one non-mutating
  repository GET with the same active `gh` CLI credential inherited by dispatched agents. It runs at
  startup and again before each later polling cycle so revoked access stops new lifecycle work. The
  explicit `--reset` history clear is the only local mutation allowed before the network gate, so it
  remains usable while access is being repaired. The orchestrator resolves every effective `origin`
  fetch and push URL (including SSH aliases), rejects identities that disagree, and overrides
  inherited `GH_REPO` and `GH_HOST` for both its own calls and agent subprocesses. A caller therefore
  cannot preflight one repository or host and dispatch or push against another. `--status` bypasses
  target resolution entirely; `--dry-run` binds the locally resolved origin but skips the write
  capability probe and, because it cannot push, the custom-SSH-transport proof. Real runs reject
  custom `core.sshCommand`, `GIT_SSH_COMMAND`, and `GIT_SSH` overrides for SSH origins because the
  system `ssh -G` result would not prove their actual target. Effective
  SSH host, user, and port are resolved and compared together; an effective `ProxyCommand` or
  `ProxyJump` is also rejected because those can redirect the transport beyond that endpoint proof
  (only GitHub's documented
  `ssh.github.com:443` endpoint is equated with `github.com:22`). HTTP origins and non-default HTTPS
  ports are rejected because the default `gh` API authority would not prove that target; HTTPS
  origins bind scheme, host, and effective port 443. Every role revalidates those bound endpoints
  immediately before dispatch — Workers in their task worktree, Reviewers and Maintainers in the
  repository checkout. The effective repository-local or worktree-local `remote.pushDefault`,
  `branch.<name>.pushRemote`, and `branch.<name>.remote` values must name `origin`; shadowed values
  and an operator's global selectors do not cause a false rejection. Every child environment then
  adds highest-precedence command-scope values pinning all three implicit push selectors to
  `origin`, so inherited or global selectors cannot redirect a bare push either; legacy
  `GIT_CONFIG_PARAMETERS` is rejected once at real-run startup (with a `git -c`/hook diagnostic)
  and again at the spawn boundary because Git applies it after those values. A detached
  repository root is valid for Reviewer/Maintainer dispatch: origin, transport, and
  `remote.pushDefault` are still checked and pinned, while nonexistent branch-scoped selectors
  are omitted. Task worktrees must remain attached to their expected branch. Effective
  `core.sshCommand` remains all-scope and fail-closed because it changes even an explicit push's
  transport. Revision dispatch accepts a same-repository,
  non-empty GitHub head ref, fetches `refs/pull/<number>/head`, and requires the fetched commit to
  equal the listed `headRefOid` before it creates a missing local branch from that commit. It never
  falls back to `origin/main`: a tracked-clean local ancestor is fast-forwarded to that verified
  head while non-conflicting untracked files are preserved; tracked changes, conflicting untracked
  or ignored files, or divergent history are preserved with an actionable blocker. Fork PRs it
  cannot update through `origin` are refused. Direct Git/process calls pass the ref as an argv element without a shell;
  command examples in the human-readable prompt quote it with `shlex.quote`. That quoting is
  command-example hygiene, not a prompt-content trust boundary. Eligible `[Task]` Issue
  titles/bodies have no author-association gate before becoming instructions for tool-enabled
  Workers. Revision feedback is limited to the active gh
  user or an `OWNER`/`COLLABORATOR`/`MEMBER`, then passed through as instructions too. Run
  autonomous Swarm only where those task-authoring surfaces are trusted or moderated; it does not
  sandbox hostile prompt content. A
  passing verdict means only that GitHub exposed no known blocker: fine-grained
  Issues/Contents/Pull-requests grants stay explicitly unverified when the API cannot prove them.
  Git transport is a separate boundary too —
  `git push` may use SSH or another credential helper, so the `gh` preflight never claims to prove
  that credential. The store's `githubToken` is intentionally not consulted for Swarm.
  One malformed task is isolated from later Issues, PRs, and merged-task cleanup; a failed
  authenticated-user lookup also fails the affected PR batch closed, and `--once` exits non-zero
  when any item failed. Every selected non-preflight setup or launch failure before successful
  registration consumes the same bounded per-event retry budget as a child crash. Per-item typed
  preflight blockers, whether configuration or transient, stay retryable, and provider-wide
  cooldowns remain exempt. Their dedup keys contain the item lifecycle, exception class, and a
  finite cause code (normally its source site), never the full error message: the first occurrence
  of each cause logs at error level and uninterrupted repeats log at debug without a traceback. A
  successful dispatch or definitive terminal/no-dispatch result clears the item's preflight keys;
  incomplete observation and provider-cooldown deferrals retain them, since neither is a clean pass.
  Registry updates use same-directory atomic replacement. Invalid registry roots/history containers
  recover as empty, malformed entries are skipped individually, and every real poll reconciles
  inherited `running`/`stuck` records once their process tree exits. Recent diagnostic history has a
  hard 500-record cap; dispatch authority lives in a separate bounded table with one current event
  per role for each Issue or PR. A new event replaces only that role's prior event, so normal
  Reviewer → Worker revision → Maintainer transitions do not erase one another while repeated PR
  heads still cannot grow the registry without limit. Only an open-item result shorter than the
  1,000-item query limit proves that its snapshot is complete enough to prune closed terminal items;
  live or stuck ownership always survives. Provider cooldowns are stored in their own bounded map,
  and legacy registries are collapsed into this schema on load. A child discovered while unwinding after adoption
  but before registration persistence is first saved as running before bounded termination, so a
  hard leader crash remains recoverable, and then persisted once more as removed or stuck; this
  fallback performs at most two atomic writes. Dispatched agents
  require isolated POSIX process groups; unsupported platforms fail before the write preflight or
  runtime-file creation. Shutdown and normal leader exit signal all eligible process groups in a
  batch, then terminate residual descendants within one shared supervision deadline and one shared
  forced-exit grace. Polling and `--once` share the same signal controller. A shutdown signal
  arriving during the narrow spawn-to-in-memory-adoption ownership transfer defers its exception
  until the child is supervised, even when spawn or adoption raises; checkout/environment preflight
  happens before that window, and both modes stop before any later lifecycle work. In particular,
  `--once` skips merged-task cleanup after shutdown. Registry persistence happens outside that
  deferral window. A
  failed termination becomes a persisted `stuck` state, is never
  automatically re-signalled by numeric PGID, and blocks only that lifecycle event until an operator
  terminates the residual tree; shutdown stays non-zero instead of silently leaving an untracked
  background `git push` or `gh` write alive.
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
  cleanup and tolerate StrictMode double-invocation. A renderer **behaviour** change
  needs a test under `src/**/*.test.tsx` — mount the real component against
  `createElectronApiStub()` and assert what the operator sees. `tsc --noEmit` and a
  green `vite build` prove nothing about what the UI does.

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
