import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => {
  const mock = vi.fn()
  Object.defineProperty(mock, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        mock(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            Object.assign(error, { stdout, stderr })
            reject(error)
            return
          }
          resolve({ stdout, stderr })
        })
      }),
  })
  return { execFileMock: mock }
})

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { checkoutBranch, commitAndPush, ensureClone, hasChanges } from './git-workspace.ts'

const EXPECTED_TIMEOUT_MS = 15 * 60 * 1000
const tmpDirs: string[] = []

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

function callbackFrom(args: unknown[]): ExecFileCallback {
  const callback = args.at(-1)
  if (typeof callback !== 'function') throw new Error('execFile callback is missing')
  return callback as ExecFileCallback
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-git-workspace-'))
  tmpDirs.push(root)
  return root
}

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockImplementation((...args: unknown[]) => {
    queueMicrotask(() => callbackFrom(args)(null, '', ''))
  })
})

afterEach(() => {
  vi.useRealTimers()
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('git workspace command timeout', () => {
  it('applies the bounded timeout to every local and credential-capable Git operation', async () => {
    const root = makeRoot()
    const dir = path.join(root, 'acme__widgets')

    await ensureClone(root, 'acme', 'widgets', 'secret-token')

    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    await ensureClone(root, 'acme', 'widgets', 'secret-token')
    await checkoutBranch(dir, 'main', 'workflow/test')
    await hasChanges(dir)
    await commitAndPush(dir, 'workflow/test', 'Test commit')

    expect(execFileMock).toHaveBeenCalledTimes(10)
    for (const [, , options] of execFileMock.mock.calls) {
      expect(options).toMatchObject({ timeout: EXPECTED_TIMEOUT_MS })
    }
  })

  it('rejects a Git command that never finishes before the configured timeout', async () => {
    vi.useFakeTimers()
    execFileMock.mockImplementation((...args: unknown[]) => {
      const options = args[2] as { timeout?: number }
      // A mocked execFile has no native watchdog, so emulate Node's timeout callback using
      // the option supplied by run() while the fake command itself never completes.
      setTimeout(() => {
        const error = Object.assign(new Error('Command failed'), {
          killed: true,
          signal: 'SIGTERM',
        })
        callbackFrom(args)(error, '', '')
      }, options.timeout)
    })

    const result = hasChanges('/test/repo')
    const rejection = expect(result).rejects.toThrow('Git operation timed out after 900s')

    await vi.advanceTimersByTimeAsync(EXPECTED_TIMEOUT_MS)
    await rejection
  })
})
