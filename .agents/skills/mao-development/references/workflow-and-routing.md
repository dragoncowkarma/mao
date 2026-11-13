# Workflow engine and agent routing

Tier 3 reference — read when changing the workflow engine, agent routing, `core/ai/` or `core/git-workspace.ts`, adding a stage or AI provider, or driving the pipeline through the CLI or E2E harness. Rule summary: [AGENTS.md](../../../../AGENTS.md). Playbook: [SKILL.md](../SKILL.md).

## State machine

- Stages: `issue -> pr -> review -> merge`, from `AGENT_STAGES` (`core/ai/types.ts`); `STAGE_ORDER`
  aliases it. Statuses: `WORKFLOW_TASK_STATUSES` = `pending | running | done | error | paused`.
- A finished stage moves on as `pending` (`autoAdvance: true`) or `paused` (`false`); the last ends `done`.
- MAO-created tasks start at `issue` (`enqueue()`); existing GitHub issues (human-filed, auto-triggered)
  start at `pr` (`enqueueFromIssue()`).
- `restore()` replaces and normalizes the queue **without emitting `'change'`**; account for that before
  changing startup persistence.
- Finished tasks are capped at 50 (`MAX_FINISHED_TASKS`), oldest dropped.
- `QueuedTask.repo` is only `{ owner, repo }`; `RepoRef` owns `autoTrigger`/`pollIntervalMs`. Both enqueue
  paths strip them before validation and mutation; `restore()` strips older builds'. Validation reuses
  `isRepoRef()`: identity only, non-empty.

| Stage | Role (`STAGE_ROLE`) | `applyGithubAction` |
| --- | --- | --- |
| `issue` | worker | `createIssue`, best-effort `addLabel` |
| `pr` | worker | notes-only `createBranch` -> `commitFile` -> `createPullRequest`. Real-edit bypasses this: `runStage()` calls `runPrWithCodeEdits()`, which lands here only when the agent made no edits |
| `review` | reviewer | `reviewPullRequest`; merge does not read it |
| `merge` | maintainer | CI gate, `mergePullRequest`, best-effort `commentOnIssue` |

## Agent routing and maker-checker

- Rules live in `core/agent-selection.ts` (pure, renderer-importable); `selectAgent()` only calls
  `resolveStageAgent()`. Never re-derive them in `src/`.
- Maker-checker: a stage must not return to the `agentId` of the last `task.history` entry; preserve this
  in any routing change.
- `allowedStages` (`isStageEligible()`; absent or empty means any) narrows the pool first; an empty pool
  throws.
- `eligibleAgentsForRun()`: what a card's dropdown may offer. `previewStageAgent()`: non-throwing form cards
  use to show the lined-up agent, even before a first run.

| Tier, highest first | Set by | Lifetime | If it names the agent that just ran |
| --- | --- | --- | --- |
| `RunOverride.providerId` | `retry`/`advance --provider`, card | one stage | **throws**, unless same role carrying on or no other eligible provider |
| `ProviderOverride.roles[role]` | `enqueue --worker/--reviewer/--maintainer`, issue tags | durable | passed over; none left throws. Worker across `issue -> pr` skips the guard: same role, not a check on its own work |
| `ProviderOverride.providerId` | `enqueue --provider` | durable | passed over; none left relaxes to it |
| none | rotation | — | first eligible that did not just run; none left relaxes |

- An unregistered or stage-ineligible id throws: a stored pin at stage time (retryable), a one-shot on the
  command itself. Proof: `core/workflow-engine.test.ts`, describes `provider override`,
  `role assignment (swarm_orchestrator-style Worker/Reviewer/Maintainer pins)`, `allowedStages`,
  `one-shot run override (card Tool/Model/Effort dropdowns)`; `core/agent-selection.test.ts` (effort, preview).

## ProviderOverride: durable pins and issue tags

- Flags and tags take a provider **id** from `mao config show`, not a CLI tool name.
- `parseProviderOverride()` (`core/assignment.ts`) reads `[Worker: <id>]`, `[Reviewer: <id>]`,
  `[Maintainer: <id>]`, `[Model: <modelId>]`, `[Effort: <level>]`; none means default rotation.
- Only auto-trigger parses bodies (`mao run`, `github:refreshRepo`), not `workflow enqueue-existing` or
  `workflow:enqueueFromIssue`.
- Ids and models exclude whitespace, `|` and `]`, so swarm-style `[Worker: id | Model: x]` is ignored.
- Tags inside code fences, inline code, HTML comments and blockquotes are ignored, so documenting them is
  safe.
- Last occurrence wins, validated after, never per match: `[Effort: high]` then `[Effort: turbo]` yields no
  effort override, not `high`.
- `AI_EFFORTS` (`core/ai/types.ts`) is the single definition `AiEffort` and tag, one-shot and store validation
  use. GUI lists are separate: to offer a new level, also add it to `efforts` in `PROVIDER_OPTIONS` and the
  effort `<select>` in `src/components/GlobalSettings.tsx`. Tags match case-insensitively; an unknown level is
  ignored.
- Model passes through verbatim; a typo surfaces as a provider error.
- Model and effort are task-wide and never influence which provider runs; they apply on a copy of it. Never
  mutate saved config. Order: one-shot, `providerOverride`, provider's own, active preset.
- A resolved effort is dropped when the model is `noEffort` in `PROVIDER_OPTIONS`
  (`core/ai/provider-options.ts`); a CLI would otherwise get a literal `--effort` it does not take.

### Shared CLI arguments and native Swarm tags

`buildModelEffortArgs()` in `core/ai/provider-options.ts` encodes resolved arguments without rewriting
ordinary saved provider models or efforts, including custom wrappers named after built-in CLIs. Codex
uses `-c model_reasoning_effort=<value>`; an existing explicit model/effort flag is not duplicated.
Retain `noEffort` metadata for current Haiku and stored legacy ids so a catalog refresh cannot add an
unsupported flag to an old configuration.

Only native Swarm prose tags use alias normalization, the reasoning ladder and model clamping in
`core/swarm/models.ts`. Its last-unquoted-tag parser, role cost overrides, custom-model policy and
CLI prompt transports are documented in [repo-preflight-and-swarm.md](repo-preflight-and-swarm.md).
Swarm runs inside the CLI bundle, using active gh credentials and its own process registry; it neither
loads the app queue nor starts through `createMaoApp()`. Its `--once` child drain has a shared 45-minute
cap, and a latched app queue does not stop this separate engine.

## RunOverride: one-shot, stricter

- `retry(taskId, runOverride?)` / `advance(taskId, runOverride?)` take `{ providerId?, model?, effort? }` from
  `--provider/--model/--effort` or `src/components/AgentRunControls.tsx`.
- Same flag names as `enqueue`, different lifetime: `enqueue` sets the durable pin; this covers one stage
  execution. The pick is not reused, but its agent is in `task.history`, so the next stage's maker-checker
  excludes it.
- Stored as `QueuedTask.nextRunOverride`; `runStage()` reads and clears it **before the entry `notify()` and
  any await**, so neither a failure nor auto-advance reuses it. It never touches saved config or
  `providerOverride`.
- It survives `restore()`: a crash between click and run still honors the choice.
- `armRunOverride()` validates before mutating, so a bad pick rejects the call instead of erroring the task:
  effort against `AI_EFFORTS`, then a dry-run `resolveStageAgent()` (only with an override, so a plain retry
  works with no provider registered).
- It throws where a stored pin is passed over: the operator named this agent, and a silent substitute is worse.
- Proof: `core/workflow-engine.test.ts`.

## Runtime tool snapshot

`runStage()` snapshots `providerKindId` onto `task.active` and each `WorkflowStepResult`. `ai:save` can
replace the provider list mid-stage, so never resolve a past or in-flight run's tool by looking `agentId` up
in the current list: it can show a config never used, or none if deleted. Only a prediction
(`previewStageAgent()`) may read live config.

## Per-stage write preflight

- `runStage()` awaits `github.assertRepoWorkflowWritable(...)` inside its `try`, after the entry `notify()`,
  **before** `selectAgent()`: no AI call, git clone/push or GitHub write reaches a repo this credential
  cannot write.
- Every path funnels here (`enqueue`, `enqueueFromIssue`, `restore()`/resume, `retry()`, `advance()`), so
  registration-time validation cannot be bypassed. Failure: `error` at the **same** stage, retryable.
- No repo is exempt, `dragoncowkarma/mao` included.
- It runs after the one-shot is cleared, so a rejection consumes it; `retry()`/`advance()` re-arm only from
  their own argument.
- One non-mutating `repos.get`; `ok: true` means only no known blocker. Policy:
  [repo-preflight-and-swarm.md](repo-preflight-and-swarm.md). Proof: `core/workflow-engine.test.ts`.

## Single-flight queue and timeouts

`processQueue()` runs one stage at a time across all repos, so every external call must be bounded and a
timeout must surface as a task error, never a silent stall.

| Call | Bound | File |
| --- | --- | --- |
| API provider | 5 min abort | `core/ai/api-provider.ts` |
| CLI provider | 15 min, then `SIGKILL` | `core/ai/cli-provider.ts` |
| Octokit | 60 s per HTTP attempt/page; a top-level call can run longer | `core/github-service.ts` |
| git `execFile` | 15 min watchdog, rejects independently after `SIGKILL` | `core/git-workspace.ts` |

## Failure semantics in runStage

- Any throw inside the `try` sets `error` without advancing, so `retry()` re-runs the same stage. Keep
  synchronous setup such as `selectAgent()` inside it.
- Inside the `try`: the entry `notify()`, the `notify()` after `task.active` is set, and the one in
  `runPrWithCodeEdits`. A throwing `'change'` listener there lands in the catch as `error`, not stuck
  `running`.
- Outside: only the exit `notifyAfterStage(task)`, which guards itself:
  1. A throw sets `error` and retries `notify()` once.
  2. Retry succeeds: `error` is durable at the stage reached, so after a completed stage `retry()` runs the
     next one and landed writes do not repeat (`merge` has no next: it re-runs).
  3. Retry throws: `recordPersistenceBroken()` sets `persistenceBroken` and emits `'persistence-broken'`;
     `processQueue()`, public mutators and polling all refuse.
  4. `core/app.ts` records it with `writePersistenceBrokenMarker()`, outside `MaoStore`. If that write also
     fails it is swallowed: only this process stays blocked.
  5. Next start: `hasPersistenceBrokenMarker()`, `requirePersistenceRecovery()` before `restore()`, and
     `safeToResume` refuses auto-resume; `mao run` exits 1.
- So the failure is "halted until the operator clears it", not duplicate writes. Durable `running` restores
  as `pending`, so reconcile GitHub first. Runbook: [store-and-recovery.md](store-and-recovery.md).
- `core/ai/cli-provider.ts` routes `child.stdin` `'error'` through `settle()`: a fast-exiting CLI or broken
  pipe is a normal task failure, not an unhandled `EPIPE` crash.

Proof: `core/workflow-engine.test.ts`, describe `runStage notify() guarding (regression for a throwing "change" listener)`:

- `lands the task in "error" instead of stuck "running" when the entry notify listener throws once transiently`
- `lands the task in "error" in the durable store (not a silently-lost advance) when the exit notify listener throws once transiently`
- `marks persistence as terminally broken — and stops processing further tasks — when notify() keeps throwing`
- `core/app.test.ts`: `refuses to auto-resume — even when the caller asks for resume: true — once the marker file is present`
- `core/ai/cli-provider.test.ts`: `rejects the promise cleanly with EPIPE when stdin write encounters a closed pipe`

## Retry is not side-effect safe

"Retryable" describes the state machine: `retry()` re-runs the whole stage, including the AI call.

- Notes-only `pr` tolerates a repeat: `createBranch` treats a 422 "already exists" as success, `commitFile`
  passes the existing `sha`, `createPullRequest` returns the existing open PR. Other failures throw.
- `createIssue` and `reviewPullRequest` are not idempotent; fixing them, with regression tests, is welcome.
- Merge runs before the summary comment, so a retry cannot duplicate it; a comment failure is non-fatal, so a
  merged PR does not fail the task or invite a re-merge.

## CI gate

Merge proceeds only on `getChecksStatus` `'success'` or `'none'` (no CI: nothing to wait for); `'pending'` and
`'failure'` throw, retryable. The check reads the then-current head and `mergePullRequest` pins no SHA: head
movement between them is a known race.

## Real-edit pr path and child processes

- Taken when `pr` runs on a `cli` provider with `workspaceRoot` set (both shells set it); no edits falls back
  to notes-only.
- `commitAndPush` runs `git add -A` + `push --force` on the workflow branch. Never point `workspaceRoot` at a
  checkout holding unrelated work.
- `allowToolUse` (`claude --dangerously-skip-permissions`, `codex -s workspace-write`) applies **only** here.
  Never extend it to API providers or other stages.
- Keep child processes shell-free: argument-array `execFile`/`spawn`, no shell interpolation of
  user-controlled values.
- A raw `Promise` around a child process keeps a `settled` guard and clears any timer when it settles: a late
  event then does nothing, and a live timer cannot hold a one-shot command open for its full bound. Exemplars:
  `core/ai/cli-provider.ts`, `run()` in `core/git-workspace.ts`.
- Token exposure: `ensureClone` embeds the token in the HTTPS remote, persisted in each clone's `.git/config`.
  Treat those files as secret-bearing; never paste them into issues, PRs or logs. `run()` in
  `core/git-workspace.ts` scrubs `err.message`, `.stderr`, `.stdout`, `.cmd`. Removing it from the URL is a
  welcome fix.

## The workflow-active label

- The **only** duplicate-enqueue protection: auto-trigger never reads the queue and enqueues **before**
  labeling.
- Two writers, both `.catch(() => {})`: the `issue` stage and `core/auto-trigger.ts`. A failed write re-enqueues
  the issue on every poll. Best-effort, not a guarantee.
- `workflow enqueue-existing` and `workflow:enqueueFromIssue` do not label, so a later poll can enqueue that
  issue again.

## Headless CLI usage

State: `$MAO_DATA_DIR/config.json` (default: platform data dir from `core/paths.ts`). Clones:
`$MAO_DATA_DIR/workspaces`. Set `MAO_DATA_DIR` to isolate test state. Prefix every line with
`npm run cli -- `.

```bash
config set-token <token>  # argv: never a real token from an agent terminal
config import-providers <file>  # JSON array of AiProviderConfig
config show  # secrets redacted as '[set]'
config clear-persistence-broken
repos add <owner> <repo> [--no-auto-trigger] [--poll-interval-ms <ms>]  # preflights write access
repos remove <owner> <repo>
repos list
github check <owner> <repo>  # open issues/PRs as JSON
github view <owner> <repo> <number>  # body + comments
workflow enqueue "<title>" --owner <o> --repo <r> [--no-auto-advance] [--provider <id>] \
  [--model <model>] [--effort <level>] [--worker <id>] [--reviewer <id>] [--maintainer <id>]
workflow enqueue-existing <issueNumber> --owner <o> --repo <r> [--no-auto-advance]
workflow list
workflow retry <taskId> [--provider <id>] [--model <model>] [--effort <level>]
workflow advance <taskId>  # same flags as retry
workflow clear-completed
workflow confirm-queue-recovery  # keep readable tasks, delete invalid ones, release the engine
run  # foreground: auto-trigger + resume queue
swarm --repo-root <path> --status
swarm --repo-root <path> --dry-run --once
```

- `workflow enqueue` without `--no-auto-advance` runs the **entire pipeline unattended** (real GitHub
  writes) in the foreground with no progress output; only `run` streams status. To step, use
  `--no-auto-advance` + `workflow advance`.
- `--no-auto-advance` still runs the entry stage at enqueue, then parks at the next one.
- One-shot `enqueue`, `retry` and `advance` also run every other `pending` task restored from the store.

## E2E harness

```bash
node --experimental-strip-types --env-file=.env.test scripts/test-workflow.ts
```

- Throwaway repo only: it creates real issues, branches and PRs and can merge them.
- `.env.test` is gitignored and yours to create. `README.md` says "Copy the env template", but no
  `.env.example` exists; the only template is its inline block.
- Required: `TEST_GITHUB_OWNER`, `TEST_GITHUB_REPO`, `TEST_GITHUB_TOKEN`, plus `TEST_AI_API_KEY` (optional
  `TEST_AI_API_FORMAT` `anthropic|openai`, `TEST_AI_MODEL`) or `TEST_AI_CLI_COMMAND` (optional
  `TEST_AI_CLI_ARGS`, space-split). Optional: `TEST_TASK_TITLE`, `TEST_WORKSPACE_ROOT`.
- Second provider: `TEST_AI2_*`, so maker-checker has somewhere to route.
- Trap: omit unused optional vars, not blank as in the README: `TEST_AI_CLI_ARGS=` becomes a `['']` argv and
  `TEST_AI_API_FORMAT=` selects the OpenAI request shape.
- Trap: it exits 0 even when the task ends in `error`. Judge by the printed final task JSON.

## When adding a pipeline stage

1. `core/ai/types.ts`: extend `AGENT_STAGES`; `AgentStage`, `WorkflowStageName`, `STAGE_ORDER` derive.
2. `core/agent-selection.ts`: `STAGE_ROLE` (tsc enforces). Stages sharing a role are exempt from maker-checker
   (`STAGE_ROLE[previous.stage] === STAGE_ROLE[stage]`), so an existing role lets one agent run both.
3. `core/workflow-engine.ts`: `buildPromptForStage`, `applyGithubAction` (no default case: tsc stays silent and
   a missed stage writes nothing), plus `runPrWithCodeEdits`-style special-casing if needed.
4. `STAGE_LABELS` in `src/components/KanbanBoard.tsx` and `src/components/WorkflowQueue.tsx`; `ALL_STAGES` (tsc
   does not check it) and `STAGE_LABELS` in `src/components/GlobalSettings.tsx`.
5. `core/workflow-engine.test.ts`: stage progression, maker-checker alternation, error/retry against the
   fakes, and the list pinned in describe `the engine stage order`.

## When adding an AI provider

- HTTP API shape: `core/ai/api-provider.ts`, `AI_API_FORMATS` in `core/ai/types.ts`, and the format picker in
  `src/components/GlobalSettings.tsx` (hardcoded; tsc does not check it).
- Local CLI: `SYSTEM_PROMPT_FLAG_BY_COMMAND` and `TOOL_USE_FLAGS_BY_COMMAND` in `core/ai/cli-provider.ts`. Keep
  the 15 min `SIGKILL` timeout; keep `allowToolUse` flags scoped to the `pr` path.
