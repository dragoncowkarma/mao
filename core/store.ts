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
 * The distinct *types* of the entries a predicate rejected, in the order they were first met.
 *
 * Types, never values, and this is the field whose entries most invite the opposite: a half-written
 * `{"owner":"acme"}` is the likeliest hand-edit and naming it would genuinely help. But `config.json`
 * holds `githubToken` in plaintext, a malformed entry is exactly the edit that can leave a fragment of
 * a neighbouring key inside it, and this text travels into piped CLI output, agent logs, an IPC payload
 * and a window an operator may be screen-sharing. The *count* is the fact that cannot be recovered
 * anywhere else — the sidebar and `github:getRepos` show only the survivors, so nothing else says
 * whether one entry or twelve are about to be overwritten.
 */
function describeInvalidEntryTypes(value: unknown[], usableEntry: (entry: unknown) => boolean): string {
  const types: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (usableEntry(value[index])) continue
    const type = describeStoredType(value[index])
    if (!types.includes(type)) types.push(type)
  }
  return types.join(', ')
}

/**
 * The actionable report for a stored `githubRepos` the schema cannot fully use — a value that is not a
 * list, or a list holding entries that cannot name a repository — or `null` when every entry is usable.
 *
 * Names the field, what the file actually holds, and the file itself, because none of those were
 * recoverable from what the operator used to get (`store.get(...).filter is not a function`). It also
 * states the recovery explicitly: the unusable value stays on disk, so the next list write is what
 * replaces it, and anything the operator wants to salvage has to be copied out first.
 *
 * **Entry-level reports say something different, and the difference is the point of issue #72.** PR #57
 * made individual entries *safe* — `canonicalRepoList()` and `github:getRepos` drop whatever `isRepoRef`
 * rejects — and that drop was completely silent. A `config.json` holding `[null]`, a half-written
 * `[{"owner":"acme"}]` or a bare `["acme/widgets"]` reached the renderer as `[]` and read as *"No
 * projects yet"*, character-for-character what a genuinely empty list shows; a mixed list showed its
 * survivors and said nothing about the rest; and the next list write erased them from the file for good.
 * So an array is reported too, and in two voices, because the safe recovery is not the same one:
 *
 * - **Nothing usable** — the sidebar has no row, so the whole-list recovery is lossless and is named
 *   here exactly as it is for a wrong container.
 * - **Some usable** — the sidebar has rows, Remove is reachable, and a whole-list reset would delete
 *   repositories the operator can see working. So this one names neither it nor any write: it says the
 *   entries are still on disk and that the next repository-list write is what destroys them.
 *
 * The recovery it names first registers nothing, and that ordering is load-bearing. Any list write heals
 * the file, but only a write that registers nothing new is exempt from the write-permission preflight
 * (see `reposNeedingCapabilityCheck`) — and because an unusable value names no tracked repository, every
 * repository in an `add` counts as new. So with no token configured, or access since revoked, `mao repos
 * add` fails in the preflight and leaves the unusable value exactly where it was, while `mao repos
 * remove` heals regardless. Recommending the blockable path first would send an operator whose token is
 * the reason they were editing `config.json` straight back into the wall.
 *
 * Where it names the GUI's **Reset stored list**, it names that and not Remove, for a reason that is
 * easy to get wrong: a list with nothing usable in it leaves the sidebar with no row, so no project is
 * selected, so the Settings tab and the Remove button inside it never render. Naming an action the
 * operator cannot reach is worse than naming none. Reset is the sidebar control this report is shown
 * next to, and it writes an empty list — which is exactly why the mixed report must not name it, and why
 * the sidebar withholds it there (`StoredValueProblem.nothingUsable`).
 */
export function describeUnusableRepoList(value: unknown, source: string): string | null {
  const defect = storedValueDefect(value, isRepoRef)
  return defect === null ? null : reportUnusableRepoList(value, source, defect)
}

/**
 * The report for a `githubRepos` already classified as defective.
 *
 * Total — it never answers "nothing to report" — and that is the point of the split. A describer that
 * decided *whether* there was a problem on its own was a second classification of the same fact, and
 * `storedValueProblem()` had to reconcile the two; the only answer available there was to treat a
 * disagreement as silence, which for `workflowTasks` would have lowered the queue-recovery latch. One
 * classifier, three total reports, nothing to reconcile.
 */
function reportUnusableRepoList(value: unknown, source: string, defect: StoredValueDefect): string {
  if (defect === 'value') {
    return (
      `[store] "githubRepos" in ${source} is ${describeStoredType(value)}, not a JSON array of ` +
      '{ owner, repo } entries — ignoring it, so no repositories are tracked until it is replaced. The ' +
      'unusable value is still in the file; any repository-list write overwrites it. `mao repos remove ' +
      "<owner> <repo>`, or the sidebar's Reset stored list, always works — neither registers anything, so " +
      'neither is checked for write access. `mao repos add` and the sidebar\'s Add are, so they need a ' +
      `working GitHub token. Copy any repositories you still need out of ${source} first.`
    )
  }
  const entries = value as unknown[]
  const invalid = countInvalidEntries(entries, isRepoRef)
  // One count sentence for both cases, so neither can end up vaguer than the other, and phrased so it
  // reads correctly for a single entry as well ("1 entry of 1 does not name a repository").
  const counted =
    `[store] "githubRepos" in ${source} is a JSON array in which ` +
    `${countPhrase(invalid, 'entry', 'entries')} of ${entries.length} ` +
    `${invalid === 1 ? 'does' : 'do'} not name a repository ` +
    `({ owner, repo }, both non-empty): ${describeInvalidEntryTypes(entries, isRepoRef)}. ` +
    'No stored value is shown in this report. '
  if (defect === 'every-entry') {
    return (
      counted +
      `Ignoring ${invalid === 1 ? 'it' : 'them'}, so no repositories are tracked until the list is ` +
      'replaced. The unusable entries are still in the file; any repository-list write drops them. ' +
      "`mao repos remove <owner> <repo>`, or the sidebar's Reset stored list, always works — neither " +
      'registers anything, so neither is checked for write access. `mao repos add` and the sidebar\'s ' +
      `Add are, so they need a working GitHub token. Copy any repositories you still need out of ${source} ` +
      'first.'
    )
  }
  return (
    counted +
    `Ignoring ${invalid === 1 ? 'it' : 'them'} and tracking the ` +
    `${countPhrase(entries.length - invalid, 'readable repository', 'readable repositories')} normally. ` +
    `${invalid === 1 ? 'That entry is' : 'Those entries are'} still in ${source}, and the next ` +
    "repository-list write — adding or removing a repository, or editing one's settings — drops " +
    `${invalid === 1 ? 'it' : 'them'} for good, so copy out anything you need first. Replacing the whole ` +
    'list is deliberately not offered here: it would delete the repositories that still work.'
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
  const defect = storedValueDefect(value, isAiProviderConfig)
  return defect === null ? null : reportUnusableProviderList(value, source, defect)
}

/** The report for an `aiProviders` already classified as defective. See `reportUnusableRepoList`. */
function reportUnusableProviderList(value: unknown, source: string, defect: StoredValueDefect): string {
  if (defect !== 'value') {
    const entries = value as unknown[]
    const invalid = countInvalidEntries(entries, isAiProviderConfig)
    const valid = entries.length - invalid
    const invalidCount = countPhrase(invalid, 'invalid entry', 'invalid entries')
    const invalidSubject = invalid === 1 ? 'The invalid entry is' : 'The invalid entries are'
    const routingConsequence =
      valid === 0
        ? 'No valid provider remains, so workflow stages cannot be routed. '
        : valid === 1
          ? 'Only one valid provider remains, so maker-checker cannot select a distinct reviewer ' +
            'and the supported single-provider fallback may reuse that provider for review. '
          : ''
    return (
      `[store] "aiProviders" in ${source} contains ${invalidCount} out of ` +
      `${entries.length} — ignoring ${invalid === 1 ? 'it' : 'them'} in memory and keeping ` +
      `${countPhrase(valid, 'valid provider')}. No stored value, token or API key is shown in this ` +
      `report. ${routingConsequence}${invalidSubject} still in the file. The GUI's Global ` +
      'settings pane refuses to save its filtered view while this problem remains, because doing so ' +
      'would delete the invalid stored data and any apiKey values it contains. Repair the file or use ' +
      '`mao config ' +
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
  const defect = storedValueDefect(value, isRestorableQueuedTask)
  return defect === null ? null : reportUnusableTaskQueue(value, source, defect)
}

/** The report for a `workflowTasks` already classified as defective. See `reportUnusableRepoList`. */
function reportUnusableTaskQueue(value: unknown, source: string, defect: StoredValueDefect): string {
  if (defect !== 'value') {
    const entries = value as unknown[]
    const invalid = countInvalidEntries(entries, isRestorableQueuedTask)
    const valid = entries.length - invalid
    const invalidSubject = invalid === 1 ? 'The invalid entry is' : 'The invalid entries are'
    return (
      `[store] "workflowTasks" in ${source} contains ${countPhrase(invalid, 'invalid queued task')} ` +
      `out of ${entries.length} — ignoring ${invalid === 1 ? 'it' : 'them'} in memory, preserving ` +
      `${countPhrase(valid, 'readable task')}, and halting unattended work: auto-resume, auto-trigger ` +
      'polling and every queue write are refused until this is resolved. No stored task, prompt, token ' +
      'or API key is shown in this report. A discarded durable task may represent GitHub work MAO can ' +
      'no longer account for, so running another task could duplicate an issue, branch or PR. ' +
      `${invalidSubject} still in ${source}. Copy anything you need out first, then check the target repos ` +
      'for ' +
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

/**
 * Which part of a stored value the schema cannot use.
 *
 * Three states rather than a message-or-nothing, because both the correction and the safe recovery
 * differ between them and getting either wrong is destructive in its own direction. A value whose own
 * *type* is wrong holds no entries, so it becomes the schema default and replacing it loses nothing. An
 * array whose entries are not all usable keeps the usable ones — substituting the default there would
 * hide the repositories the operator can see working, and offering to replace the whole value would
 * delete them.
 */
export type StoredValueDefect =
  /** Not the array the schema declares — an object, a string, `null`. */
  | 'value'
  /** An array, and no entry in it is usable. */
  | 'every-entry'
  /** An array in which some entries are usable and others are not. */
  | 'some-entries'

/**
 * Everything field-specific about a guarded field, in one place per field.
 *
 * `usableEntry` classifies, `report` words the result and `readEntries` corrects it — one classification
 * feeding all three, so "the guard substituted a value it said nothing about" is not a reachable state
 * rather than a tested-against one.
 */
interface StoredShapeRule<K extends keyof MaoStoreSchema> {
  /** Whether one entry of the stored array is safe to hand to every reader of this field. */
  usableEntry: (entry: unknown) => boolean
  /**
   * The operator-facing report for a value `usableEntry` has already classified as defective.
   *
   * Total, and it takes the defect rather than deciding one: a report that classified independently was
   * a second answer to the same question, and the reconciliation had nowhere safe to go — treating a
   * disagreement as silence would have lowered the `workflowTasks` latch (`MaoStore.inspect()` feeds it),
   * while throwing would have put a crash on the read path the guard exists to keep crash-free.
   */
  report: (raw: MaoStoreSchema[K], source: string, defect: StoredValueDefect) => string
  /**
   * The in-memory view of a stored *array* for this field, applied whether or not it has a defect.
   *
   * Not conditional on the defect, which is the trap: `workflowTasks` normalizes as well as filters
   * (`normalizeRestorableTask` strips registry settings an older build snapshotted into `repo` and
   * migrates a missing `autoAdvance`), and a queue whose entries are all structurally valid has no
   * defect — so keying this on one would quietly stop normalizing exactly the healthy queues.
   */
  readEntries: (raw: unknown[]) => MaoStoreSchema[K]
}

/**
 * The registry of fields whose stored *shape* is validated, so the guard, `describeStoredProblems()`
 * and the in-memory correction cannot disagree about which fields are covered or about what is wrong
 * with one. The strict prospective-**write** predicates stay separate (`describeInvalidStoredWrite`) and
 * deliberately cover two of these three fields: read migration and current write shape differ for
 * `workflowTasks`, and rejecting a `githubRepos` entry on write would make the store an older build
 * produced unrecoverable through the only API that can replace it.
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
  githubRepos: {
    // Identity only — `owner` and `repo`, exactly what `canonicalRepoList` drops an entry for. The
    // report and the drop have to use one predicate or the message describes a different set of entries
    // than the next write removes, and a report for something no write clears would never go away. The
    // cost is that this row deliberately checks less than its siblings: a junk `autoTrigger` or
    // `pollIntervalMs` on an otherwise valid entry is counted among the "readable repositories", and
    // `core/auto-trigger.ts` reads those two without validating them either. That settings half is a
    // separate fault with a separate owner and is not reported here.
    usableEntry: isRepoRef,
    report: (raw, source, defect) => reportUnusableRepoList(raw, source, defect),
    // Copied, but not filtered — the deliberate difference from the two fields below, and a `githubRepos`
    // array therefore reaches every reader exactly as stored however damaged it is. Dropping an entry
    // that cannot name a repository stays `isRepoRef`/`canonicalRepoList`'s single responsibility, and
    // `mao repos list` is the one listing that still shows what is about to be dropped — the sidebar and
    // `github:getRepos` show only the survivors, so filtering here would take the operator's salvage copy
    // away. (Filtering would be *safe*: `canonicalRepoList` builds its result from entries it accepts and
    // `github:getRepos` filters for the renderer on its own behalf. It simply would not help, and it would
    // cost the one thing the report tells the operator to go and read.) Substituting the schema default,
    // the other tempting correction, would hide the repositories that still work.
    //
    // `Array.from` rather than the stored array itself: `FileStore`'s backend answers `get` with its own
    // snapshot object, so handing it out would let a caller that pushes into what it read mutate the
    // store's in-memory list — and `persist()` writes that list wholesale on the next `set` of any key.
    // That is the bug the cloned schema default exists to prevent, one level down.
    readEntries: (raw) => Array.from(raw) as RepoRef[],
  },
  aiProviders: {
    usableEntry: isAiProviderConfig,
    report: (raw, source, defect) => reportUnusableProviderList(raw, source, defect),
    readEntries: (raw) => Array.from(raw).filter(isAiProviderConfig),
  },
  workflowTasks: {
    usableEntry: isRestorableQueuedTask,
    report: (raw, source, defect) => reportUnusableTaskQueue(raw, source, defect),
    readEntries: (raw) => Array.from(raw).filter(isRestorableQueuedTask).map(normalizeRestorableTask),
  },
}

function storedShapeRule<K extends keyof MaoStoreSchema>(key: K): StoredShapeRule<K> | undefined {
  return STORED_SHAPE_RULES[key] as StoredShapeRule<K> | undefined
}

/**
 * Which defect a raw stored value has, by the field's own entry predicate — or `null` when every entry
 * is usable.
 *
 * An empty array is not a defect: it is what the schema default *is*. A non-empty array in which every
 * entry is unusable is `'every-entry'` rather than `'value'`, because the two have different recoveries
 * (see `StoredValueDefect`) even though both leave nothing to keep.
 */
function storedValueDefect(
  raw: unknown,
  usableEntry: (entry: unknown) => boolean,
): StoredValueDefect | null {
  if (!Array.isArray(raw)) return 'value'
  const invalid = countInvalidEntries(raw, usableEntry)
  if (invalid === 0) return null
  return invalid === raw.length ? 'every-entry' : 'some-entries'
}

/**
 * The safe in-memory view of a raw stored value.
 *
 * A value whose own type is wrong has no readable entries, so it becomes the schema default — *cloned*,
 * because returning the shared `MAO_STORE_DEFAULTS` instance would let one caller that pushes into what
 * it read poison every later read in the process. An array goes through the field's own `readEntries`:
 * the two issue #75 lists keep each entry whose complete declared shape is safe and leave the invalid
 * entries only on disk until an explicit list write, while a `githubRepos` array is handed through as
 * stored — copied, never aliased (see the table above for why that is not an inconsistency but the
 * point).
 */
function usableStoredValue<K extends keyof MaoStoreSchema>(key: K, raw: MaoStoreSchema[K]): MaoStoreSchema[K] {
  const rule = storedShapeRule(key)
  if (rule === undefined) return raw
  if (!Array.isArray(raw)) return structuredClone(MAO_STORE_DEFAULTS[key])
  return rule.readEntries(raw as unknown[])
}

/**
 * A store diagnostic whose operator-facing text was built entirely from structured, value-free inputs.
 *
 * The class stays private so another module cannot bless an arbitrary backend error as safe. The
 * original message is kept in a private slot too: `Error.message` is mutable, so checking the nominal
 * type and then returning that public property would let a caller replace a safe report with a token
 * after construction.
 */
class OperatorSafeStoreError extends Error {
  readonly #safeMessage: string

  protected constructor(message: string) {
    super(message)
    this.#safeMessage = message
  }

  static messageOf(error: unknown): string | undefined {
    return error instanceof OperatorSafeStoreError ? error.#safeMessage : undefined
  }
}

/** Returns only diagnostics this module constructed without stored values or backend error text. */
export function operatorSafeStoreMessage(error: unknown): string | undefined {
  return OperatorSafeStoreError.messageOf(error)
}

/** Internal wrapper for the value-free reports produced by the write guards below. */
class StoredWriteGuardError extends OperatorSafeStoreError {
  readonly restartRequired: boolean

  constructor(message: string, { restartRequired = false }: { restartRequired?: boolean } = {}) {
    super(message)
    this.name = 'StoredWriteGuardError'
    this.restartRequired = restartRequired
  }
}

/** True only for this module's value-free refusal caused by a whole-file read failure. */
export function storeWriteRequiresRestart(error: unknown): boolean {
  return error instanceof StoredWriteGuardError && error.restartRequired
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
  if (problem !== null) throw new StoredWriteGuardError(problem)
}

/** A stored value the schema cannot use, in the form a shell can show an operator. */
export interface StoredValueProblem {
  /** The `MaoStoreSchema` field whose stored value was replaced or filtered for safe in-memory use. */
  field: keyof MaoStoreSchema
  /** The config file the unusable value is still sitting in. */
  source: string
  /** The operator-facing report: the field, the value's actual type, the file, and the way back. */
  message: string
  /**
   * Which part of the stored value the schema cannot use (see `StoredValueDefect`). Decides what the
   * guard substituted, and therefore what a healing write actually did — see
   * `describeHealedStoredValue()`.
   *
   * **Absent for a `wholeFile` problem**, where no value was ever observed: the file did not load, so
   * every raw value is a schema default and no shape was established. Naming one anyway would claim
   * something this did not see — and if it claimed `'value'` for `githubRepos`, it would arm a
   * destructive control over a file nothing can currently read.
   */
  defect?: StoredValueDefect
  /**
   * Whether replacing the whole stored value would lose nothing a caller could have used.
   *
   * Required, unlike `defect`, because it is a *permission* rather than an observation and every state
   * can answer it — a file that did not load answers `false`, since nothing established that its
   * contents are expendable. That is also the fail-closed direction, which is the whole point of
   * computing it here: it gates a destructive control (the sidebar's "Reset stored list", which writes
   * an empty list), and the direction a stale derivation fails in is *offering* it.
   *
   * A renderer could legally write `defect !== 'some-entries'`: it is a comparison against a literal,
   * no value import, so nothing in `src/` or in the renderer-isolation test would stop it (and
   * AGENTS.md rule 6 only stops it importing the *function* that decides). That is exactly why the
   * answer is computed here. Add a state and a renderer that has never heard of it still withholds the
   * reset, instead of offering a one-click deletion of every repository the operator can see working.
   */
  nothingUsable: boolean
  /**
   * True when the whole file could not be loaded, so `field` names the carrier rather than the fault.
   *
   * The two states need different operator text and different affordances, and nothing else distinguishes
   * them: a wrong-shaped *field* in a file that loaded leaves every other value readable and is healed by
   * the next write of that field, while a file that did not load establishes nothing and **refuses** every
   * write. `src/components/Sidebar.tsx` branches on this — it used to promise that "its next queue write
   * will rewrite the file from that" and offer a Save button, which for an unloadable file is a sentence
   * that is false and a button that can only answer `'restart-required'`. Keyed on a flag rather than on the
   * message text, which no UI should parse.
   */
  wholeFile?: true
}

/**
 * The complete report for one field's raw stored value, or `null` when the schema can use all of it.
 *
 * The single answer to "is there a problem here" in this module: the guard warns from it, `problems()`
 * lists it, and `inspect()` — whose answer raises the queue-recovery latch in `core/app.ts` — carries its
 * message. One classification by construction, so there is no disagreement to resolve and therefore no
 * way for an internal inconsistency to read as a healthy queue.
 */
function storedValueProblem<K extends keyof MaoStoreSchema>(
  field: K,
  raw: MaoStoreSchema[K],
  source: string,
): StoredValueProblem | null {
  const rule = storedShapeRule(field)
  if (rule === undefined) return null
  const defect = storedValueDefect(raw, rule.usableEntry)
  if (defect === null) return null
  const message = rule.report(raw, source, defect)
  return { field, source, message, defect, nothingUsable: defect !== 'some-entries' }
}

/**
 * What a write that healed a reported field actually did, for the one shell that can say so afterwards.
 *
 * `mao repos remove`'s postscript exists because the command that always heals otherwise prints only
 * `No tracked repo matches …` and reads like a no-op. It said "Replaced the unusable value" for every
 * kind of problem — true for a wrong container, and false for an array whose usable entries the write
 * *kept*: an operator told their value had been replaced would reasonably believe their tracked
 * repositories were gone. The count belongs to the report that preceded this, not here.
 */
export function describeHealedStoredValue(problem: StoredValueProblem): string {
  if (problem.defect === 'some-entries') {
    return `Dropped the unusable "${problem.field}" entries from ${problem.source}, keeping the readable ones.`
  }
  if (problem.defect === 'every-entry') {
    return `Dropped the unusable "${problem.field}" entries from ${problem.source}.`
  }
  // `'value'`, or a `wholeFile` problem that named no shape at all. Both report a replacement of the
  // whole value rather than guess: there were no entries to keep either way, and the one caller is
  // scoped to `githubRepos` while a `wholeFile` problem is carried on the queue field.
  return `Replaced the unusable "${problem.field}" value in ${problem.source}.`
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
    const problem = storedValueProblem(field, readRaw(field), source)
    if (problem !== null) problems.push(problem)
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

/** Fixed, value-free guidance after this process observes a whole-file read failure. */
export const STORE_RESTART_REQUIRED =
  '[store] The stored settings file could not be read. This process cannot safely write its startup ' +
  'snapshot over a repair. Repair the file if needed, then restart MAO; no stored value is shown.'

/** The unusable-queue problem among a backend's problems, or `undefined` when the queue reads normally. */
export function findStoredQueueProblem(problems: StoredValueProblem[]): StoredValueProblem | undefined {
  return problems.find((problem) => problem.field === QUEUE_GATING_FIELD)
}

/**
 * Why a `config.json` that is *present* could not be turned into stored values at all.
 *
 * A **missing** file is deliberately not one of these: that is a fresh install, the one case where
 * answering schema defaults is exactly right, and the one case a write may safely proceed from.
 *
 * This is a whole-file fact, one layer below `STORED_SHAPE_RULES`. Those rules describe a field that is
 * present but the wrong shape inside a file that loaded; these describe a file from which no field —
 * `githubToken` included — was ever established.
 */
export type StoreReadFailure = 'unreadable' | 'unparseable' | 'not-an-object'

/** The clause naming what is actually wrong with the file, for the reports below. */
function storeReadCause(failure: StoreReadFailure | undefined): string {
  if (failure === 'unparseable') return 'It is not valid JSON.'
  if (failure === 'not-an-object') return 'It is valid JSON, but not a JSON object.'
  if (failure === 'unreadable') return 'The filesystem refused to open it.'
  return ''
}

/**
 * What to actually do about it, which differs by kind — and that is the point of carrying the kind at
 * all. "Check the file and the permissions on it" is useless advice for a trailing comma, and it was the
 * only advice this module gave before the kind was threaded through.
 *
 * Falls back to the original wording when the kind is unknown, so a caller that has no error to classify
 * (see `core/app.ts`'s `observeStoredQueue`) still reports something true.
 */
function storeReadRemedy(failure: StoreReadFailure | undefined): string {
  if (failure === 'unparseable' || failure === 'not-an-object') {
    return 'Repair the JSON by hand, or move the file aside to start from an empty config, then retry.'
  }
  if (failure === 'unreadable') return 'Check the permissions and owner on the file, then retry.'
  return 'Check the file and the permissions on it, then retry.'
}

/**
 * A load that failed, sorted into `StoreReadFailure` — or `null` for the fresh-install case, which is
 * not a failure.
 *
 * `ENOENT` is the only errno treated as "nothing is wrong". Everything else the filesystem can raise —
 * `EACCES` after a mode or ownership change, `EISDIR`, `EIO` on a failing disk — describes a file that
 * exists and cannot be read, which is the opposite of a fresh install and must never be answered with
 * defaults a write could then persist over it.
 */
export function classifyStoreReadFailure(error: unknown): StoreReadFailure | null {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
  return error instanceof SyntaxError ? 'unparseable' : 'unreadable'
}

/**
 * A `config.json` that exists and could not be loaded, as an error the guard can classify later.
 *
 * Deliberately does **not** set `cause`, and that is a secrets rule rather than a style choice. V8 puts a
 * prefix of the offending input into `SyntaxError.message` — `JSON.parse('ghp_…')` reports ``Unexpected
 * token 'g', "ghp_…" is not valid JSON`` — and a `config.json` clobbered down to a bare token is exactly
 * the hand-edit that produces it. Node prints the `[cause]` chain for an uncaught throw and any handler
 * may log it, so attaching the original error would publish the token. The classification is everything a
 * caller can act on; the text that would leak is nothing a caller needs.
 */
export class UnreadableStoreError extends Error {
  readonly source: string
  readonly failure: StoreReadFailure

  constructor(source: string, failure: StoreReadFailure) {
    super(`[store] ${source} could not be read. ${storeReadCause(failure)}`)
    this.name = 'UnreadableStoreError'
    this.source = source
    this.failure = failure
  }
}

/**
 * Any read failure as this module's own value-free error.
 *
 * The single place a foreign error is converted, so no caller has to remember that a backend's own error
 * may quote the file. conf rethrows V8's parse error, which carries the input's first ten characters —
 * `Unexpected token 'g', "ghp_SENTIN"... is not valid JSON` — so for a `config.json` clobbered down to a
 * bare token, letting it reach a log or an IPC reply publishes the credential.
 */
function asUnreadableStoreError(error: unknown, source: string): UnreadableStoreError {
  if (error instanceof UnreadableStoreError) return error
  return new UnreadableStoreError(source, classifyStoreReadFailure(error) ?? 'unreadable')
}

/**
 * A failure raised while *writing*, with anything that could quote the file replaced.
 *
 * Narrower than `asUnreadableStoreError` on purpose. A backend's `set` re-reads before it writes — conf
 * does — so a replacement landing at that moment surfaces as a parse error carrying the file's first ten
 * characters. Only that class is rewrapped: an errno failure names the path, which is not secret, and
 * converting it would report a failed write as a failed read.
 */
function withoutStoredBytes(error: unknown, source: string): unknown {
  if (error instanceof UnreadableStoreError) return error
  return error instanceof SyntaxError ? new UnreadableStoreError(source, 'unparseable') : error
}

/**
 * The failure kind behind a caught read error.
 *
 * Classifies a raw error too, rather than only reading `UnreadableStoreError.failure`: the Electron
 * backend's read is conf's own, which rethrows a bare `SyntaxError` for an unparseable file and never
 * produces this module's class, so without the fallback the GUI's report would name no cause at all.
 */
function storeReadFailureOf(error: unknown): StoreReadFailure | undefined {
  if (error instanceof UnreadableStoreError) return error.failure
  return classifyStoreReadFailure(error) ?? undefined
}

/** The cause-and-remedy tail, skipping the cause when the kind is unknown so no double space appears. */
function storeReadTail(failure: StoreReadFailure | undefined): string {
  return [storeReadCause(failure), storeReadRemedy(failure)].filter((part) => part !== '').join(' ')
}

/**
 * The report for refusing a write because the file it would rewrite could not be read — issue #67.
 *
 * Both shipped backends persist the whole schema as one JSON blob on every `set()`, so a write performed
 * while the load failed does not change one field: it replaces the file with the schema defaults the
 * failed load left in memory. `githubToken` is stored there in plain text and exists nowhere else, so
 * that is credential loss, and it was reachable from any ordinary command — `mao config set-theme dark`,
 * or a `mao repos remove` that matched nothing and said so while destroying the file.
 *
 * Refusing the *write* rather than the *boot* is what keeps the diagnosis possible. Reads still answer,
 * so `mao config show`, `mao repos list` and the Sidebar can report the problem (see
 * `createGuardedStore`'s `problems()`), which a throwing constructor would have taken down with the
 * destructive write. It is also the rule this module already stated for `StoredObservation.readable` and
 * which `core/app.ts`'s `saveProviders` already applied to one field; this generalises it to every key
 * from the one place both backends compose through.
 *
 * Nothing is renamed or copied aside. Not writing preserves the file more completely than moving it
 * would, and `config.json` is secret-bearing — an automatic rename would plant the token at a second path
 * the operator never chose, and a copy would leave two files holding one credential.
 */
export function describeRefusedStoredWrite(
  field: keyof MaoStoreSchema,
  source: string,
  failure: StoreReadFailure | undefined,
): string {
  return (
    `[store] Refusing to write "${field}" to ${source}, because the file could not be read. A write ` +
    'replaces the whole file, so it would overwrite the stored GitHub token, AI providers, tracked ' +
    'repositories and workflow queue with schema defaults. Nothing has been written — the file is exactly ' +
    `as it was. ${storeReadTail(failure)} Its contents are not shown here, because the GitHub token is ` +
    'stored in it in plain text.'
  )
}

/**
 * The `problems()` entry for a file that could not be loaded at all, as opposed to one field in it.
 *
 * Without this the gate above is a wall with no sign on it: for an unparseable file every per-field rule
 * reads the already-defaulted snapshot and answers "nothing wrong", so `mao config show` printed
 * `storeProblems: []` next to `githubToken: '[unset]'` for a file that still held the token — which
 * points the operator at `mao config set-token`, the most destructive command available to them.
 */
export function describeUnloadableStore(source: string, failure: StoreReadFailure | undefined): string {
  return (
    `[store] ${source} could not be read at all, so no stored value was established and MAO is running ` +
    'on schema defaults — every setting in the file is affected, not one of them. Writes are refused ' +
    `while this stands, so the file still holds everything it held. ${storeReadTail(failure)} Its ` +
    'contents are not shown here, because the GitHub token is stored in it in plain text.'
  )
}

/**
 * Reads and parses a config file, refusing anything that is not a usable settings object.
 *
 * The one strict loader, shared by both backends rather than reimplemented beside each: `FileStore`'s
 * `getFresh` reads through it, and `electron/store.ts` runs it *before* electron-store exists (see
 * `openGuardedStoreFile`). `{}` for a missing file — the normal first run — and `UnreadableStoreError`
 * for everything else.
 *
 * A top-level `null`, array, string or number is refused rather than returned. Each parses cleanly and
 * then spreads to nothing — or, for a string, to numeric index keys — so it used to arrive as a complete
 * defaults object with `readable: true` and nothing anywhere to report it: the one shape with no signal.
 */
export function loadStoredFileStrict(filePath: string): Partial<MaoStoreSchema> {
  let text: string
  try {
    text = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    const failure = classifyStoreReadFailure(error)
    if (failure === null) return {}
    throw new UnreadableStoreError(filePath, failure)
  }
  return parseStoredSettings(text, filePath)
}

/**
 * The root-shape rule on its own, over text rather than a path.
 *
 * Split out so the *same* rule can be handed to a backend that does its own reading — see
 * `createStoredFileParser`. `JSON.parse` can only fail with a `SyntaxError`, so the kind is fixed here
 * rather than classified.
 */
export function parseStoredSettings(text: string, source: string): Partial<MaoStoreSchema> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UnreadableStoreError(source, 'unparseable')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnreadableStoreError(source, 'not-an-object')
  }
  return parsed as Partial<MaoStoreSchema>
}

/**
 * The root-shape rule as a backend's own deserializer — for electron-store's `deserialize` option.
 *
 * This is what closes the interval `openGuardedStoreFile`'s pre-check cannot: the check reads the file,
 * then conf reads it *again* inside its constructor, and a replacement landing in between was coerced and
 * written back before anything could refuse it. Judging conf's **own** bytes removes the interval rather
 * than narrowing it — there is no longer a read that escapes the rule. It also makes every later conf
 * read strict, including the one its `set()` performs internally, so a parse failure there surfaces as
 * this module's value-free error instead of V8's, which quotes the file.
 *
 * Typed as returning the full schema because that is the option's signature. The value really is partial
 * and that is correct: conf merges its `defaults` over whatever this returns, and the read guard handles
 * a key that is missing or the wrong shape regardless.
 */
export function createStoredFileParser(source: string): (text: string) => MaoStoreSchema {
  return (text) => parseStoredSettings(text, source) as MaoStoreSchema
}

/**
 * Composes a backend whose *construction* already reads — and may already write — the config file.
 *
 * This exists for electron-store, and the ordering is the whole point. conf builds its store inside its
 * own constructor: for a file that is valid JSON but not an object its getter succeeds
 * (`Object.assign({}, [1,2,3])`), its `assert.deepEqual` against the merged defaults then fails, and it
 * writes those defaults straight back — destroying the file *before any `set()` exists to refuse it*.
 * Verified against conf 14.0.0 for `null`, `[]`, a bare string and a number. No write gate can reach
 * that, so the file has to be judged before the backend is built, which is what `loadStoredFileStrict`
 * does here.
 *
 * The `try` around `construct()` is the second half, and not redundant with the check above. conf
 * rethrows V8's own parse error for an unparseable file, and V8 puts the input's first ten characters
 * into that message (`Unexpected token 'g', "ghp_SENTIN"... is not valid JSON`) — so for a `config.json`
 * clobbered down to a bare token, letting conf's error escape publishes the credential into the main
 * process's logs. Rewrapping closes that, and also covers the narrow window where the file changes
 * between the check and the construction.
 *
 * It rewraps through `withoutStoredBytes`, not `asUnreadableStoreError`, and the difference is the whole
 * reason that narrower helper exists. conf's constructor is a *writer* — merging its defaults back is the
 * behaviour this function is built around — so a construction failure is as likely to be a failed write
 * (a read-only `userData`, ENOSPC) as a failed read. Converting those would tell an operator the file
 * "could not be read" and send them to check its permissions while the file reads perfectly, and the CLI
 * reading the very same file would report it healthy. Only a parse failure, which can quote the bytes, is
 * rewritten.
 *
 * `filePath` is the caller's own resolved path rather than one read back off the constructed backend,
 * because there is no backend yet when it is needed. Callers must therefore pin whatever options
 * determine that path instead of relying on the backend's defaults.
 */
export function openGuardedStoreFile(
  filePath: string,
  construct: () => StoredValueBackend,
  warn?: (message: string) => void,
): MaoStore {
  loadStoredFileStrict(filePath)
  let backing: StoredValueBackend
  try {
    backing = construct()
  } catch (error) {
    throw withoutStoredBytes(error, filePath)
  }
  // The strict fresh read is supplied here rather than left to the backend, and it is not a convenience.
  // conf does not fail for a root it can still coerce: its getter is `Object.assign({}, parsed)`, so a
  // `config.json` replaced with `[1,2,3]`, `null`, a bare string or a number after a clean boot comes back
  // as a property bag — every schema key simply absent — and `readRawFresh`'s fallback to `get` saw a
  // healthy store. `assertStoredFileLoadable` then passed and the next `set()` rewrote the file from
  // defaults, which is issue #67 again on the far side of boot. Judging the file at construction cannot
  // cover that; only a fresh read that applies the same root-shape rule can, and this is the one place
  // that knows both the path and that the backend was opened from it.
  const strict: StoredValueBackend = {
    get: <K extends keyof MaoStoreSchema>(key: K) => backing.get(key),
    set: <K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]) => {
      // The write gate ran before this, but a backend that re-reads to merge can still meet a file
      // replaced in between — and conf's error for that quotes the bytes. Covers `setIfUnchanged`'s
      // final write too, which reaches the backend through this same wrapper.
      try {
        backing.set(key, value)
      } catch (error) {
        throw withoutStoredBytes(error, filePath)
      }
    },
    getFresh: <K extends keyof MaoStoreSchema>(key: K) =>
      loadStoredFileStrict(filePath)[key] as MaoStoreSchema[K] | undefined,
  }
  return createGuardedStore(strict, filePath, warn)
}

/**
 * The report for a backend that could not be read at all, rather than one holding the wrong shape.
 *
 * Value-free by construction: an I/O or parse failure is free to quote the file's own bytes, and
 * `config.json` holds `githubToken` in plaintext — so nothing from the underlying error is interpolated,
 * only the field and the file. It is phrased as a halt because that is what it causes: a state MAO
 * cannot establish is treated as unusable, never as healthy.
 */
export function describeUninspectableStore(
  field: keyof MaoStoreSchema,
  source: string,
  failure?: StoreReadFailure,
): string {
  return (
    `[store] MAO could not read "${field}" from ${source} at all, so it cannot establish whether the ` +
    `value is usable — treating it as unusable. ${storeReadTail(failure)}`
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
 * All three array-typed fields are guarded at both the container and the entry level, and the question
 * `workflowTasks` raised is answered rather than deferred: a queue MAO cannot fully read halts
 * unattended automation (see `describeUnusableTaskQueue()` and `WorkflowEngine.requireQueueRecovery()`),
 * because carrying on with a corrected subset lets the immediate first auto-trigger poll overwrite the
 * unusable durable entries and start a pipeline. `aiProviders` is filtered and reported but deliberately
 * halts nothing. Adding a field here means answering the same question for it: what does the fallback
 * value cost, which write heals it, and does losing data let unattended work start against state MAO can
 * no longer account for?
 *
 * Reporting and correcting are **not** the same scope, and `githubRepos` is the reason the distinction
 * is written down. Its entries are reported here (issue #72) and corrected nowhere:
 * `isRepoRef`/`canonicalRepoList` own dropping them, the file keeps them until an explicit list write,
 * and the report is what stops that write being the operator's first news of it. A field may therefore
 * be reported more than it is corrected — never the reverse.
 *
 * What this guard does **not** cover, so the halt is not read as more than it is: most fields in a
 * `config.json` that is not valid JSON at all still read as their schema defaults because
 * `FileStore.load()` swallows the parse error (issue #67; the fresh queue observation itself fails
 * closed). A `githubRepos` entry that cannot name a repository is *reported* here (#72) but still
 * dropped by `isRepoRef`/`canonicalRepoList` rather than by this guard, so a read hands the junk
 * through and the next list write is what removes it. `aiProviders` and `workflowTasks`, by contrast,
 * validate each complete declared entry here (#75): valid entries survive in order, invalid entries
 * stay on disk until an explicit same-field write, and any invalid durable task raises the
 * queue-recovery latch before a host can resume.
 */
export function createStoredReadGuard(
  source: string,
  warn: (message: string) => void = (message) => console.warn(message),
): StoredReadGuard {
  const reported = new Set<keyof MaoStoreSchema>()

  return function guardStoredRead<K extends keyof MaoStoreSchema>(key: K, raw: MaoStoreSchema[K]): MaoStoreSchema[K] {
    // The same `storedValueProblem()` `problems()` answers from, deliberately: a guard that decided
    // whether to speak from its own copy of the question could warn about a value the GUI was never told
    // about — which is the half of this that reaches a packaged-app operator and the half that does not.
    const problem = storedValueProblem(key, raw, source)
    const usable = usableStoredValue(key, raw)
    if (problem === null) return usable
    if (!reported.has(key)) {
      reported.add(key)
      warn(problem.message)
    }
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

  /**
   * Refuses a write when the file it is about to rewrite could not be read — issue #67. See
   * `describeRefusedStoredWrite` for why this is a write refusal and not a boot refusal.
   *
   * Lives here rather than in either backend because both compose through this function, so one rule
   * covers `FileStore` and electron-store at once — including a file corrupted *after* a clean boot,
   * which no constructor-time check could see. It is the action `StoredObservation.readable` has always
   * documented ("callers that are about to write must treat this as unknown and refuse") and which
   * `core/app.ts`'s `saveProviders` already took for one field; this generalises it to every key.
   *
   * `setIfUnchanged` deliberately does not route through here: it already refuses on a throwing fresh
   * read by returning `'unverifiable'`, which is a stronger guard than this one and reports a result
   * rather than throwing.
   */
  function assertStoredFileLoadable<K extends keyof MaoStoreSchema>(key: K): void {
    try {
      readRawFresh(key)
    } catch (error) {
      throw new StoredWriteGuardError(describeRefusedStoredWrite(key, source, storeReadFailureOf(error)), {
        restartRequired: true,
      })
    }
  }

  function readRaw<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
    const value = backend.get(key)
    // Cloned, never the shared `MAO_STORE_DEFAULTS` instance — one caller pushing into what it read
    // would otherwise poison the default for the rest of the process.
    return value === undefined ? structuredClone(MAO_STORE_DEFAULTS[key]) : value
  }

  return {
    get<K extends keyof MaoStoreSchema>(key: K): MaoStoreSchema[K] {
      // conf re-reads and re-parses the file on every `get`, so this read can fail — and its error is
      // V8's, which quotes the file. Converted rather than swallowed: answering schema defaults for a
      // file MAO could not read is exactly the silence issue #67 was about, and the write gate already
      // stops anything from persisting over it. `FileStore` answers from its constructor snapshot and
      // cannot reach this path at all, so this is the Electron host's path only.
      //
      // It does NOT follow that throwing is free for every caller. `core/auto-trigger.ts`'s `tick()`
      // reads the repository list through this, and it is invoked bare and from `setInterval` — a throw
      // escaping there is an unhandled rejection nothing can catch, measured as one per tick before that
      // caller was guarded. A new consumer of `get()` on a long-lived host has to handle this the same
      // way; reverting to a coerced default here instead would restore the silence.
      let raw: MaoStoreSchema[K]
      try {
        raw = readRaw(key)
      } catch (error) {
        throw asUnreadableStoreError(error, source)
      }
      return guardRead(key, raw)
    },
    validateWrite<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): string | undefined {
      return describeInvalidStoredWrite(key, value, source) ?? undefined
    },
    set<K extends keyof MaoStoreSchema>(key: K, value: MaoStoreSchema[K]): void {
      // The caller's own mistake first, then the file's state: a bad value is the more specific fault and
      // is worth reporting even when the file is also unreadable.
      assertStoredWrite(key, value, source)
      assertStoredFileLoadable(key)
      backend.set(key, value)
    },
    problems(): StoredValueProblem[] {
      // Probed before the per-field rules, because when the load failed they cannot see anything: every
      // raw value `readRaw` hands them is a schema default, which is valid, so the honest answer "the
      // whole file is unreadable" came back as `[]`. One entry, not one per field — the file is the
      // problem, and three copies of the same sentence would read as three faults.
      //
      // Carried on `QUEUE_GATING_FIELD` so `findStoredQueueProblem()` and the Sidebar's queue card still
      // find it (an unreadable file *is* an unreadable queue). It deliberately does not claim to be a
      // `githubRepos` problem, which would put the Sidebar's destructive "Reset stored list" button under
      // a message that is not about repositories — and that write is refused now anyway.
      //
      // The probe and the per-field rules sit inside ONE boundary, not two. `describeStoredProblems` reads
      // every guarded field, and for conf each of those is a fresh parse of the file — so a file that
      // turned unparseable after the probe succeeded used to let V8's error, and the bytes it quotes,
      // escape from the middle of a diagnostic whose whole job is to report safely.
      try {
        readRawFresh(QUEUE_GATING_FIELD)
        return describeStoredProblems(readRaw, source)
      } catch (error) {
        const message = describeUnloadableStore(source, storeReadFailureOf(error))
        return [{ field: QUEUE_GATING_FIELD, source, message, wholeFile: true, nothingUsable: false }]
      }
    },
    inspect<K extends keyof MaoStoreSchema>(key: K): StoredObservation<K> {
      let raw: MaoStoreSchema[K]
      try {
        // The FRESH read deliberately, not `get`'s: an observation exists to be acted on, and on
        // `FileStore` a snapshot read would compare a recovery against a value taken at construction.
        raw = readRawFresh(key)
      } catch (error) {
        // Fail closed, and say nothing about the value: a read that threw established nothing, so a
        // caller about to write must refuse rather than assume the stored value is the corrupt one it
        // last saw. `readable: false` is what carries that distinction. The error is classified for the
        // report's sake only — never interpolated, because a parse error may quote the file's own bytes.
        return {
          value: structuredClone(MAO_STORE_DEFAULTS[key]),
          problem: describeUninspectableStore(key, source, storeReadFailureOf(error)),
          readable: false,
          witness: undefined,
        }
      }
      // Guarded through the same `guardRead` as `get()`, deliberately — including its once-per-field
      // warning — so an observation and a plain read cannot disagree about the value or about whether
      // the operator was told. The problem is derived from the SAME `raw`, not from a second read.
      return {
        value: guardRead(key, raw),
        problem: storedValueProblem(key, raw, source)?.message,
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
   * `load()`, but a file that exists and cannot be loaded **throws** instead of reading as `{}`.
   *
   * The constructor keeps the swallowing `load()`, and that is still deliberate: boot coerces so every
   * read-only command keeps working and can report the problem. What a *conditional write* — and now the
   * write gate in `createGuardedStore` — needs is the opposite: a file MAO could not load must become
   * "unknown", never "unchanged". Issue #67 is answered on the write side, not by aborting the boot.
   *
   * Three things it refuses where the raw loader did not. A top-level `null`, array, string or number
   * parses cleanly and then spreads to nothing — or, for a string, to numeric index keys — so it reached
   * `set()` as a full defaults object and destroyed the file exactly as an unparseable one did, while
   * `inspect()` answered `readable: true` and the queue latch never fired: the one shape with no signal
   * anywhere. `ENOENT` stays the single benign errno. And the error is this module's own, so no caller
   * can print V8's parse message, which embeds a prefix of the file — see `UnreadableStoreError`.
   */
  private loadStrict(): Partial<MaoStoreSchema> {
    return loadStoredFileStrict(this.filePath)
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
