import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The two shell call sites that cannot be reached from a `core` test, asserted as source text.
 *
 * `cli/index.ts` builds a commander program and `electron/ipc.ts` needs a live Electron app, so neither
 * can be imported here (architecture rule 1 forbids the second outright). What matters about both is an
 * **ordering**, which is exactly what review of PR #69 found wrong: `mao run` calls `startAutoTrigger`
 * (which ticks immediately) and then `resumeProcessing()` unconditionally, so a gate placed after either
 * of them would let the unreadable queue be overwritten and a pipeline start before it ever ran.
 *
 * Text, then, for the same reason `core/store.test.ts` reads `electron/store.ts` as text and
 * `core/node-environment.test.ts` reads the vitest config: a hand-maintained coupling with no type to
 * enforce it is better pinned imprecisely than not at all.
 */
const REPO_ROOT = path.join(
  (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'),
  '..',
)

/**
 * Comments stripped before anything is matched, mirroring `core/store.test.ts`'s own helper.
 *
 * Not fastidiousness: the first version of this test matched the phrase `resumeProcessing()` inside the
 * explanatory comment that sits *above* the gate, and so read the ordering backwards and failed against
 * correct code. Only executable text may satisfy these assertions.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function sourceOf(relative: string): string {
  return withoutComments(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8'))
}

describe('cli run refuses before it can start anything', () => {
  const source = sourceOf(path.join('cli', 'index.ts'))
  const runAction = source.slice(source.indexOf("  .command('run')"))

  it('reads the latch before startAutoTrigger and before resumeProcessing', () => {
    const gate = runAction.indexOf('getQueueRecoveryReason()')
    const poller = runAction.indexOf('startAutoTrigger(')
    const resume = runAction.indexOf('resumeProcessing()')

    expect(gate, 'mao run must consult the queue latch').toBeGreaterThan(-1)
    expect(poller).toBeGreaterThan(-1)
    expect(resume).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(poller)
    expect(gate).toBeLessThan(resume)
  })

  it('exits non-zero rather than idling, so a cron caller can see it', () => {
    // An unattended invocation that reports success while nothing polls is worse than a failure it can
    // act on, and `mao run` exists to be called from cron.
    const gated = runAction.slice(runAction.indexOf('getQueueRecoveryReason()'), runAction.indexOf('startAutoTrigger('))

    expect(gated).toContain('process.exitCode = 1')
    expect(gated).toContain('return')
  })

  it('offers the confirm command, not clear-completed, as the way out', () => {
    // `mao workflow clear-completed` emits `'change'` and is therefore gated too — naming it would send
    // the operator at a command that now refuses.
    const gated = runAction.slice(runAction.indexOf('getQueueRecoveryReason()'), runAction.indexOf('startAutoTrigger('))

    expect(gated).toContain('confirm-queue-recovery')
    expect(gated).not.toContain('clear-completed')
  })
})

describe('electron/ipc.ts exposes the latch and its way out', () => {
  const source = sourceOf(path.join('electron', 'ipc.ts'))

  it('answers the latch from the engine, not from storeProblems', () => {
    // The latch is monotone, so after an out-of-band repair the store reads clean while the process stays
    // halted. Driving the GUI card from `storeProblems` would hide exactly that window.
    const handler = source.slice(source.indexOf("ipcMain.handle('workflow:recoveryRequired'"))
    const body = handler.slice(0, handler.indexOf('ipcMain.handle', 1))

    expect(body).toContain('workflowEngine.isQueueRecoveryLatched()')
    expect(body).toContain('workflowEngine.getQueueRecoveryReason()')
    expect(body).not.toContain('store.problems()')
  })

  it('delegates the outcome to core rather than deciding success itself', () => {
    // Rule 2, and the reason the two shells cannot disagree about whether confirmation worked.
    expect(source).toMatch(
      /ipcMain\.handle\('workflow:confirmQueueRecovery',\s*\(\)\s*=>\s*workflowEngine\.confirmQueueRecovery\(\)\)/,
    )
  })
})
