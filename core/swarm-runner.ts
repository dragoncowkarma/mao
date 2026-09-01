import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

const SWARM_SCRIPT_NAME = 'swarm_orchestrator.py'

export interface SwarmRunOptions {
  /** Repository path the swarm should inspect and mutate. Resolves to the containing checkout. */
  repoRoot?: string
  /** GitHub polling interval in seconds. */
  interval?: number
  /** Report planned actions without dispatching agents or changing Git/GitHub state. */
  dryRun?: boolean
  /** Poll once instead of running the long-lived loop. */
  once?: boolean
  /** Print the persisted process registry and exit. */
  status?: boolean
  /** Clear persisted dispatch history before starting. */
  reset?: boolean
}

interface SwarmRunnerDependencies {
  scriptPath?: string
  pythonCommand?: string
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
}

/** Build only fixed argv elements so repository paths and options are never shell-interpolated. */
export function buildSwarmArgs(scriptPath: string, options: SwarmRunOptions): string[] {
  const args = [scriptPath]
  if (options.interval !== undefined) {
    if (!Number.isInteger(options.interval) || options.interval <= 0) {
      throw new Error(`Swarm interval must be a positive integer, received ${options.interval}`)
    }
    args.push('--interval', String(options.interval))
  }
  if (options.dryRun) args.push('--dry-run')
  if (options.once) args.push('--once')
  if (options.status) args.push('--status')
  if (options.reset) args.push('--reset')
  return args
}

/**
 * Resolve the actual CLI bundle directory. The explicit parameters keep both the CommonJS and
 * symlink fallback branches directly testable without mutating process globals.
 */
export function resolveRuntimeDirectory(
  entryPath = process.argv[1],
  moduleDirectory: string | null = typeof __dirname === 'string' ? __dirname : null,
): string {
  if (moduleDirectory) return moduleDirectory
  if (!entryPath) return process.cwd()
  try {
    return path.dirname(fs.realpathSync.native(entryPath))
  } catch {
    return path.dirname(path.resolve(entryPath))
  }
}

/**
 * Resolve a repository path to its nearest containing checkout. Walking `.git` markers supports
 * regular clones, linked worktrees, submodules, and nested working directories without adding a
 * shell or an unbounded Git subprocess before the orchestrator starts.
 */
export function resolveGitCheckoutRoot(repoPath: string): string {
  const resolvedPath = path.resolve(repoPath)
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
    throw new Error(`Swarm repository path does not exist or is not a directory: ${resolvedPath}`)
  }

  let candidate = fs.realpathSync.native(resolvedPath)
  while (!fs.existsSync(path.join(candidate, '.git'))) {
    const parent = path.dirname(candidate)
    if (parent === candidate) {
      throw new Error(`Swarm repository path is not inside a Git checkout: ${resolvedPath}`)
    }
    candidate = parent
  }
  return candidate
}

/**
 * Locate the orchestrator copied beside the CLI bundle, with a source-tree fallback for local
 * development. `MAO_SWARM_SCRIPT` is an explicit operator override for custom packaging layouts.
 * The CJS bundle directory is based on Node's real module path, so npm's symlinked `bin` shim does
 * not redirect asset lookup into the caller's global bin directory.
 */
export function resolveSwarmScriptPath(runtimeDirectory = resolveRuntimeDirectory()): string {
  const candidates = [
    process.env.MAO_SWARM_SCRIPT,
    path.join(runtimeDirectory, SWARM_SCRIPT_NAME),
    path.resolve(runtimeDirectory, '..', '.agents', 'workflows', SWARM_SCRIPT_NAME),
    path.resolve(process.cwd(), '.agents', 'workflows', SWARM_SCRIPT_NAME),
  ].filter((candidate): candidate is string => Boolean(candidate))

  const scriptPath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!scriptPath) {
    throw new Error(
      `Swarm orchestrator asset was not found. Rebuild the CLI or set MAO_SWARM_SCRIPT explicitly.`,
    )
  }
  return scriptPath
}

/**
 * Run the autonomous Swarm Orchestrator for one repository.
 *
 * The Python implementation owns the lifecycle state machine, worktree isolation, provider retry,
 * and GitHub polling. This core adapter owns cross-platform asset resolution and shell-free process
 * launch so the CLI remains a thin delegation and paths supplied by users are never interpolated.
 */
export async function runSwarm(
  options: SwarmRunOptions,
  dependencies: SwarmRunnerDependencies = {},
): Promise<number> {
  const repoRoot = resolveGitCheckoutRoot(options.repoRoot ?? process.cwd())

  const scriptPath = path.resolve(dependencies.scriptPath ?? resolveSwarmScriptPath())
  if (!fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
    throw new Error(`Swarm orchestrator script does not exist: ${scriptPath}`)
  }

  const args = buildSwarmArgs(scriptPath, options)
  const pythonCommand = dependencies.pythonCommand ?? process.env.MAO_SWARM_PYTHON ?? 'python3'
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const child = spawnProcess(pythonCommand, args, {
    cwd: repoRoot,
    env: { ...process.env, MAO_SWARM_REPO_ROOT: repoRoot },
    shell: false,
    stdio: 'inherit',
  })

  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    child.once('error', (error) => settle(() => reject(error)))
    child.once('close', (code, signal) => {
      settle(() => {
        if (signal === 'SIGINT') resolve(130)
        else if (signal === 'SIGTERM') resolve(143)
        else resolve(code ?? 1)
      })
    })
  })
}
