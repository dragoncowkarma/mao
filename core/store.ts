import fs from 'node:fs'
import path from 'node:path'
import {
  AGENT_STAGES,
  AI_API_FORMATS,
  AI_EFFORTS,
  AI_PROVIDER_KINDS,
  PROVIDER_KIND_IDS,
  type AiProviderConfig,
} from './ai/types.ts'
import { isRepoRef } from './repo-registry.ts'
import { WORKFLOW_ACTIVE_LABEL, WORKFLOW_TASK_STATUSES } from './workflow-engine.ts'
import type { QueuedTask, RepoRef } from './workflow-engine.ts'

/**
 * UI color scheme preference. 'system' follows the OS-level `prefers-color-scheme` media query and
 * is the default — it's the only option that doesn't require the user to make a choice up front.
 */
export type ThemePreference = 'light' | 'dark' | 'system'

export interface MaoStoreSchema {
  githubToken: string
  githubRepos: RepoRef[]
  aiProviders: AiProviderConfig[]
  workflowTasks: QueuedTask[]
  /**
   * Git commit SHA for the Electron build currently running. Electron writes this on boot from the
   * build-time constant when available so the update checker can compare the app's own repository
   * `main` branch against the binary the user is actually running.
   */
  buildSha: string
  theme: ThemePreference
}

export const MAO_STORE_DEFAULTS: MaoStoreSchema = {
  githubToken: '',
  githubRepos: [],
  aiProviders: [],
  workflowTasks: [],
  buildSha: '',
  theme: 'system',
}

type UnknownRecord = Record<string, unknown>
type RestorableQueuedTask = Omit<QueuedTask, 'autoAdvance'> & { autoAdvance?: boolean }

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value)
}

function hasOptional(
  record: UnknownRecord,
  key: string,
  predicate: (value: unknown) => boolean,
): boolean {
  return record[key] === undefined || predicate(record[key])
}

/** Like `Array.prototype.every`, but treats a sparse-array hole as an `undefined` entry. */
function everyArrayEntry(value: unknown[], predicate: (entry: unknown) => boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!predicate(value[index])) return false
  }
  return true
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && everyArrayEntry(value, (entry) => typeof entry === 'string')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAiEffort(value: unknown): boolean {
  return isOneOf(value, AI_EFFORTS)
}

function isModelEffortPreset(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.model === 'string' &&
    hasOptional(value, 'effort', isAiEffort)
  )
}

/**
 * Runtime counterpart of `AiProviderConfig` at the untyped JSON boundary.
 *
 * This is intentionally shape validation, not settings policy: empty strings and a CLI provider with
 * no command are still structurally representable and the existing settings validation gives those
 * operator-facing errors. The store boundary's narrower job is to guarantee that every reader may
 * safely access the declared fields and nested lists without crashing.
 */
export function isAiProviderConfig(value: unknown): value is AiProviderConfig {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    isOneOf(value.kind, AI_PROVIDER_KINDS) &&
    hasOptional(value, 'apiFormat', (entry) => isOneOf(entry, AI_API_FORMATS)) &&
    hasOptional(value, 'apiKey', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'baseUrl', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'model', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'command', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'providerKindId', (entry) => isOneOf(entry, PROVIDER_KIND_IDS)) &&
    hasOptional(value, 'args', isStringArray) &&
    hasOptional(value, 'effort', isAiEffort) &&
    hasOptional(
      value,
      'allowedStages',
      (entry) => Array.isArray(entry) && everyArrayEntry(entry, (stage) => isOneOf(stage, AGENT_STAGES)),
    ) &&
    hasOptional(
      value,
      'presets',
      (entry) => Array.isArray(entry) && everyArrayEntry(entry, isModelEffortPreset),
    ) &&
    hasOptional(value, 'selectedPresetId', (entry) => typeof entry === 'string')
  )
}

function isWorkflowStep(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    isOneOf(value.stage, AGENT_STAGES) &&
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string' &&
    hasOptional(value, 'providerKindId', (entry) => isOneOf(entry, PROVIDER_KIND_IDS)) &&
    hasOptional(value, 'model', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'effort', isAiEffort) &&
    typeof value.prompt === 'string' &&
    typeof value.output === 'string'
  )
}

function isRoleAssignment(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    hasOptional(value, 'worker', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'reviewer', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'maintainer', (entry) => typeof entry === 'string')
  )
}

function isProviderOverride(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    hasOptional(value, 'providerId', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'model', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'effort', isAiEffort) &&
    hasOptional(value, 'roles', isRoleAssignment)
  )
}

function isRunOverride(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    hasOptional(value, 'providerId', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'model', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'effort', isAiEffort)
  )
}

function isActiveWorkflowStep(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    typeof value.agentId === 'string' &&
    typeof value.agentName === 'string' &&
    hasOptional(value, 'providerKindId', (entry) => isOneOf(entry, PROVIDER_KIND_IDS)) &&
    hasOptional(value, 'model', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'effort', isAiEffort) &&
    typeof value.prompt === 'string'
  )
}

function isGithubTaskState(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    hasOptional(value, 'issueNumber', isFiniteNumber) &&
    hasOptional(value, 'issueUrl', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'prNumber', isFiniteNumber) &&
    hasOptional(value, 'prUrl', (entry) => typeof entry === 'string') &&
    hasOptional(value, 'branch', (entry) => typeof entry === 'string')
  )
}

/**
 * Whether an untyped JSON value is a task every restore, engine and renderer path can safely consume.
 * `autoAdvance` alone may be absent: old queues predate that field, and `restore()` deliberately
 * migrates the omission to `true`. Every other required member has no safe default and is therefore a
 * shape failure rather than a guessed migration.
 */
function hasQueuedTaskShape(value: unknown, allowMissingAutoAdvance: boolean): value is RestorableQueuedTask {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    isRepoRef(value.repo) &&
    isOneOf(value.stage, AGENT_STAGES) &&
    Array.isArray(value.history) &&
    everyArrayEntry(value.history, isWorkflowStep) &&
    isOneOf(value.status, WORKFLOW_TASK_STATUSES) &&
    hasOptional(value, 'error', (entry) => typeof entry === 'string') &&
    (typeof value.autoAdvance === 'boolean' || (allowMissingAutoAdvance && value.autoAdvance === undefined)) &&
    hasOptional(value, 'providerOverride', isProviderOverride) &&
    hasOptional(value, 'nextRunOverride', isRunOverride) &&
    hasOptional(value, 'active', isActiveWorkflowStep) &&
    isGithubTaskState(value.github)
  )
}

/** Strict current-schema predicate used before persisting a queue. */
export function isQueuedTask(value: unknown): value is QueuedTask {
  return hasQueuedTaskShape(value, false)
}

/** Read-side predicate that accepts the one durable legacy shape `restore()` knows how to migrate. */
function isRestorableQueuedTask(value: unknown): value is RestorableQueuedTask {
  return hasQueuedTaskShape(value, true)
}

function normalizeRestorableTask(task: RestorableQueuedTask): QueuedTask {
  return {
    ...task,
    // A queued task needs repository identity, not mutable registration settings. Older stores may
    // carry those settings because enqueue once snapshotted a complete RepoRef; drop them while reading
    // so a later queue write cannot preserve policy the workflow neither reads nor owns.
    repo: { owner: task.repo.owner, repo: task.repo.repo },
    autoAdvance: task.autoAdvance ?? true,
  }
}

/**
 * How a value reads in an operator-facing message, so a report says what is actually in the file
 * rather than only what was expected. `typeof` alone prints `object` for both `null` and `{…}`, which
 * are the two likeliest hand-edits, so those are separated out.
 */
function describeStoredType(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'absent'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

/**
 * The actionable report for a stored `githubRepos` that is not a list — or `null` when it is one and
 * there is nothing to report.
 *
 * Names the field, what the file actually holds, and the file itself, because none of those were
 * recoverable from what the operator used to get (`store.get(...).filter is not a function`). It also
 * states the recovery explicitly: the unusable value stays on disk, so the next list write is what
 * replaces it, and anything the operator wants to salvage has to be copied out first.
 *
 * The recovery it names first registers nothing, and that ordering is load-bearing. Any list write heals
 * the file, but only a write that registers nothing new is exempt from the write-permission preflight
 * (see `reposNeedingCapabilityCheck`) — and because an unusable value names no tracked repository, every
 * repository in an `add` counts as new. So with no token configured, or access since revoked, `mao repos
 * add` fails in the preflight and leaves the unusable value exactly where it was, while `mao repos
 * remove` heals regardless. Recommending the blockable path first would send an operator whose token is
 * the reason they were editing `config.json` straight back into the wall.
 *
 * It names the GUI's **Reset stored list**, not its Remove, for a reason that is easy to get wrong: an
 * unusable list leaves the sidebar with no row, so no project is selected, so the Settings tab and the
 * Remove button inside it never render. Naming an action the operator cannot reach is worse than naming
 * none. Reset is the sidebar control this report itself is shown next to, and it writes an empty list.
 */
export function describeUnusableRepoList(value: unknown, source: string): string | null {
  if (Array.isArray(value)) return null
  return (
    `[store] "githubRepos" in ${source} is ${describeStoredType(value)}, not a JSON array of ` +
    '{ owner, repo } entries — ignoring it, so no repositories are tracked until it is replaced. The ' +
    'unusable value is still in the file; any repository-list write overwrites it. `mao repos remove ' +
    "<owner> <repo>`, or the sidebar's Reset stored list, always works — neither registers anything, so " +
    'neither is checked for write access. `mao repos add` and the sidebar\'s Add are, so they need a ' +
    `working GitHub token. Copy any repositories you still need out of ${source} first.`
  )
}

function countInvalidEntries(value: unknown[], predicate: (entry: unknown) => boolean): number {
  let invalid = 0
  for (let index = 0; index < value.length; index += 1) {
    if (!predicate(value[index])) invalid += 1
  }
  return invalid
}

function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * The actionable report for a stored `aiProviders` that is not a list or contains unusable entries —
 * or `null` when every entry is safe to hand to callers.
 *
 * Worded as an ignored-configuration report, deliberately unlike the queue's below: an empty provider
 * list costs nothing but the ability to route a stage, and every stage then fails at `selectAgent()`
 * with the pre-existing retryable "No AI providers registered" *before* any GitHub write. So this field
 * is reported and coerced, and it does **not** halt automation — latching for it would be a larger
 * outage than the fault it describes.
 *
 * The recovery it names needs no GitHub token, which is the point: a missing or revoked token is one of
 * the likelier reasons an operator was editing `config.json` by hand in the first place, and `mao config
 * import-providers` and the GUI's Global settings pane are both reachable without one.
 */
export function describeUnusableProviderList(value: unknown, source: string): string | null {
  if (Array.isArray(value)) {
    const invalid = countInvalidEntries(value, isAiProviderConfig)
    if (invalid === 0) return null
    const valid = value.length - invalid
    const routingConsequence =
      valid === 0
        ? 'No valid provider remains, so workflow stages cannot be routed. '
        : valid === 1
          ? 'Only one valid provider remains, so maker-checker cannot select a distinct reviewer and the supported single-provider fallback may reuse that provider for review. '
          : ''
    return (
      `[store] "aiProviders" in ${source} contains ${countPhrase(invalid, 'invalid entry', 'invalid entries')} out of ` +
      `${value.length} — ignoring ${invalid === 1 ? 'it' : 'them'} in memory and keeping ` +
      `${countPhrase(valid, 'valid provider')}. No stored value, token or API key is shown in this ` +
      `report. ${routingConsequence}The invalid entries are still in the file. The GUI's Global settings pane ` +
      'refuses to save its filtered view while this problem remains, because doing so would delete ' +
      'those entries and any apiKey values they contain. Repair the file or use `mao config ' +
      'import-providers <file>` to replace the complete list — ' +
      `copy anything you still need out of ${source} first.`
    )
  }
  return (
    `[store] "aiProviders" in ${source} is ${describeStoredType(value)}, not a JSON array of AI ` +
    'provider configs — ignoring it, so no AI providers are registered and every workflow stage fails ' +
    'for want of an agent to route to. The unusable value is still in the file. The GUI\'s Global ' +
    'settings pane refuses to overwrite an unreadable provider list; repair the file or use `mao ' +
    'config import-providers <file>` to replace it. Neither route needs a GitHub token. Copy any ' +
    'provider configs you still need out of ' +
    `${source} first, including their apiKey values, which exist nowhere else.`
  )
}

/**
 * The actionable report for a stored `workflowTasks` that is not a list or contains unusable entries —
 * or `null` when every entry is safe to restore.
 *
 * This one is not just a report: it is the text the queue-recovery latch carries verbatim (see
 * `findStoredQueueProblem()` and `WorkflowEngine.requireQueueRecovery()`), so the stderr line, every
 * refused mutation's error, `mao run`'s refusal and the GUI's card all say the same thing. That is why
 * it describes a *halt* rather than only a discard.
 *
 * Halting is the correction review of PR #69 forced, and the reasoning is worth keeping next to the
 * words. Coercing the queue to `[]` looked safe because resuming an empty queue is a no-op — but both
 * long-lived hosts call `startAutoTrigger()` immediately after `createMaoApp()`, and that ticks at once
 * rather than after its first interval. The first poll's `enqueueFromIssue()` would `notify()`, the
 * `'change'` listener would `store.set('workflowTasks', …)`, and that single write both destroys the
 * only salvageable copy of the unreadable value **and** starts an unattended pipeline on a host that
 * cannot know what was already in flight. The `workflow-active` label is best-effort, so a task lost
 * with the queue may carry no label to stop its issue being picked up and run a second time.
 *
 * It names `mao workflow confirm-queue-recovery` rather than `mao workflow clear-completed`, and that is
 * load-bearing: `clear-completed` also emits `'change'`, so it is *gated* too. Leaving it open would let
 * a GUI "Clear completed" click replace the unreadable value with no confirmation at all — exactly the
 * destruction this latch exists to prevent.
 */
export function describeUnusableTaskQueue(value: unknown, source: string): string | null {
  if (Array.isArray(value)) {
    const invalid = countInvalidEntries(value, isRestorableQueuedTask)
    if (invalid === 0) return null
    const valid = value.length - invalid
    return (
      `[store] "workflowTasks" in ${source} contains ${countPhrase(invalid, 'invalid queued task')} ` +
      `out of ${value.length} — ignoring ${invalid === 1 ? 'it' : 'them'} in memory, preserving ` +
      `${countPhrase(valid, 'readable task')}, and halting unattended work: auto-resume, auto-trigger ` +
      'polling and every queue write are refused until this is resolved. No stored task, prompt, token ' +
      'or API key is shown in this report. A discarded durable task may represent GitHub work MAO can ' +
      'no longer account for, so running another task could duplicate an issue, branch or PR. The invalid ' +
      `entries are still in ${source}. Copy anything you need out first, then check the target repos for ` +
      `issues still labelled "${WORKFLOW_ACTIVE_LABEL}" and half-finished branches or PRs. ` +
      '`mao workflow confirm-queue-recovery` (or the sidebar\'s Recover readable tasks) writes back ' +
      'the readable tasks only and releases the engine. A retained running task is restored as pending, ' +
      'and later queue activity in an already-running host may execute retained tasks.'
    )
  }
  return (
    `[store] "workflowTasks" in ${source} is ${describeStoredType(value)}, not a JSON array of queued ` +
    'workflow tasks — ignoring it, so the queue is empty and MAO will not start unattended work: ' +
    'auto-resume, auto-trigger polling and every queue write are refused until this is resolved. That ' +
    'is deliberate — the record of what was already in flight is unreadable, so enqueueing anything ' +
    'would overwrite the only salvageable copy of it and risk re-running GitHub work that already ' +
    'happened. The unusable value is still in the file. Copy anything you still need out of ' +
    `${source} first, then check the target repo for an issue still labelled "${WORKFLOW_ACTIVE_LABEL}" ` +
    'whose branch or PR is half-finished and finish or clean it up by hand. `mao workflow ' +
    'confirm-queue-recovery` (or the sidebar\'s Recover readable tasks) then discards the unreadable ' +
    'value and releases the engine.'
  )
}

type StoredShapeRule<K extends keyof MaoStoreSchema> = (raw: MaoStoreSchema[K], source: string) => string | null

/**
 * The registry of fields whose stored *shape* is validated and the report for each, so the guard and
 * `describeStoredProblems()` cannot disagree about which fields are covered. Element filtering and
 * strict prospective-write predicates remain field-specific below because read migration and current
 * write shape intentionally differ for `workflowTasks`.
 *
 * A table rather than a predicate over every schema key, because `describeStoredProblems()` iterates it
 * to decide what to *read*: electron-store re-reads and re-parses the whole config file on every `get`,
 * so walking all six fields to have five of them answer `null` cost six full file reads per call, on the
 * main process, in the `finally` of every repository-list write. It is **three** fields now, not one, so
 * each `problems()` call is three of those reads — which is why the queue latch is derived once at boot
 * (`core/app.ts`) and never re-probed from the `'change'` path: routing it through there would have put
 * three whole-config reads and three `JSON.parse`s on every queue change, and `config.json` carries up
 * to `MAX_FINISHED_TASKS` finished tasks with their full prompts and AI output.
 */
const STORED_SHAPE_RULES: { [K in keyof MaoStoreSchema]?: StoredShapeRule<K> } = {
  githubRepos: (raw, source) => describeUnusableRepoList(raw, source),
  aiProviders: (raw, source) => describeUnusableProviderList(raw, source),
  workflowTasks: (raw, source) => describeUnusableTaskQueue(raw, source),
}

function unusableStoredValue<K extends keyof MaoStoreSchema>(
  key: K,
  raw: MaoStoreSchema[K],
  source: string,
): string | null {
  const rule = STORED_SHAPE_RULES[key] as StoredShapeRule<K> | undefined
  return rule ? rule(raw, source) : null
}

/**
 * The safe in-memory view of a value for which `unusableStoredValue()` returned a problem.
 *
 * A wrong container has no readable entries, so it still becomes the cloned schema default. For the
 * two issue #75 lists, however, a mixed array is not all-or-nothing: keep each entry whose complete
 * declared shape is safe and leave the invalid entries only on disk until an explicit list write.
 */
function usableStoredValue<K extends keyof MaoStoreSchema>(
  key: K,
  raw: MaoStoreSchema[K],
  problem: string | null,
): MaoStoreSchema[K] {
  if (key === 'aiProviders' && Array.isArray(raw)) {
    return Array.from(raw as unknown[]).filter(isAiProviderConfig) as MaoStoreSchema[K]
  }
  if (key === 'workflowTasks' && Array.isArray(raw)) {
    return Array.from(raw as unknown[])
      .filter(isRestorableQueuedTask)
      .map(normalizeRestorableTask) as MaoStoreSchema[K]
  }
  return problem === null ? raw : structuredClone(MAO_STORE_DEFAULTS[key])
}

/**
 * A value a caller tried to persist but which would violate the schema after a JSON round trip.
 *
 * Read recovery filters because the bad bytes already exist and callers need a way back. Writes have
 * no such excuse: rejecting the whole attempted list before `backend.set` preserves the last durable
 * value and stops `mao config import-providers [null]` from corrupting the file before its success log
 * touches `p.id`. The message reports only field, destination and count — never an entry or index.
 */
function describeInvalidStoredWrite<K extends keyof MaoStoreSchema>(
  key: K,
  value: MaoStoreSchema[K],
  source: string,
): string | null {
  const predicate =
    key === 'aiProviders' ? isAiProviderConfig : key === 'workflowTasks' ? isQueuedTask : undefined
  if (predicate === undefined) return null
  if (!Array.isArray(value)) {
    return (
      `[store] Refusing to write "${key}" in ${source}: expected a JSON array, received ` +
      `${describeStoredType(value)}. Nothing was written.`
    )
  }
  const invalid = countInvalidEntries(value, predicate)
  if (invalid === 0) return null
  return (
    `[store] Refusing to write "${key}" in ${source}: ` +
    `${countPhrase(invalid, 'invalid entry', 'invalid entries')} out of ` +
    `${value.length}. No entry, prompt, token or API key is shown. Nothing was written.`
  )
}

function assertStoredWrite<K extends keyof MaoStoreSchema>(
  key: K,
  value: MaoStoreSchema[K],
  source: string,
): void {
  const problem = describeInvalidStoredWrite(key, value, source)
  if (problem !== null) throw new Error(problem)
}

/** A stored value the schema cannot use, in the form a shell can show an operator. */
export interface StoredValueProblem {
  /** The `MaoStoreSchema` field whose stored value was replaced or filtered for safe in-memory use. */
  field: keyof MaoStoreSchema
  /** The config file the unusable value is still sitting in. */
  source: string
  /** The operator-facing report: the field, the value's actual type, the file, and the way back. */
  message: string
}

/**
 * Which of the values a backend holds **right now** the schema cannot use.
 *
 * Evaluated on demand rather than accumulated as reads happen, and that is the whole point. The guard
 * only learns about a field when something reads it, so a recorded-as-you-go list would answer "no
 * problems" until the right read had happened — and the renderer polls this *independently* of
 * `github:getRepos`, so the order of two IPC calls would decide whether the operator was told. Asking
 * the backend directly makes the answer true whenever it is asked. It is also live for Electron, whose
 * electron-store backend re-reads the file on every `get`.
 *
 * Read-only, like the guard: nothing here repairs the file. Only the fields `STORED_SHAPE_RULES` has a
 * rule for are read at all — see there for why reading the rest would not be free.
 */
export function describeStoredProblems(
  readRaw: <K extends keyof MaoStoreSchema>(key: K) => MaoStoreSchema[K],
  source: string,
): StoredValueProblem[] {
  const problems: StoredValueProblem[] = []
  for (const field of Object.keys(STORED_SHAPE_RULES) as Array<keyof MaoStoreSchema>) {
    const message = unusableStoredValue(field, readRaw(field), source)
    if (message !== null) problems.push({ field, source, message })
  }
  return problems
}

/**
 * The one field whose unusable value halts unattended automation, and the single lookup for it.
 *
 * Exported so `core/app.ts`'s boot-time latch, `WorkflowEngine.confirmQueueRecovery()`'s postcondition
 * and both shells' reporting cannot disagree about what counts as "the queue is unreadable". The other
 * two guarded fields are reported and coerced but never halt anything — see
 * `describeUnusableProviderList()` for why an unusable `aiProviders` must not.
 */
export const QUEUE_GATING_FIELD = 'workflowTasks' as const

/** The unusable-queue problem among a backend's problems, or `undefined` when the queue reads normally. */
export function findStoredQueueProblem(problems: StoredValueProblem[]): StoredValueProblem | undefined {
  return problems.find((problem) => problem.field === QUEUE_GATING_FIELD)
}

/**
 * The report for a backend that could not be read at all, rather than one holding the wrong shape.
 *
 * Value-free by construction: an I/O or parse failure is free to quote the file's own bytes, and
 * `config.json` holds `githubToken` in plaintext — so nothing from the underlying error is interpolated,
 * only the field and the file. It is phrased as a halt because that is what it causes: a state MAO
 * cannot establish is treated as unusable, never as healthy.
 */
export function describeUninspectableStore(field: keyof MaoStoreSchema, source: string): string {
  return (
    `[store] MAO could not read "${field}" from ${source} at all, so it cannot establish whether the ` +
    'value is usable — treating it as unusable. Check the file and the permissions on it, then retry.'
  )
}

/**
 * An opaque proof of *which* raw value an observation saw, for `MaoStore.setIfUnchanged()`.
 *
 * A serialization rather than a hash, because hashing buys nothing here and `JSON.stringify` already
 * tells us what we need. It is computed inside a `try`, so a value the serializer cannot handle (circular,
 * a `BigInt`, nesting deep enough to blow the stack) yields `undefined` instead of adding a throw site to
 * the read path — and `undefined` makes every conditional write refuse rather than guess.
 *
 * **Never log or render it.** It is stored content verbatim, and `config.json` holds `githubToken` in
 * plaintext.
 */
function witnessOf(raw: unknown): string | undefined {
  try {
    // `undefined` has no JSON form, so distinguish "absent" from a failure rather than conflating them.
    return raw === undefined ? '\u0000absent' : JSON.stringify(raw)
  } catch {
    return undefined
  }
}

/** What a conditional write did. See `MaoStore.setIfUnchanged()`. */
export type ConditionalWriteResult = 'written' | 'superseded' | 'unverifiable' | 'invalid'

/**
 * One read of a stored value, carrying both what a caller may use and what the guard had to do.
 *
 * Exists because `get()` and `problems()` are two separate reads, and electron-store re-reads and
 * re-parses the config file on **every** `get`. `createMaoApp` decided the queue latch from one of those
 * reads and then restored from the other, so a hand-edit landing between them left the host *unlatched*
 * holding a corrected queue that no longer represented every durable entry — auto-trigger then started
 * immediately and overwrote the original, which is the exact failure the latch exists to prevent. One
 * observation removes the window: the latch and `restore()` cannot disagree because there is no second
 * read to disagree with.
 */
export interface StoredObservation<K extends keyof MaoStoreSchema> {
  /** The value corrected to the shape the schema declares — defaulted or element-filtered for use. */
  value: MaoStoreSchema[K]
  /** The operator-facing report when the guard had to replace or filter the value, else `undefined`. */
  problem: string | undefined
  /**
   * False when the backend read itself failed, so nothing about the stored value was established.
   * `value` is then the schema default and `problem` is `describeUninspectableStore()`'s report.
   * Callers that are about to **write** must treat this as "unknown" and refuse, not as "corrupt".
   */
  readable: boolean
  /**
   * Proof of which raw value this observation saw, to be handed back to `setIfUnchanged()` so a write
   * can refuse if the stored value has moved since. `undefined` when the value could not be serialized,
   * which makes the conditional write refuse. Never render it — see `witnessOf`.
   */
  witness: string | undefined
}

/** A backend's read, corrected to the shape `MaoStoreSchema` declares. See `createStoredReadGuard`. */
export type StoredReadGuard = <K extends keyof MaoStoreSchema>(key: K, raw: MaoStoreSchema[K]) => MaoStoreSchema[K]

/**
 * Closes the gap between what `MaoStoreSchema` declares and what a `config.json` can actually hold.
 *
 * `MaoStore.get()` is typed `MaoStoreSchema[K]`, but both shipped backends read unvalidated JSON and
 * fill in only the keys that are *missing* — `FileStore` by spreading the parsed file over
 * `MAO_STORE_DEFAULTS`, electron-store by its own `defaults` option. A key that is present but the
 * wrong shape therefore survives and is handed to every reader under a type promising otherwise. For
 * `githubRepos` that one fact broke every repository path at once (issue #60): `.filter` threw for
 * `mao repos remove` and `github:getRepos`, `canonicalRepoList` threw on a non-iterable `previous` for
 * `mao repos add` and for auto-trigger's per-tick canonicalisation, and `mao repos list` printed the
 * malformed value as though it were the list. Because nothing could write the list either, there was no
 * way back from inside the app — the operator had to hand-edit JSON.
 *
 * Coercing to the empty list rather than throwing is what makes that recovery possible: `updateRepos`
 * reads the stored list before it writes, so a read that throws takes `repos add` / `repos remove` down
 * with it, while a read that answers `[]` lets the very next list write replace the unusable value. The
 * read is deliberately not a repair — nothing here writes — so a command that only reads leaves the
 * file exactly as it found it, and the operator keeps the chance to salvage it by hand.
 *
 * Reported at most once per field per guard, because the cadence of reads is not the cadence of the
 * problem: auto-trigger re-reads the list on every 5s tick and `mao run` runs for days. Once per
 * process is enough to be non-silent without burying the rest of the output. Written through
 * `console.warn` — i.e. stderr — so `mao repos list` and `mao config show` stay parseable on stdout.
 * `source` is the config file path, which is not itself a secret (the token lives *inside* that file);
 * no stored value is ever printed.
 *
 * Every `MaoStore` backend applies this on read — `FileStore` below, `electron/store.ts` for the GUI —
 * so the two shells cannot answer differently for the same corrupt file. A new backend must call it
 * too: that is the point of the rule living here rather than at the read sites, which are scattered
 * across `core/`, `cli/` and `electron/` and would each have to remember it.
 *
 * All three array-typed fields are guarded, and the question `workflowTasks` raised is answered rather
 * than deferred: a queue MAO cannot fully read halts unattended automation (see
 * `describeUnusableTaskQueue()` and `WorkflowEngine.requireQueueRecovery()`), because carrying on with
 * a corrected subset lets the immediate first auto-trigger poll overwrite the unusable durable entries
 * and start a pipeline. `aiProviders` is filtered and reported but deliberately halts nothing. Adding a
 * field here means answering the same question for it: what does the fallback value cost, which write
 * heals it, and does losing data let unattended work start against state MAO can no longer account for?
 *
 * What this guard does **not** cover, so the halt is not read as more than it is: most fields in a
 * `config.json` that is not valid JSON at all still read as their schema defaults because
 * `FileStore.load()` swallows the parse error (issue #67; the fresh queue observation itself fails
 * closed). `githubRepos` entry validity remains `isRepoRef`/`canonicalRepoList`'s policy (#72).
 * `aiProviders` and `workflowTasks`, by contrast, validate each complete declared entry here (#75):
 * valid entries survive in order, invalid entries stay on disk until an explicit same-field write, and
 * any invalid durable task raises the queue-recovery latch before a host can resume.
 */
export function createStoredReadGuard(
  source: string,
  warn: (message: string) => void = (message) => console.warn(message),
): StoredReadGuard {
  const reported = new Set<keyof MaoStoreSchema>()

  return function guardStoredRead<K extends keyof MaoStoreSchema>(key: K, raw: MaoStoreSchema[K]): MaoStoreSchema[K] {
    const problem = unusableStoredValue(key, raw, source)
    const usable = usableStoredValue(key, raw, problem)
    if (problem === null) return usable
    if (!reported.has(key)) {
      reported.add(key)
      warn(problem)
    }
    // A mixed provider/task list keeps its valid entries. A wrong container still gets the schema's
    // own default, *cloned*: returning the shared instance would let one caller poison every later read.
    return usable
  }
}

/**
 * A confirmed WorkflowEngine queue-persistence failure (see WorkflowEngine.isPersistenceBroken())
 * is deliberately NOT a MaoStoreSchema field — both shipped MaoStore backends (FileStore below, and
 * Electron's electron-store wrapper) persist their entire schema as one JSON blob and rewrite the
 * whole file on every set() call, so a flag written through `store` would just retry the exact
 * full-file write that already failed for `workflowTasks`. See core/persistence-guard.ts for the
 * independent marker-file mechanism createMaoApp uses instead.
 */

/**
 * Minimal persistence contract the core app needs. The Electron GUI backs this with electron-store
 * (see electron/store.ts); the headless CLI backs it with FileStore below. Core code never imports
 * either implementation directly, so it stays runnable outside of Electron.
 */
export interface MaoStore {
  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K]
  /** Returns a value-free rejection reason for an invalid prospective write, else `undefined`. */
  validateWrite<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): string | undefined
  /** Rejects an invalid provider/task list before the backend can mutate either memory or disk. */
  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void
  /**
   * The stored values this backend cannot use, evaluated against what it holds now (see
   * `describeStoredProblems()`).
   *
   * Part of the contract rather than a backend detail, because `get()` alone cannot tell a caller that
   * it answered with a default instead of what is on disk — it returns the same `[]` either way. Both
   * shells need to say so: `mao config show` reports it, and the GUI has no other way to learn at all,
   * since the guard's own report goes to a main-process console a packaged-app operator never sees.
   */
  problems(): StoredValueProblem[]
  /**
   * One read answering both the usable value and whether the stored one had to be replaced.
   *
   * Part of the contract rather than a convenience: `get()` and `problems()` are two reads of a file
   * another process can change between them (see `StoredObservation`). Any decision that pairs "is this
   * value usable?" with "what do I do with it?" must come from a single `inspect()`.
   */
  inspect<K extends keyof MaoStoreSchema>(key: K): StoredObservation<K>
  /**
   * Writes only if the stored raw value is still the one `witness` came from.
   *
   * The reason a plain `set` is not enough for recovery: the queue-recovery write replaces an unusable
   * value with a validated task subset, so if another process repaired the queue between the observation
   * and the write, an unconditional `set` destroys that repair and reports success. Observing "immediately
   * before" writing does not close that — only refusing the write does.
   *
   * `'superseded'` means the raw value moved and **nothing was written**. `'unverifiable'` means the
   * current value could not be read or serialized, so whether it moved is unknown — also nothing written.
   * `'invalid'` means the replacement failed prospective shape validation before any backend read or
   * write. Throws only if the underlying write throws.
   *
   * **What `'written'` actually establishes, stated narrowly because an earlier revision of this comment
   * promised more.** The compare and the write are one synchronous run of JavaScript with no `await`
   * between them, so no other code *in this process* can interleave: against another caller here, the
   * pair is atomic and `'written'` means "nothing had moved". Against another OS process it is not. The
   * comparison narrows the window — from the whole confirm sequence down to the compare →
   * `writeFileSync` interval — but a repair landing inside that interval is still overwritten and still
   * reported `'written'`. Closing that needs a primitive neither backend has: an advisory lock both
   * writers take, or `O_EXCL` + rename keyed on a stored version with a retry loop. Cross-process
   * serialization of same-key writes is issue #73 and is deliberately **not** attempted here; do not
   * describe this member as closing it.
   */
  setIfUnchanged<K extends keyof MaoStoreSchema>(
    key: K,
    witness: string | undefined,
    value: MaoStoreSchema[K],
  ): ConditionalWriteResult
}

/**
 * The raw key/value surface a backend offers before anything validates it.
 *
 * `get` may answer `undefined`: electron-store merges its `defaults` into the file only when it first
 * writes it, and reads the file's *current* contents afterwards, so a key an operator deletes by hand
 * comes back missing. `createGuardedStore()` substitutes the schema default for exactly that case.
 */
export interface StoredValueBackend {
  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] | undefined
  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void
  /**
   * A read that is guaranteed to reflect what is on disk *now*, for `inspect()` and the conditional
   * write — both of which exist to notice another process's change.
   *
   * Optional, and the fallback to `get` is correct rather than a guess: conf re-reads and re-parses the
   * whole config file on every `get`, so for `electron/store.ts` the two are the same call. `FileStore`
   * answers `get` from the snapshot taken in its constructor, so it *must* supply this — without it, a
   * CLI recovery would compare against a value that may be minutes stale. May throw when the file exists
   * but cannot be read; callers turn that into "unknown", never into "healthy".
   */
  getFresh?<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] | undefined
}

/**
 * The one composition of a raw backend into a `MaoStore`: absent keys filled from the schema, reads
 * defaulted or element-filtered as required, writes validated, and `problems()` answered from the
 * **raw** values.
 *
 * Both shipped backends are this function — `FileStore` below over its in-memory snapshot,
 * `electron/store.ts` over electron-store — so "the two shells cannot answer differently for the same
 * corrupt file" is true by construction rather than by two files being kept in step by hand. It also
 * puts the whole of the Electron backend's behaviour somewhere a `core` test can reach it: that backend
 * cannot be imported from `core/` (architecture rule 1) and electron-store needs a live Electron app, so
 * before this the only coverage it could have was a regex over its source — which a mutation feeding
 * `problems()` the *guarded* value instead of the raw one passed while making the GUI permanently blind.
 *
 * That distinction is the subtle part and the reason `readRaw` is not the guard: the guard has already
 * replaced or filtered an unusable value, so asking it what is wrong always answers "nothing".
 */
export function createGuardedStore(
  backend: StoredValueBackend,
  source: string,
  warn?: (message: string) => void,
): MaoStore {
  const guardRead = createStoredReadGuard(source, warn)

  /**
   * The freshest read the backend can give, for the two members that exist to notice another process's
   * change. Falls back to `get` only where that is already a disk read — see `StoredValueBackend.getFresh`.
   */
  function readRawFresh<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    const read = backend.getFresh?.bind(backend) ?? backend.get.bind(backend)
    const value = read(key)
    return value === undefined ? structuredClone(MAO_STORE_DEFAULTS[key]) : value
  }

  function readRaw<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    const value = backend.get(key)
    // Cloned, never the shared `MAO_STORE_DEFAULTS` instance — one caller pushing into what it read
    // would otherwise poison the default for the rest of the process.
    return value === undefined ? structuredClone(MAO_STORE_DEFAULTS[key]) : value
  }

  return {
    get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
      return guardRead(key, readRaw(key))
    },
    validateWrite<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): string | undefined {
      return describeInvalidStoredWrite(key, value, source) ?? undefined
    },
    set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
      assertStoredWrite(key, value, source)
      backend.set(key, value)
    },
    problems(): StoredValueProblem[] {
      return describeStoredProblems(readRaw, source)
    },
    inspect<K extends keyof MaoStoreSchema>(key: K): StoredObservation<K> {
      let raw: MaoStoreSchema[K]
      try {
        // The FRESH read deliberately, not `get`'s: an observation exists to be acted on, and on
        // `FileStore` a snapshot read would compare a recovery against a value taken at construction.
        raw = readRawFresh(key)
      } catch {
        // Fail closed, and say nothing about the value: a read that threw established nothing, so a
        // caller about to write must refuse rather than assume the stored value is the corrupt one it
        // last saw. `readable: false` is what carries that distinction.
        return {
          value: structuredClone(MAO_STORE_DEFAULTS[key]),
          problem: describeUninspectableStore(key, source),
          readable: false,
          witness: undefined,
        }
      }
      // Guarded through the same `guardRead` as `get()`, deliberately — including its once-per-field
      // warning — so an observation and a plain read cannot disagree about the value or about whether
      // the operator was told. `unusableStoredValue` is read from the SAME `raw`, not from a second read.
      return {
        value: guardRead(key, raw),
        problem: unusableStoredValue(key, raw, source) ?? undefined,
        readable: true,
        witness: witnessOf(raw),
      }
    },
    setIfUnchanged<K extends keyof MaoStoreSchema>(
      key: K,
      witness: string | undefined,
      value: MaoStoreSchema[K],
    ): ConditionalWriteResult {
      if (describeInvalidStoredWrite(key, value, source) !== null) return 'invalid'
      if (witness === undefined) return 'unverifiable'
      let current: string | undefined
      try {
        current = witnessOf(readRawFresh(key))
      } catch {
        return 'unverifiable'
      }
      if (current === undefined) return 'unverifiable'
      if (current !== witness) return 'superseded'
      // Nothing may be inserted between the compare above and the write below — not an `await`, not a
      // callback, not a second read. That adjacency is the entire guarantee: it makes the pair atomic
      // with respect to other callers in this process. It does NOT make it atomic against another OS
      // process, which can still repair the value in this interval and have it overwritten (#73).
      //
      // No read-back afterwards either: comparing two post-write reads cannot tell "written" from
      // "written then immediately superseded", so it would assert more than it establishes. The write
      // either throws or it does not, and the caller is told which.
      backend.set(key, value)
      return 'written'
    },
  }
}

/** JSON-file-backed MaoStore for CLI/headless environments that don't have electron-store available. */
export class FileStore implements MaoStore {
  private data: MaoStoreSchema
  private filePath: string
  /**
   * The same composition Electron's backend is (see `createGuardedStore`), over this instance's own
   * snapshot rather than reimplemented beside it. Held per instance because "already reported" is per
   * store, and the CLI builds a fresh `FileStore` for every invocation, so each command that touches an
   * unusable list says so exactly once.
   */
  private guarded: MaoStore

  constructor(filePath: string) {
    this.filePath = filePath
    // Cloned, not spread onto. A shallow spread copies each default's *reference*, so for any key the
    // file does not set, `get()` handed out the module-level `MAO_STORE_DEFAULTS` value itself — one
    // caller pushing into the list it read leaked a phantom entry into the default, and the next
    // `FileStore` built in that process then read it back as a tracked repository for auto-trigger to
    // poll. The read guard owes callers a value that is theirs; this is the other half of that.
    this.data = { ...structuredClone(MAO_STORE_DEFAULTS), ...this.load() }
    this.guarded = createGuardedStore(
      {
        get: <K extends keyof MaoStoreSchema>(key: K) => this.data[key],
        set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
          this.data[key] = value
          this.persist()
        },
        // Re-read from disk, because `get` above answers from the constructor snapshot and the two
        // members that use this exist to notice another process's change. Deliberately NOT written back
        // into `this.data`: mutating the snapshot mid-process would make `get()` answer differently
        // depending on whether a recovery happened to have run.
        getFresh: <K extends keyof MaoStoreSchema>(key: K) =>
          ({ ...structuredClone(MAO_STORE_DEFAULTS), ...this.loadStrict() })[key],
      },
      filePath,
    )
  }

  private load(): Partial<MaoStoreSchema> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  /**
   * `load()`, but a file that exists and cannot be read **throws** instead of reading as `{}`.
   *
   * Only for `getFresh`. The constructor keeps the swallowing `load()` on purpose: answering schema
   * defaults for an unparseable file is the pre-existing behaviour (and the known blind spot tracked as
   * issue #67), and changing it here would quietly change what every boot does. What a *conditional
   * write* needs is the opposite — an unreadable file must become "unknown", never "unchanged".
   */
  private loadStrict(): Partial<MaoStoreSchema> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    } catch (err) {
      // A missing file is the normal first run, and reads as "nothing stored" rather than a failure.
      if ((err as { code?: string }).code === 'ENOENT') return {}
      throw err
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
  }

  get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    return this.guarded.get(key)
  }

  validateWrite<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): string | undefined {
    return this.guarded.validateWrite(key, value)
  }

  set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
    this.guarded.set(key, value)
  }

  problems(): StoredValueProblem[] {
    return this.guarded.problems()
  }

  inspect<K extends keyof MaoStoreSchema>(key: K): StoredObservation<K> {
    return this.guarded.inspect(key)
  }

  setIfUnchanged<K extends keyof MaoStoreSchema>(
    key: K,
    witness: string | undefined,
    value: MaoStoreSchema[K],
  ): ConditionalWriteResult {
    return this.guarded.setIfUnchanged(key, witness, value)
  }
}
