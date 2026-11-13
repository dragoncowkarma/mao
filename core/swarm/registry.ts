import fs from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { writeStoreFileAtomic } from '../store-file.ts'
import { classifyProviderFailure } from './cooldown.ts'

export const LIFECYCLE_ROLES = ['worker', 'worker_revise', 'reviewer', 'maintainer'] as const
export type LifecycleRole = typeof LIFECYCLE_ROLES[number]
export type ProcessStatus = 'running' | 'completed' | 'failed' | 'deferred' | 'unknown' | 'stuck'
export interface TrackedProcess {
  pid: number | null
  role: LifecycleRole
  ai_name: string
  model: string
  reasoning: string
  task_ref: string
  branch: string
  command: string
  cwd: string
  log_file: string
  started_at: string
  ended_at?: string | null
  status: ProcessStatus
  exit_code?: number | null
  failure_reason?: string | null
  retry_after?: string | null
  defer_scope?: 'provider' | 'event' | null
}
interface LifecycleState {
  record: TrackedProcess
  failure_count: number
  last_observed_at: string
}
const LIVE = new Set<ProcessStatus>(['running', 'stuck'])
const STATUSES = new Set(['running', 'completed', 'failed', 'deferred', 'unknown', 'stuck'])
export const MAX_HISTORY_RECORDS = 500
export const MAX_LIFECYCLE_STATES = 4500

/** Event versions share an item-wide running guard but retain independent role slots. */
export function lifecycleItemKey(ref: string): string {
  const match = /^(issue|review|maintain|revise)#(\d+)/.exec(ref)
  return match ? `${match[1] === 'issue' ? 'issue' : 'pr'}#${match[2]}` : `event:${ref}`
}
const stateKey = (record: Pick<TrackedProcess, 'task_ref' | 'role'>) =>
  `${lifecycleItemKey(record.task_ref)}:${record.role}`
const timestamp = (record: TrackedProcess) => record.ended_at || record.started_at
const boundedFailure = (record: TrackedProcess) => record.status === 'failed' || record.status === 'unknown'
  || (record.status === 'deferred' && record.defer_scope === 'event')

function validRecord(value: unknown): value is TrackedProcess {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (r.pid === null || (Number.isSafeInteger(r.pid) && Number(r.pid) > 1))
    && LIFECYCLE_ROLES.includes(r.role as LifecycleRole)
    && STATUSES.has(String(r.status))
    && ['ai_name', 'model', 'reasoning', 'task_ref', 'branch', 'command', 'cwd', 'log_file', 'started_at']
      .every((key) => typeof r[key] === 'string')
    && Number.isFinite(Date.parse(String(r.started_at)))
    && (r.ended_at == null || (typeof r.ended_at === 'string' && Number.isFinite(Date.parse(r.ended_at))))
    && (r.retry_after == null || (typeof r.retry_after === 'string' && Number.isFinite(Date.parse(r.retry_after))))
    && (r.defer_scope == null || r.defer_scope === 'provider' || r.defer_scope === 'event')
}

/** Read only the bounded diagnostic tail; agent logs can be many megabytes. */
export function readLogTail(file: string, bytes = 2000): string {
  if (!file) return ''
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(bytes, size))
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - bytes))
    return buffer.toString('utf8')
  } catch { return '' } finally { if (fd !== undefined) fs.closeSync(fd) }
}

/** EPERM still proves a group exists. Never signal pid 0/1 or this leader's group. */
export function processGroupExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false
  try { process.kill(-pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

/** All groups share one graceful deadline and one forced-exit grace, independent of child count. */
export async function terminateProcessGroups(
  pids: number[],
  timeoutMs = 5000,
  groupExists = processGroupExists,
  signal: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) => { process.kill(-pid, sig) },
): Promise<Map<number, boolean>> {
  const eligible = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid)
  const send = (sig: NodeJS.Signals) => {
    for (const pid of eligible) if (groupExists(pid)) {
      try { signal(pid, sig) } catch { /* Existence is checked after the common deadline. */ }
    }
  }
  const wait = async (ms: number) => {
    const end = Date.now() + ms
    while (eligible.some(groupExists) && Date.now() < end) await delay(Math.min(25, end - Date.now()))
  }
  send('SIGTERM')
  await wait(timeoutMs)
  send('SIGKILL')
  await wait(250)
  return new Map(eligible.map((pid) => [pid, !groupExists(pid)]))
}

/**
 * Durable dispatch authority is separate from capped diagnostic history. Reading status is offline
 * and never writes or sends a signal. Snake-case persistence preserves existing Python registries.
 */
export class ProcessTracker {
  readonly history: TrackedProcess[] = []
  readonly states = new Map<string, LifecycleState>()
  readonly cooldowns = new Map<string, string>()
  readonly active = new Map<number, { child: ChildProcess, record: TrackedProcess }>()
  private readonly falseDeferrals = new Map<string, Set<string>>()

  constructor(readonly file: string) {
    let data: Record<string, unknown> = {}
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) data = raw as Record<string, unknown>
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Array.isArray(data.history)) this.history.push(...data.history.filter(validRecord))
    // Healing includes already-deferred legacy records, whose old parser may have imposed 24h.
    for (const record of this.history) this.healDeferred(record)
    let validStates = Array.isArray(data.lifecycle_states) && data.lifecycle_states.length === 0
    if (Array.isArray(data.lifecycle_states)) {
      for (const raw of data.lifecycle_states) {
        if (!raw || typeof raw !== 'object') continue
        const state = raw as LifecycleState
        if (!validRecord(state.record) || !Number.isSafeInteger(state.failure_count) || state.failure_count < 0) continue
        validStates = true
        this.healDeferred(state.record)
        const observed = typeof state.last_observed_at === 'string' ? state.last_observed_at : timestamp(state.record)
        const key = stateKey(state.record)
        if (!this.states.has(key) || this.states.get(key)!.last_observed_at <= observed) {
          this.states.set(key, { ...state, last_observed_at: observed })
        }
      }
    }
    const authoritative = new Set(this.states.keys())
    if (!validStates || data.lifecycle_state_version !== 2) {
      for (const record of this.history) if (!authoritative.has(stateKey(record))) {
        this.remember(record, boundedFailure(record))
      }
    }
    if (data.provider_cooldowns && typeof data.provider_cooldowns === 'object') {
      for (const [provider, until] of Object.entries(data.provider_cooldowns)) {
        if (!this.falseDeferrals.get(provider)?.has(String(until)) && typeof until === 'string' && Number.isFinite(Date.parse(until))) {
          this.cooldowns.set(provider, until)
        }
      }
    }
    // Replace obsolete provider-map deadlines, retaining the maximum among current role states.
    const recalculated = new Map<string, string>()
    for (const state of this.states.values()) if (state.record.defer_scope === 'provider' && state.record.retry_after) {
      const { ai_name: provider, retry_after: until } = state.record
      const previous = recalculated.get(provider)
      if (!previous || Date.parse(previous) < Date.parse(until)) recalculated.set(provider, until)
    }
    for (const [provider, until] of recalculated) this.cooldowns.set(provider, until)
    this.compact()
  }

  private healDeferred(record: TrackedProcess): void {
    if (record.status !== 'failed' && record.status !== 'deferred') return
    // Exit status is authoritative. A successful review can quote quota errors as task content.
    if (record.exit_code === 0) {
      if (record.status === 'deferred' && record.retry_after) {
        const deadlines = this.falseDeferrals.get(record.ai_name) ?? new Set<string>()
        deadlines.add(record.retry_after)
        this.falseDeferrals.set(record.ai_name, deadlines)
      }
      record.status = 'completed'
      delete record.retry_after
      delete record.defer_scope
      delete record.failure_reason
      return
    }
    const ended = new Date(timestamp(record))
    const failure = classifyProviderFailure(readLogTail(record.log_file), new Date(record.started_at), ended)
    if (!failure) return
    record.status = 'deferred'
    record.retry_after = failure.retryAfter.toISOString()
    record.defer_scope = failure.scope
    record.failure_reason = failure.reason
  }

  remember(record: TrackedProcess, countFailure = false): void {
    const key = stateKey(record)
    const previous = this.states.get(key)
    const failures = previous?.record.task_ref === record.task_ref ? previous.failure_count : 0
    this.states.set(key, { record, failure_count: failures + Number(countFailure), last_observed_at: timestamp(record) })
    if (record.status === 'deferred' && record.defer_scope === 'provider' && record.retry_after) {
      const old = this.cooldowns.get(record.ai_name)
      if (!old || Date.parse(old) < Date.parse(record.retry_after)) this.cooldowns.set(record.ai_name, record.retry_after)
    }
  }

  private compact(): void {
    this.history.splice(0, Math.max(0, this.history.length - MAX_HISTORY_RECORDS))
    const states = [...this.states.entries()].sort((a, b) => a[1].last_observed_at.localeCompare(b[1].last_observed_at))
    for (const [key, state] of states) {
      if (this.states.size <= MAX_LIFECYCLE_STATES) break
      if (!LIVE.has(state.record.status)) this.states.delete(key)
    }
    // Live ownership cannot be evicted. Dispatch refuses admission at the cap instead.
    for (const [provider, until] of this.cooldowns) if (Date.parse(until) <= Date.now()) this.cooldowns.delete(provider)
    for (const [provider] of this.cooldowns) {
      if (this.cooldowns.size <= MAX_LIFECYCLE_STATES) break
      this.cooldowns.delete(provider)
    }
  }

  save(): void {
    this.compact()
    writeStoreFileAtomic(this.file, JSON.stringify({
      last_updated: new Date().toISOString(), lifecycle_state_version: 2,
      history: this.history, lifecycle_states: [...this.states.values()],
      provider_cooldowns: Object.fromEntries(this.cooldowns),
    }, null, 2))
  }

  reset(): void {
    this.history.length = 0
    this.states.clear()
    this.cooldowns.clear()
    try { fs.unlinkSync(this.file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  shouldDispatch(ref: string, role: LifecycleRole, provider?: string, completionConfirmed = false): [boolean, string] {
    const item = lifecycleItemKey(ref)
    for (const state of this.states.values()) {
      if (lifecycleItemKey(state.record.task_ref) !== item) continue
      if (state.record.status === 'running') return [false, 'already running']
      if (state.record.status === 'stuck') return [false, 'residual process tree requires operator cleanup']
    }
    const state = this.states.get(`${item}:${role}`)
    const same = state?.record.task_ref === ref
    if (same && state.record.status === 'completed') {
      return [false, completionConfirmed ? 'already completed' : 'completed without confirmed lifecycle transition']
    }
    if (same && state.failure_count >= 3) return [false, `exhausted ${state.failure_count} failed attempts`]
    const until = provider ? this.cooldowns.get(provider) : undefined
    if (until && Date.parse(until) > Date.now()) return [false, `provider cooldown until ${until}`]
    if (same && state.record.retry_after && Date.parse(state.record.retry_after) > Date.now()) {
      return [false, `provider cooldown until ${state.record.retry_after}`]
    }
    if (!state && this.states.size >= MAX_LIFECYCLE_STATES) return [false, 'lifecycle registry capacity reached']
    return [true, same ? 'retry after failure' : 'new event']
  }

  adopt(child: ChildProcess, record: TrackedProcess): void {
    if (!child.pid || child.pid <= 1) throw new Error('AI child has no isolated process group')
    // Synchronous ownership transfer: no await or file I/O before this map records the child.
    record.pid = child.pid
    this.active.set(child.pid, { child, record })
    this.remember(record)
  }

  recordFailure(record: TrackedProcess): void {
    record.status = 'failed'
    record.ended_at = new Date().toISOString()
    this.history.push(record)
    this.remember(record, true)
    this.save()
  }

  reconcileOrphans(groupExists = processGroupExists): boolean {
    let changed = false
    for (const state of this.states.values()) {
      const record = state.record
      if (!LIVE.has(record.status) || (record.pid !== null && this.active.has(record.pid))) continue
      if (record.pid !== null && groupExists(record.pid)) {
        // Unknown inherited process ownership is observed only; numeric group ids are never re-signalled.
        if (record.status !== 'stuck') { record.status = 'stuck'; changed = true }
      } else {
        record.status = 'unknown'
        record.ended_at = new Date().toISOString()
        state.failure_count += 1
        changed = true
      }
      state.last_observed_at = timestamp(record)
    }
    return changed
  }

  async poll(): Promise<void> {
    let changed = this.reconcileOrphans()
    const finished = [...this.active].filter(([, entry]) => entry.child.exitCode !== null || entry.child.signalCode !== null)
    const stop = await terminateProcessGroups(finished.filter(([, entry]) => entry.record.status !== 'stuck').map(([pid]) => pid))
    for (const [pid, { child, record }] of finished) {
      if (record.status === 'stuck' ? processGroupExists(pid) : !stop.get(pid)) {
        record.status = 'stuck'
        this.remember(record)
        changed = true
        continue
      }
      record.ended_at = new Date().toISOString()
      record.exit_code = child.exitCode
      const failure = child.exitCode === 0 ? null
        : classifyProviderFailure(readLogTail(record.log_file), new Date(record.started_at), new Date(record.ended_at))
      record.status = failure ? 'deferred' : child.exitCode === 0 ? 'completed' : 'failed'
      if (failure) {
        record.retry_after = failure.retryAfter.toISOString()
        record.failure_reason = failure.reason
        record.defer_scope = failure.scope
      }
      this.active.delete(pid)
      this.history.push(record)
      this.remember(record, boundedFailure(record))
      changed = true
    }
    if (changed) this.save()
  }

  /** Never resend signals to a previously stuck group; operators own its residual tree. */
  async killAll(onlyPids?: number[]): Promise<boolean> {
    const selected = onlyPids ? new Set(onlyPids) : undefined
    const result = await terminateProcessGroups([...this.active]
      .filter(([pid, e]) => (!selected || selected.has(pid)) && e.record.status !== 'stuck').map(([pid]) => pid))
    for (const [pid, { child, record }] of this.active) {
      if (selected && !selected.has(pid)) continue
      const stopped = record.status === 'stuck' ? !processGroupExists(pid) : result.get(pid)
      if (!stopped) { record.status = 'stuck'; this.remember(record); continue }
      record.exit_code = child.exitCode
      record.ended_at = new Date().toISOString()
      record.status = 'failed'
      this.history.push(record)
      this.remember(record, true)
      this.active.delete(pid)
    }
    this.save()
    return selected ? [...selected].every((pid) => !this.active.has(pid)) : this.active.size === 0
  }

  reconcileOpenItems(issues: { number: number }[], prs: { number: number }[]): void {
    let changed = false
    for (const [kind, items] of [['issue', issues], ['pr', prs]] as const) {
      if (items.length >= 1000 || items.some((item) => !item || !Number.isSafeInteger(item.number) || item.number <= 0)) continue
      const open = new Set(items.map((item) => `${kind}#${item.number}`))
      for (const [key, state] of this.states) {
        const item = lifecycleItemKey(state.record.task_ref)
        if (item.startsWith(`${kind}#`) && !open.has(item) && !LIVE.has(state.record.status)) {
          this.states.delete(key)
          changed = true
        }
      }
    }
    if (changed) this.save()
  }

  summary(): string {
    const records = [...this.states.values()].map((state) => state.record)
    const active = records.filter((record) => LIVE.has(record.status))
    return ['SWARM PROCESS STATUS', `Active (${active.length}):`,
      ...active.map((r) => `${r.pid} ${r.role} ${r.task_ref} ${r.status}`),
      'Recent History:', ...this.history.slice(-10).map((r) => {
        const reset = r.retry_after ? ` retry ${new Date(r.retry_after).toString()} (${r.retry_after} UTC)` : ''
        return `${r.role} ${r.task_ref} ${r.status}${reset}`
      }), `Totals: ${this.history.length} finished, ${active.length} running`].join('\n')
  }
}
