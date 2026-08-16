import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

async function run(
  command: string,
  args: readonly string[],
  options?: any,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, options)
    return {
      stdout: typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
      stderr: typeof stderr === 'string' ? stderr : stderr.toString('utf8'),
    }
  } catch (err: any) {
    if (err && typeof err.message === 'string') {
      err.message = err.message.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:[REDACTED]@')
    }
    if (err && typeof err.stderr === 'string') {
      err.stderr = err.stderr.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:[REDACTED]@')
    }
    if (err && typeof err.stdout === 'string') {
      err.stdout = err.stdout.replace(/https:\/\/x-access-token:[^@]+@/g, 'https://x-access-token:[REDACTED]@')
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
