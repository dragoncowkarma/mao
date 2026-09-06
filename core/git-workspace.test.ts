import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => {
  return { execFileMock: vi.fn() }
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

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('Expected promise to reject')
}

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockImplementation((...args: unknown[]) => {
    queueMicrotask(() => callbackFrom(args)(null, '', ''))
    return { kill: vi.fn() }
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
      expect(options).toMatchObject({
        encoding: 'utf8',
        timeout: EXPECTED_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      })
    }
  })

  it('rejects independently and sends SIGKILL when execFile never calls back', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    execFileMock.mockReturnValue({ kill })

    const result = hasChanges('/test/repo')
    const rejection = expect(result).rejects.toThrow(
      'Git operation timed out after 900s: git status --porcelain',
    )

    await vi.advanceTimersByTimeAsync(EXPECTED_TIMEOUT_MS)
    await rejection
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it('redacts credentials while retaining timed-out command context', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    execFileMock.mockReturnValue({ kill })
    const root = makeRoot()

    const errorPromise = captureError(ensureClone(root, 'acme', 'widgets', 'secret-token'))
    await vi.advanceTimersByTimeAsync(EXPECTED_TIMEOUT_MS)
    const error = await errorPromise

    const redactedRemote = 'https://x-access-token:[REDACTED]@github.com/acme/widgets.git'
    expect(error.message).toContain(
      `Git operation timed out after 900s: git clone ${redactedRemote}`,
    )
    expect(error.message).not.toContain('secret-token')
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })
})
