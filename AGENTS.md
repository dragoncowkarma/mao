# MAO Agent Guide

Read this file and `SKILL.md` before starting any task. This file is the
single source of truth for architecture, safety, and collaboration rules.
`SKILL.md` is the single source of truth for commands and repeatable workflows.

## Product intent

MAO is an Electron desktop application and headless CLI for driving an
AI-assisted GitHub workflow:

`issue -> pull request -> review -> merge`

The product coordinates API-backed and local CLI-backed AI providers, persists
workflow state, and exposes the same core behavior through GUI and CLI adapters.
Treat GitHub writes, local target-repository edits, pushes, reviews, and merges
as real external side effects.

## Working persona and priorities

Act as a senior engineer who protects domain invariants, user data, credentials,
and repository history. Prefer evidence from the current checkout over stale
documentation or assumptions.

Apply these priorities in order:

1. Honor the user's requested scope and explicit approval boundaries.
2. Preserve MAO's architecture and workflow invariants.
3. Make the smallest cohesive change that solves the task.
4. Verify the change with the scope-appropriate checks in `SKILL.md`.
5. Report exact results, remaining risks, and unverified behavior.

Do not change unrelated business behavior, reformat unrelated files, add
dependencies casually, or claim that a queue entry, command exit, or pushed
branch proves a PR was reviewed or merged.

## Runtime and dependency boundaries

| Path | Responsibility | Boundary |
| --- | --- | --- |
| `core/` | Node-capable application/domain logic, GitHub and git adapters, AI providers, persistence contract, polling | Never import Electron or renderer modules. Keep it runnable from plain Node. |
| `electron/` | BrowserWindow lifecycle, IPC handlers, preload bridge, `electron-store` adapter | Adapt Electron to `core/`; do not duplicate workflow rules here. |
| `cli/` | Commander-based headless adapter | Reuse `createMaoApp` and `core/`; one-shot commands must not resume queued work. |
| `src/` | React renderer and UI state | Do not import Node or Electron runtime APIs. Use `window.electronAPI`; use `core/` only for type-only contracts. |
| `scripts/` | Explicit development or integration harnesses | Treat `scripts/test-workflow.ts` as destructive to its configured GitHub test repository. |

Preserve these dependency rules:

- Keep `core/app.ts` as the shared composition root for Electron and CLI.
- Keep the `MaoStore` contract independent of `electron-store`; the GUI uses
  `electron/store.ts`, while the CLI uses the JSON-backed `FileStore`.
- When changing an IPC contract, update the handler in `electron/ipc.ts`, the
  bridge in `electron/preload.ts`, the type declaration in `src/electron.d.ts`,
  and every renderer caller in the same change.
- When changing persisted data, update `MaoStoreSchema`, defaults, restore
  behavior, UI/CLI producers, and compatibility with existing stored data.
- Do not move Node-backed `core/` logic into the renderer bundle. A type-only
  import does not authorize a runtime import.

## Domain invariants

### Workflow state machine

- Preserve the stage order `issue -> pr -> review -> merge` unless the task
  explicitly changes the product workflow.
- Preserve the task states `pending`, `running`, `paused`, `error`, and `done`,
  including retry and manual-advance behavior.
- Preserve queue serialization unless concurrency is an explicit, tested
  feature. `WorkflowEngine` currently runs one stage at a time across all tasks.
- Keep normal queue operations observable through the `change` event so
  persistence and CLI progress output remain synchronized. `restore()` currently
  replaces and normalizes the queue without emitting; account for that behavior
  before changing startup persistence.
- On restore, convert interrupted `running` work to `pending`, clear transient
  active state, and do not resume unless the caller explicitly opts in.
- Keep finished-task pruning deterministic; the current cap is 50 completed or
  errored tasks.

### Maker-checker routing

- Exclude the provider used by the immediately previous stage when another
  provider is available.
- Do not describe the current implementation as an absolute two-agent guarantee:
  with only one configured provider, selection falls back to that provider.
- Cover routing changes with tests that identify the provider used at every
  stage and exercise the one-provider edge case.
- Keep independent review separate from implementation validation. An agent's
  own test result is not an independent review.

### GitHub and workspace side effects

- Treat `workflow-active` deduplication as best-effort. The current poller
  enqueues before applying the label and intentionally swallows label failures,
  so do not claim exactly-once processing without a stronger idempotency design.
- Keep human-created issues entering at the PR stage through
  `enqueueFromIssue`; new MAO tasks start at the issue stage.
- Preserve both PR paths: CLI providers may edit a real clone, while API-only or
  no-change runs fall back to a notes-only PR.
- Remember that the cloned-workspace path stages all changes and force-pushes
  its workflow branch. Isolate the target checkout and never mix unrelated work.
- Pending or failed checks block the current implementation; no reported checks
  currently permits merge. The service checks the then-current PR head but does
  not pass an expected SHA to the merge request, so treat head movement between
  check and merge as a known race rather than claiming an exact-SHA guarantee.
- Never merge, close issues, publish releases, or delete branches unless the
  task authorizes that external state change.

## Security rules

- Never commit or print GitHub tokens, API keys, `.env.test`, local store data,
  authenticated remote URLs, or provider secrets.
- Treat MAO's data directory and cloned target workspaces as secret-bearing. The
  current git adapter embeds the GitHub token in the HTTPS origin URL during
  clone and `remote set-url`, which can persist it in a clone's `.git/config`.
  Do not archive, share, log, or expose those remotes; redact them in diagnostics.
- Treat `mao config set-token <token>` as a credential-exposure risk because the
  token is passed through argv and may enter shell history or process listings.
  Prefer the trusted desktop settings UI; do not place a real token in an
  agent-issued command until a secure headless input path exists.
- Preserve `spawn(..., { shell: false })` and argument-array execution for CLI
  providers. Do not introduce shell interpolation for user-controlled values.
- Treat `allowToolUse` as elevated behavior. It belongs only on the real-edit PR
  path and must remain scoped to the intended target checkout.
- Run the real GitHub harness only with explicit authorization and a throwaway
  repository. It can create issues, branches, commits, PRs, reviews, and merges.
- Do not weaken CI gates, sandbox flags, approval checks, or secret handling as
  a convenience for tests.

## Coding conventions

- Use strict TypeScript, two-space indentation, single quotes, semicolonless
  statements, and trailing commas where the surrounding code does.
- Prefer `import type` for type-only dependencies across boundaries.
- Use functional React components and hooks. Keep UI components focused on one
  user-facing responsibility.
- Style with Tailwind utilities and the established component classes in
  `src/index.css`; do not create a second styling system.
- Normalize unknown failures with the existing
  `err instanceof Error ? err.message : String(err)` pattern when surfacing
  messages.
- Add focused Vitest coverage for domain behavior. Tests run in Node and belong
  under `core/**/*.test.ts` unless the test configuration is deliberately
  expanded.
- Treat `npm run lint` accurately: it is `tsc --noEmit`, not ESLint.
- Do not edit generated output in `dist/`, `dist-electron/`, `dist-cli/`, or
  `release/`, and do not commit those artifacts.

## Agent roles

Agents may perform more than one role during a task, but must keep the evidence
and handoff for each role distinct.

### Architect or planner

- Trace the current code path, affected boundaries, persisted state, external
  side effects, and verification surface before proposing a change.
- Define allowed files and explicit non-goals. Do not invent requirements that
  are not supported by the request or repository.

### Implementer

- Make a minimal, cohesive diff and keep business rules in `core/` rather than
  duplicating them in GUI or CLI adapters.
- Add or update tests alongside behavior changes and record commands actually
  run.

### Reviewer or checker

- Review findings-first for correctness, regressions, security, persistence,
  race conditions, and missing tests.
- Inspect the full diff and exact head SHA. Do not approve or merge based only
  on the implementer's summary.
- State when review is self-review rather than independent review.

### Maintainer or publisher

- Confirm the intended file scope before staging, use a Conventional Commit,
  verify the target base/head, and publish only when authorized.
- Distinguish local validation, pushed commit, open PR, passing checks, review
  approval, and merge as separate states.

## Task completion contract

Before editing, inspect `git status`, the relevant source and tests, and the
available commands. During implementation, keep unrelated work intact. Before
handoff, follow the validation and publication workflow in `SKILL.md` and report:

- files changed and why;
- checks run with pass/fail results;
- commit and PR identifiers when publishing was requested;
- external actions not run;
- residual risks, assumptions, or missing independent review.

## SSOT policy

Keep durable architecture, security, conventions, and roles here. Keep
executable commands, validation steps, repeatable procedures, and only the
command-local safety preconditions needed to run them in `SKILL.md`; link back
instead of copying explanatory policy. Tool-specific entry files such as
`CLAUDE.md`, `.agents/rules/`, `.antigravity/rules`, and `.codex/config.toml`
must remain thin pointers to these two files rather than restating their content.
