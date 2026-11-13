import fs from 'node:fs'
import path from 'node:path'
import { runSwarmEngine } from './swarm/engine.ts'


export type SwarmRepositoryPathErrorCode = 'missing' | 'not-checkout'

/** Identifies repository-path validation failures so shells can add interface-specific help. */
export class SwarmRepositoryPathError extends Error {
  override readonly name = 'SwarmRepositoryPathError'

  constructor(
    readonly code: SwarmRepositoryPathErrorCode,
    message: string,
  ) {
    super(message)
  }
}

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

/**
 * Resolve a repository path to its nearest containing checkout. Walking `.git` markers supports
 * regular clones, linked worktrees, submodules, and nested working directories without adding a
 * shell or an unbounded Git subprocess before the orchestrator starts.
 */
export function resolveGitCheckoutRoot(repoPath: string): string {
  const resolvedPath = path.resolve(repoPath)
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
    throw new SwarmRepositoryPathError(
      'missing',
      `Swarm repository path does not exist or is not a directory: ${resolvedPath}`,
    )
  }

  let candidate = fs.realpathSync.native(resolvedPath)
  while (!fs.existsSync(path.join(candidate, '.git'))) {
    const parent = path.dirname(candidate)
    if (parent === candidate) {
      throw new SwarmRepositoryPathError(
        'not-checkout',
        `Swarm repository path is not inside a Git checkout: ${resolvedPath}`,
      )
    }
    candidate = parent
  }
  return candidate
}

/** Run the native core orchestrator; shells only parse options and report its exit code. */
export async function runSwarm(options: SwarmRunOptions): Promise<number> {
  if (options.interval !== undefined && (!Number.isInteger(options.interval) || options.interval <= 0)) {
    throw new Error(`Swarm interval must be a positive integer, received ${options.interval}`)
  }
  const repoRoot = resolveGitCheckoutRoot(options.repoRoot ?? process.cwd())
  return runSwarmEngine(repoRoot, options)
}
