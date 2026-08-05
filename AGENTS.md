# AGENTS.md — MAO Agent Guide (Single Source of Truth)

This file is the **single source of truth** for every AI agent (Claude Code, Codex,
Antigravity, or any other tool) working in this repository. The tool-specific entry
files (`CLAUDE.md`, `.antigravity/rules.md`, `codex.md`) intentionally contain nothing
but a pointer here — keep it that way to avoid context fragmentation.

Operational knowledge (commands, verification steps, recipes) lives in
[SKILL.md](SKILL.md). Read **both** files before starting any task.

## What this project is

MAO is a dev-toolkit that lets AI agents drive a GitHub workflow — **issue → PR →
review → merge** — end to end, with a **maker-checker** safeguard so the same AI never
reviews its own work. One Electron-free core powers two frontends:

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
   and break `core/` under Node). Tests live in `core/**/*.test.ts` only.

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
  Therefore every external call must be time-bounded — the API provider aborts
  after 5 min, the CLI provider SIGKILLs after 15 min. Timeouts must surface as
  task errors, never silent stalls.
- **Failures are retryable states, not crashes**: any throw inside `runStage()`
  (including synchronous setup like `selectAgent()` — keep it inside the
  `try/catch`) sets `status: 'error'` without advancing the stage, so `retry()`
  re-runs the same stage.
- **CI gate**: the merge stage only proceeds when `getChecksStatus` reports
  `'success'` or `'none'`; `'pending'` and `'failure'` throw (retryable). No CI
  configured on the target repo means "nothing to wait for".
- **`allowToolUse` elevation** (`claude --dangerously-skip-permissions`,
  `codex -s workspace-write`) applies **only** to the `pr` stage's real-checkout
  path with a CLI provider. Never extend it to API providers or other stages.
- Issues entering the workflow get the `workflow-active` label, which is the
  **only** duplicate-enqueue protection (auto-trigger never checks the queue
  itself) — and both label writes swallow failures via `.catch(() => {})`, so a
  failed label write means the same issue re-enqueues on every poll. Treat the
  label as best-effort, not a guarantee. Finished tasks are capped at 50 (oldest
  dropped).

## Safety rails — this app performs real GitHub writes

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
- **CI gates every PR** (Node 22): `npm ci && npm run lint && npm run test &&
  npx vite build`. Note CI does **not** build the CLI bundle — run
  `npm run build:cli` yourself when touching `cli/` or `core/`.

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
