import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { ProcessTracker, processGroupExists, terminateProcessGroups } from './registry.ts'
import type { TrackedProcess } from './registry.ts'

const children: ChildProcess[] = []
const directories: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && processGroupExists(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
    }
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, 'close').catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))])
    }
  }
  directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
})

/** The parent waits for its descendant to exit, so POSIX can reap the entire group after SIGTERM. */
async function processTree(): Promise<{ child: ChildProcess; descendant: number }> {
  const script = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    process.on('SIGTERM', () => {})
    child.once('spawn', () => console.log(child.pid))
    child.once('close', () => process.exit(0))
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', script], { detached: true, shell: false,
    stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const descendant = await new Promise<number>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Fake process tree did not become ready')), 3000)
    const finish = (action: () => void) => { clearTimeout(timer); action() }
    child.once('error', (error) => finish(() => reject(error)))
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (/^\d+\n/.test(output)) finish(() => resolve(Number(output.trim())))
    })
  })
  return { child, descendant }
}
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

describe.skipIf(process.platform === 'win32')('real POSIX process supervision', () => {
  it('terminates multiple isolated provider groups and their descendants within one deadline', async () => {
    const trees = await Promise.all([processTree(), processTree()])
    for (const { child, descendant } of trees) {
      expect(child.pid).toBeGreaterThan(1)
      expect(alive(descendant)).toBe(true)
      expect(processGroupExists(child.pid!)).toBe(true)
    }
    const started = Date.now()
    const result = await terminateProcessGroups(trees.map(({ child }) => child.pid!), 1500)
    expect(Date.now() - started).toBeLessThan(2000)
    expect([...result.values()]).toEqual([true, true])
    for (const { child, descendant } of trees) {
      expect(processGroupExists(child.pid!)).toBe(false)
      expect(alive(descendant)).toBe(false)
    }
  }, 10_000)

  it('handles a real missing executable before adoption without claiming child ownership', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-process-spawn-'))
    directories.push(directory)
    const tracker = new ProcessTracker(path.join(directory, 'registry.json'))
    const child = spawn(path.join(directory, 'missing-provider'), [], { detached: true, shell: false })
    const failed = once(child, 'error')
    const record: TrackedProcess = {
      pid: null, role: 'worker', ai_name: 'codex', model: 'test', reasoning: 'medium',
      task_ref: 'issue#1:initial', branch: 'worker/1-test', command: 'missing-provider', cwd: directory,
      log_file: '', started_at: new Date().toISOString(), status: 'running',
    }
    expect(() => tracker.adopt(child, record)).toThrow('isolated process group')
    const [error] = await failed
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(tracker.active.size).toBe(0)
    expect(tracker.states.size).toBe(0)
    expect(fs.existsSync(tracker.file)).toBe(false)
  })
})
