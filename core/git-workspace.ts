import { execFile } from 'node:child_process'
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A hung Git subprocess would otherwise block the single-flight workflow queue indefinitely.
 * Fifteen minutes still leaves room for legitimate large clone and push operations.
 */
const GIT_OPERATION_TIMEOUT_MS = 15 * 60 * 1000

type GitExecOptions = Pick<ExecFileOptionsWithStringEncoding, 'cwd'>

async function run(
  command: string,
  args: readonly string[],
  options?: GitExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn()
      }

      let child
      try {
        child = execFile(
          command,
          args,
          {
            ...options,
            encoding: 'utf8',
            timeout: GIT_OPERATION_TIMEOUT_MS,
            killSignal: 'SIGKILL',
          },
          (error, stdout, stderr) => {
            settle(() => {
              if (error) {
                Object.assign(error, { stdout, stderr })
                reject(error)
                return
              }
              resolve({ stdout, stderr })
            })
          },
        )
      } catch (error) {
        settle(() => reject(error))
        return
      }

      if (settled) return
      timer = setTimeout(() => {
        settle(() => {
          // Reject even if the OS refuses the kill: queue progress must not depend on `close`.
          try {
            child.kill('SIGKILL')
          } catch {
            // The process may have exited between the watchdog firing and this kill attempt.
          }
          reject(Object.assign(new Error('Git operation timed out'), {
            killed: true,
            signal: 'SIGKILL',
          }))
        })
      }, GIT_OPERATION_TIMEOUT_MS)
    })
  } catch (err: any) {
    if (err?.killed === true && err.signal) {
      err.message = [
        `Git operation timed out after ${GIT_OPERATION_TIMEOUT_MS / 1000}s:`,
        command,
        ...args,
      ].join(' ')
    }
    if (err && typeof err.message === 'string') {
      err.message = err.message.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:[REDACTED]@')
    }
    if (err && typeof err.stderr === 'string') {
      err.stderr = err.stderr.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:[REDACTED]@')
    }
    if (err && typeof err.stdout === 'string') {
      err.stdout = err.stdout.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:[REDACTED]@')
    }
    if (err && typeof err.cmd === 'string') {
      err.cmd = err.cmd.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:[REDACTED]@')
    }
    throw err
  }
}

function repoDir(root: string, owner: string, repo: string): string {
  return path.join(root, `${owner}__${repo}`)
}

function authenticatedRemote(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
}

/** Clones the repo into `root` on first use, or fetches latest if already cloned. Returns the local path. */
export async function ensureClone(root: string, owner: string, repo: string, token: string): Promise<string> {
  const dir = repoDir(root, owner, repo)
  const remote = authenticatedRemote(owner, repo, token)

  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(root, { recursive: true })
    await run('git', ['clone', remote, dir])
  } else {
    await run('git', ['remote', 'set-url', 'origin', remote], { cwd: dir })
    await run('git', ['fetch', 'origin'], { cwd: dir })
  }

  return dir
}

export async function checkoutBranch(dir: string, base: string, branch: string): Promise<void> {
  await run('git', ['checkout', base], { cwd: dir })
  await run('git', ['pull', 'origin', base], { cwd: dir })
  await run('git', ['checkout', '-B', branch], { cwd: dir })
}

export async function hasChanges(dir: string): Promise<boolean> {
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir })
  return stdout.trim().length > 0
}

export async function commitAndPush(dir: string, branch: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: dir })
  await run('git', ['commit', '-m', message], { cwd: dir })
  await run('git', ['push', '-u', 'origin', branch, '--force'], { cwd: dir })
}
