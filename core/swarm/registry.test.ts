import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  lifecycleItemKey, LIFECYCLE_ROLES, MAX_HISTORY_RECORDS, ProcessTracker, terminateProcessGroups,
} from './registry.ts'
import type { LifecycleRole, ProcessStatus, TrackedProcess } from './registry.ts'

const dirs: string[] = []
function fixture(): { tracker: ProcessTracker, file: string, directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-swarm-registry-'))
  dirs.push(directory)
  const file = path.join(directory, 'registry.json')
  return { tracker: new ProcessTracker(file), file, directory }
}
const record = (changes: Partial<TrackedProcess> = {}): TrackedProcess => ({
  pid: null, role: 'reviewer', ai_name: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium',
  task_ref: 'review#42-head-a', branch: 'worker/7-test', command: 'codex', cwd: '/tmp', log_file: '',
  started_at: '2026-11-04T00:00:00.000Z', status: 'failed', ...changes,
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

describe('bounded lifecycle authority', () => {
  it.each([
    ['issue#7:initial', 'issue#7'], ['review#42-a', 'pr#42'], ['maintain#42-comment1', 'pr#42'],
    ['revise#42-x', 'pr#42'], ['custom:task', 'event:custom:task'],
  ])('maps %s to its item without losing role ownership', (ref, expected) => expect(lifecycleItemKey(ref)).toBe(expected))

  it.each(LIFECYCLE_ROLES.flatMap((running) => LIFECYCLE_ROLES.map((requested) => [running, requested])))('%s blocks concurrent %s on the same PR', (running, requested) => {
    const { tracker } = fixture()
    tracker.remember(record({ role: running as LifecycleRole, status: 'running' }))
    expect(tracker.shouldDispatch('revise#42-new', requested as LifecycleRole)[0]).toBe(false)
    expect(tracker.shouldDispatch('revise#43-new', requested as LifecycleRole)[0]).toBe(true)
  })

  it.each(['running', 'stuck'] as ProcessStatus[])('preserves %s authority through diagnostic compaction', (status) => {
    const { tracker, file } = fixture()
    tracker.remember(record({ role: 'worker_revise', status, pid: 888001 }))
    for (let n = 0; n < MAX_HISTORY_RECORDS + 20; n++) {
      const failed = record({ task_ref: `issue#${n}:initial`, role: 'worker' })
      tracker.history.push(failed)
      tracker.remember(failed, true)
    }
    tracker.save()
    expect(tracker.history).toHaveLength(500)
    const reopened = new ProcessTracker(file)
    expect(reopened.shouldDispatch('review#42-other', 'reviewer')[0]).toBe(false)
  })

  it('keeps Reviewer, revision Worker and Maintainer state independently across a restart', () => {
    const { tracker, file } = fixture()
    for (const role of ['reviewer', 'worker_revise', 'maintainer'] as const) tracker.remember(record({ role, status: 'completed', task_ref: `${role === 'reviewer' ? 'review' : role === 'maintainer' ? 'maintain' : 'revise'}#42-done` }))
    tracker.save()
    const reopened = new ProcessTracker(file)
    expect(reopened.states.size).toBe(3)
    expect(reopened.shouldDispatch('review#42-done', 'reviewer')[1]).toContain('without confirmed')
    expect(reopened.shouldDispatch('maintain#42-done', 'maintainer', undefined, true)[1]).toBe('already completed')
    expect(reopened.shouldDispatch('review#42-new-head', 'reviewer')[0]).toBe(true)
  })

  it('bounds crash/setup retries while a new event starts its own budget', () => {
    const { tracker } = fixture()
    for (let n = 0; n < 3; n++) tracker.recordFailure(record())
    expect(tracker.shouldDispatch('review#42-head-a', 'reviewer')[1]).toContain('exhausted 3')
    expect(tracker.shouldDispatch('review#42-head-b', 'reviewer')[0]).toBe(true)
  })

  it('does not consume crash budget for provider-wide cooldowns', () => {
    const { tracker } = fixture()
    for (let n = 0; n < 5; n++) tracker.remember(record({ status: 'deferred', defer_scope: 'provider', retry_after: '2099-01-01T00:00:00Z' }))
    expect([...tracker.states.values()][0].failure_count).toBe(0)
    expect(tracker.shouldDispatch('review#43-new', 'reviewer', 'codex')[1]).toContain('provider cooldown')
    expect(tracker.shouldDispatch('review#43-new', 'reviewer', 'claude')[0]).toBe(true)
  })

  it('counts event-local deferrals in the bounded retry budget', () => {
    const { tracker } = fixture()
    for (let n = 0; n < 3; n++) tracker.remember(record({ status: 'deferred', defer_scope: 'event' }), true)
    expect(tracker.shouldDispatch('review#42-head-a', 'reviewer')[0]).toBe(false)
  })

  it('prunes only terminal closed items with complete snapshots, preserving live ownership', () => {
    const { tracker } = fixture()
    tracker.remember(record({ status: 'completed' }))
    tracker.remember(record({ task_ref: 'issue#7:initial', role: 'worker', status: 'running' }))
    tracker.reconcileOpenItems([], Array.from({ length: 1000 }, (_, number) => ({ number: number + 1000 })))
    expect(tracker.states.size).toBe(2)
    tracker.reconcileOpenItems([], [])
    expect(tracker.states.size).toBe(1)
    expect([...tracker.states.values()][0].record.status).toBe('running')
  })

  it.each(['running', 'stuck'] as ProcessStatus[])('reconciles inherited %s once its group disappears', (status) => {
    const { tracker } = fixture()
    tracker.remember(record({ status, pid: 888001 }))
    tracker.reconcileOrphans(() => true)
    expect([...tracker.states.values()][0].record.status).toBe('stuck')
    tracker.reconcileOrphans(() => false)
    expect([...tracker.states.values()][0].record.status).toBe('unknown')
    expect(tracker.shouldDispatch('review#42-head-a', 'reviewer')[0]).toBe(true)
  })

  it.each(['null', '[]', '{"history":{}}', '{"history":[null,{},42]}', '{invalid'])('recovers malformed registry shape %s without writing during reads', (raw) => {
    const { file } = fixture()
    fs.writeFileSync(file, raw)
    const tracker = new ProcessTracker(file)
    expect(tracker.history).toHaveLength(0)
    expect(fs.readFileSync(file, 'utf8')).toBe(raw)
  })

  it('skips malformed records individually and migrates complete legacy history', () => {
    const { file } = fixture()
    fs.writeFileSync(file, JSON.stringify({ history: [null, record({ status: 'completed' }), { ...record(), pid: 0 }] }))
    const tracker = new ProcessTracker(file)
    expect(tracker.history).toHaveLength(1)
    expect(tracker.shouldDispatch('review#42-head-a', 'reviewer')[0]).toBe(false)
  })

  it('heals already-deferred records from their log tails rather than retaining 24-hour legacy cooldowns', () => {
    const { file, directory } = fixture()
    const log = path.join(directory, 'agent.log')
    fs.writeFileSync(log, 'monthly spend limit; resets in 2m')
    const previous = record({ status: 'deferred', defer_scope: 'provider', log_file: log,
      retry_after: '2099-01-01T00:00:00Z', ended_at: new Date().toISOString() })
    fs.writeFileSync(file, JSON.stringify({ history: [previous], provider_cooldowns: { codex: '2099-01-01T00:00:00Z' } }))
    const tracker = new ProcessTracker(file)
    expect(Date.parse(tracker.history[0].retry_after!)).toBeLessThan(Date.now() + 4 * 60_000)
    expect(tracker.cooldowns.get('codex')).toBe(tracker.history[0].retry_after)
  })
  it('anchors healed relative resets to the historical finish time rather than extending them on restart', () => {
    const { file, directory } = fixture()
    const log = path.join(directory, 'historical.log')
    fs.writeFileSync(log, 'rate limit exceeded; resets in 2m')
    const ended = '2020-01-01T00:00:00.000Z'
    fs.writeFileSync(file, JSON.stringify({ history: [record({ status: 'deferred', defer_scope: 'provider',
      log_file: log, ended_at: ended, retry_after: '2099-01-01T00:00:00Z' })] }))
    const tracker = new ProcessTracker(file)
    expect(tracker.history[0].retry_after).toBe('2020-01-01T00:03:00.000Z')
    expect(tracker.cooldowns.has('codex')).toBe(false)
  })
  it('observes a stuck child without re-signalling its numeric process group', async () => {
    const { tracker } = fixture()
    const child = { pid: 888001, exitCode: 1, signalCode: null } as ChildProcess
    tracker.adopt(child, record({ pid: 888001, status: 'stuck' }))
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(await tracker.killAll()).toBe(false)
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
    expect(tracker.active.size).toBe(1)
  })

  it('writes a complete replacement and preserves the prior bytes on atomic rename failure', () => {
    const { tracker, file } = fixture()
    tracker.recordFailure(record())
    const before = fs.readFileSync(file, 'utf8')
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('I/O failure') })
    expect(() => tracker.save()).toThrow('I/O failure')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['registry.json'])
    rename.mockRestore()
  })

  it('adopts a spawned child synchronously before any registry write', () => {
    const { tracker, file } = fixture()
    const child = { pid: 888001 } as ChildProcess
    tracker.adopt(child, record({ status: 'running' }))
    expect(tracker.active.has(888001)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    tracker.save()
    expect(new ProcessTracker(file).shouldDispatch('review#42-head-a', 'reviewer')[0]).toBe(false)
  })

  it('rejects spawn results without a safe isolated group identifier', () => {
    const { tracker } = fixture()
    expect(() => tracker.adopt({ pid: undefined } as ChildProcess, record())).toThrow('isolated process group')
    expect(tracker.active.size).toBe(0)
  })
})

describe('shared process-group supervision', () => {
  it('signals all groups in a batch and filters invalid or duplicate identifiers', async () => {
    const groups = new Set([888001, 888002])
    const signals: [number, string][] = []
    const result = await terminateProcessGroups([0, 1, process.pid, 888001, 888002, 888001], 0,
      (pid) => groups.has(pid), (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') groups.delete(pid) })
    expect(signals).toEqual([[888001, 'SIGTERM'], [888002, 'SIGTERM'], [888001, 'SIGKILL'], [888002, 'SIGKILL']])
    expect([...result.values()]).toEqual([true, true])
  })

  it('reports residual groups without falsely declaring cleanup success', async () => {
    const signal = vi.fn()
    const result = await terminateProcessGroups([888001], 0, () => true, signal)
    expect(result.get(888001)).toBe(false)
    expect(signal).toHaveBeenCalledTimes(2)
  })
})


describe('migration and reset anchors', () => {
  it('does not resurrect pruned current-version authority from diagnostic history', () => {
    const { tracker, file } = fixture()
    tracker.history.push(record({ status: 'completed' }))
    tracker.save()
    const reopened = new ProcessTracker(file)
    expect(reopened.states.size).toBe(0)
    expect(reopened.shouldDispatch('review#42-head-a', 'reviewer')[0]).toBe(true)
  })
  it('heals date-less midnight resets from process start rather than finish', () => {
    vi.stubEnv('TZ', 'UTC')
    const { file, directory } = fixture()
    const log = path.join(directory, 'limit.log')
    fs.writeFileSync(log, 'hit your usage limit. try again at 00:15')
    const deferred = record({ status: 'deferred', started_at: '2026-11-03T23:59:00Z',
      ended_at: '2026-11-04T00:30:00Z', log_file: log })
    fs.writeFileSync(file, JSON.stringify({ history: [deferred] }))
    const reopened = new ProcessTracker(file)
    expect(reopened.history[0].retry_after).toBe('2026-11-04T00:16:00.000Z')
  })
  it('keeps the latest healed provider reset among independently completed role slots', () => {
    const { file } = fixture()
    const deferred = (ref: string, until: string) => ({ record: record({ task_ref: ref,
      status: 'deferred', defer_scope: 'provider', retry_after: until }), failure_count: 0 })
    fs.writeFileSync(file, JSON.stringify({ lifecycle_state_version: 2, lifecycle_states: [
      deferred('review#42-a', '2099-01-02T00:00:00Z'), deferred('review#43-b', '2099-01-01T00:00:00Z'),
    ] }))
    expect(new ProcessTracker(file).cooldowns.get('codex')).toBe('2099-01-02T00:00:00Z')
  })
})


describe('successful completion takes precedence over quota text', () => {
  it.each([0, 1])('classifies real harvested exit %s without treating quoted errors as success failures', async (exitCode) => {
    const { tracker, file, directory } = fixture()
    const log = path.join(directory, 'quoted-limit.log')
    fs.writeFileSync(log, 'Review covers rate limit exceeded and too many requests; monthly spend limit')
    tracker.adopt({ pid: 888001, exitCode, signalCode: null } as ChildProcess,
      record({ status: 'running', log_file: log }))
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    await tracker.poll()
    expect(tracker.history[0].status).toBe(exitCode === 0 ? 'completed' : 'deferred')
    expect(tracker.cooldowns.has('codex')).toBe(exitCode !== 0)
    const reopened = new ProcessTracker(file)
    expect(reopened.shouldDispatch('review#42-head-a', 'reviewer', 'codex')[0]).toBe(false)
    expect(reopened.cooldowns.has('codex')).toBe(exitCode !== 0)
  })

  it('repairs previously deferred exit-zero records and their false cooldown after restart', () => {
    const { file, directory } = fixture()
    const log = path.join(directory, 'success.log')
    fs.writeFileSync(log, 'rate limit exceeded')
    const falseDeferred = record({ status: 'deferred', exit_code: 0, defer_scope: 'provider',
      retry_after: '2099-01-01T00:00:00Z', log_file: log })
    fs.writeFileSync(file, JSON.stringify({ lifecycle_state_version: 2, history: [falseDeferred],
      lifecycle_states: [{ record: falseDeferred, failure_count: 0 }],
      provider_cooldowns: { codex: '2099-01-01T00:00:00Z', claude: '2099-01-02T00:00:00Z' } }))
    const reopened = new ProcessTracker(file)
    expect(reopened.history[0].status).toBe('completed')
    expect(reopened.history[0].retry_after).toBeUndefined()
    expect(reopened.cooldowns.has('codex')).toBe(false)
    expect(reopened.cooldowns.has('claude')).toBe(true)
    expect(reopened.shouldDispatch('review#42-head-a', 'reviewer')[0]).toBe(false)
    expect(reopened.shouldDispatch('review#43-other', 'reviewer', 'codex')[0]).toBe(true)
  })
})


it('preserves a different same-provider cooldown when repairing a falsely deferred success', () => {
  const { file } = fixture()
  const falseDeferred = record({ status: 'deferred', exit_code: 0, defer_scope: 'provider',
    retry_after: '2099-01-01T00:00:00Z' })
  fs.writeFileSync(file, JSON.stringify({ history: [falseDeferred],
    provider_cooldowns: { codex: '2099-01-02T00:00:00Z' } }))
  expect(new ProcessTracker(file).cooldowns.get('codex')).toBe('2099-01-02T00:00:00Z')
})
