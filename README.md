# MAO

[![CI](https://github.com/dragoncowkarma/mao/actions/workflows/ci.yml/badge.svg)](https://github.com/dragoncowkarma/mao/actions/workflows/ci.yml)

Electron dev-toolkit that lets AI agents drive a GitHub workflow — **issue → PR → review → merge** — end to end, with a maker-checker safeguard so the same AI never reviews its own work.

## Features

- **BYOK / CLI adapter** — plug in an API key (Anthropic or OpenAI-compatible) or a locally installed CLI (`claude`, `codex`, etc.) as an AI provider, via a common `AiProvider` interface. Each provider can optionally carry a `model` and an informational `effort` (low/medium/high) shown next to its work throughout the UI.
- **Maker-checker cross-verification** — the AI that handled a task's previous pipeline stage is automatically excluded from the next one, so no agent reviews or merges its own work.
- **Project sidebar** — every registered `owner/repo` is a project in the left sidebar; selecting one opens straight into its Board (issues/PRs), with Queue and per-project Settings as tabs alongside it. Global settings (GitHub token, AI providers) live in their own section, separate from per-project config (auto-trigger on/off, poll interval).
- **Kanban board** — GitHub Issues/PRs synced live (manual "Refresh" button plus a "synced Xs ago" indicator), sorted urgent-first then latest-updated. Cards driven by an active workflow task show their live pipeline stage/status (queued, running, paused, failed, done) at a glance.
- **Automated pipeline** — `issue → pr → review → merge`, driven by registered AI agents:
  - **issue**: an agent drafts the issue body and files it on GitHub.
  - **pr**: a CLI agent gets a real local git checkout and edits actual project files; the diff is committed, pushed, and opened as a PR (falls back to a notes-only PR if the agent made no real edits, or if the provider is API-only).
  - **review**: an agent leaves a real PR review comment.
  - **merge**: blocked until GitHub Actions checks / commit statuses report success — merges and comments once they do.
- **Per-stage transparency** — the Queue view shows which agent/model/effort ran each completed stage plus its exact prompt and output (expandable), and while a stage is in flight shows a live "currently working" indicator with the in-progress prompt.
- **Manual task control** — each task can run fully automatically or with "auto-advance" turned off, in which case it pauses after every stage until you click "Run next stage" — useful for reviewing a stage's output before letting the pipeline continue.
- **Auto-trigger** — polls every registered repo for new open issues and enqueues them automatically (tracked via a `workflow-active` label so nothing gets processed twice). Each repo can independently disable auto-trigger or set its own poll interval from its project Settings tab.
- **Multi-repo** — register any number of `owner/repo` pairs; each queued task carries its own repo.
- **Persistence & retry** — the workflow queue survives app restarts (interrupted tasks resume), and failed tasks can be retried from the same stage with one click.
- **Queue cleanup** — finished tasks are capped (oldest dropped past 50) and can be cleared manually.

## Getting started

```bash
npm install
npm run dev          # Electron + Vite dev server with hot reload
```

### Building

```bash
npm run build         # fast unpacked build → release/mac (or platform equivalent), for local testing
npm run dist           # full distributable: dmg + zip (mac)
npx electron-builder --win zip --linux AppImage --publish=never   # cross-build win/linux from a mac host
```

### Settings

Open the app and fill in the **Settings** panel:

- **GitHub token** — a personal access token with `repo` scope (add `workflow` scope too if you want the app pushing to `.github/workflows/*`).
- **Repositories** — one or more `owner`/`repo` pairs to poll and run workflows against.
- **AI providers** — add at least one, ideally two (for real cross-verification to have somewhere to route to):
  - **API (BYOK)**: pick Anthropic or an OpenAI-compatible format, paste an API key.
  - **CLI**: a locally installed command (e.g. `claude` with args `-p`, or `codex` with args `exec`). The app appends the right flags automatically to make each known CLI behave — see [Known CLI quirks](#known-cli-quirks) below.

All settings persist locally via `electron-store` (in the OS's app-data directory) — never committed to source.

## Architecture

```
electron/
  ai/               AiProvider adapter (api-provider.ts, cli-provider.ts) behind a common interface
  github-service.ts GitHub REST calls: issue/PR fetch, branch/commit/review/merge/CI-status
  git-workspace.ts  Local git clone/branch/commit/push (child_process, no Electron dep)
  workflow-engine.ts Core state machine: queue, stage progression, agent routing, CI gate,
                    manual auto-advance/pause control
  auto-trigger.ts   Per-repo polling scheduler; auto-enqueues new issues, tracks last-poll
                    status, and exposes a manual pollNow() for on-demand refresh
  store.ts          electron-store schema (token, repos, providers, workflow queue)
  ipc.ts            IPC handlers wiring the above to the renderer
  main.ts / preload.ts  Electron entry points
src/
  App.tsx           Sidebar + project tabs (Board / Queue / Settings) shell
  components/
    Sidebar.tsx        Project list, add-repo, link to Global settings
    KanbanBoard.tsx    Issues/PRs for the selected project, with live workflow status badges
    WorkflowQueue.tsx  Task list for the selected project: agent/model/effort, prompts,
                       manual advance/pause controls
    ProjectSettings.tsx  Per-repo auto-trigger toggle, poll interval, remove
    GlobalSettings.tsx   GitHub token, AI providers (model/effort)
scripts/
  test-workflow.ts  Standalone harness — runs WorkflowEngine + GithubService outside Electron
```

`WorkflowEngine` and `GithubService` have zero Electron dependencies, so `scripts/test-workflow.ts` can drive the whole pipeline directly under plain Node (see below) — useful for testing without the UI.

## Unit tests

```bash
npm run test        # vitest run — WorkflowEngine stage progression, maker-checker,
                     # retry, CI gating, and manual pause/advance, all against fakes
```

## Testing against a real repo

Copy the env template and fill in a **throwaway test repo** (the pipeline creates real issues/branches/PRs and can merge them):

```bash
# .env.test (gitignored — never commit real tokens)
TEST_GITHUB_OWNER=
TEST_GITHUB_REPO=
TEST_GITHUB_TOKEN=
TEST_TASK_TITLE=
TEST_AI_API_FORMAT=anthropic
TEST_AI_API_KEY=
TEST_AI_MODEL=
TEST_AI_CLI_COMMAND=
TEST_AI_CLI_ARGS=
TEST_AI2_NAME=
TEST_AI2_CLI_COMMAND=
TEST_AI2_CLI_ARGS=
```

Then run:

```bash
node --experimental-strip-types --env-file=.env.test scripts/test-workflow.ts
```

This drives one task through the full pipeline and prints its final state as JSON.

## Known limitations

- **CLI agents are full coding agents, not pure text completions.** `claude`/`codex` sometimes respond with meta-commentary ("I can't find a PR to review...") instead of the requested text, especially at the `review`/`merge` stages, which don't run inside the actual repo checkout. The `pr` stage (which does run in a real checkout with `allowToolUse`) behaves best.
- **`allowToolUse` bypasses CLI safety prompts** (`claude --dangerously-skip-permissions`, `codex -s workspace-write`) so the agent can actually write files during the `pr` stage. This only applies to that one stage/path — API providers and the other stages never get elevated access.
- **No code signing.** Builds are unsigned; macOS Gatekeeper and Windows SmartScreen will warn on first launch. Distributing beyond personal/internal use needs an Apple Developer cert (notarization) and a Windows code-signing cert.
- **CI safeguard needs GitHub Actions (or any status-API integration) on the target repo.** If no CI is configured, the merge stage treats that as "nothing to wait for" and proceeds immediately.
