import fs from 'node:fs'
import path from 'node:path'
import type { QueuedTask } from './workflow-engine.ts'

/**
 * A durable "the queue store is confirmed broken" marker, deliberately independent of `MaoStore`.
 *
 * Both shipped `MaoStore` backends (`FileStore` here, and Electron's `electron-store` wrapper)
 * persist their entire schema as one JSON blob and rewrite the whole file on every `set()` call,
 * regardless of which key changed. That means writing a "persistence is broken" flag through
 * `store.set(...)` retries the *exact same* full-file write that just failed twice for
 * `workflowTasks` — if the underlying failure is infrastructure-wide (disk full, read-only
 * filesystem, permissions), the flag write fails for the identical reason and never reaches disk,
 * silently defeating the whole point of recording it.
 *
 * This marker instead does a single, separate, minimal `fs.writeFileSync` to its own file — a
 * different write than the one that failed, so it has a real chance of succeeding when the
 * original failure was specific to serializing the task list (a large/circular `task.active`
 * value, a store-library size or schema-validation limit) rather than to writing to disk at all.
 * If disk I/O is truly and completely broken, no write anywhere can succeed and there is no way to
 * durably record anything — that failure mode is unrecoverable by construction, not just by this
 * module.
 *
 * Presence of the file (not its contents) is the signal `createMaoApp` carries into the engine before
 * restoring the queue. It blocks queue mutation, repository polling and resume — `fs.existsSync`
 * doesn't require successfully parsing anything, so a partially written or corrupted marker still
 * fails safely closed rather than open.
 */
const MARKER_FILE_NAME = 'workflow-persistence-broken.marker'

export const ACTIVE_WORKFLOW_MARKER_CLEAR_REFUSED =
  'A workflow stage is still active in this MAO process. Wait for it to stop before clearing the ' +
  'persistence marker; restarting while external work is still in flight could make reconciliation stale.'

function markerPath(dataDir: string): string {
  return path.join(dataDir, MARKER_FILE_NAME)
}

/** Best-effort: writes the marker file. Throws if even this minimal, independent write fails — callers must guard it. */
export function writePersistenceBrokenMarker(dataDir: string, error: Error): void {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    markerPath(dataDir),
    JSON.stringify({ brokenAt: new Date().toISOString(), message: error.message }, null, 2),
  )
}

/** True if a previous process recorded a confirmed, unresolved persistence failure. Presence-only check — never throws. */
export function hasPersistenceBrokenMarker(dataDir: string): boolean {
  try {
    return fs.existsSync(markerPath(dataDir))
  } catch {
    // Treat an inability to even check as broken — fail closed (block resume) rather than open.
    return true
  }
}

/**
 * Removes the marker once an operator has verified the queue and target repo by hand. No-ops (and
 * reports success) if it was already absent.
 *
 * Returns whether the marker is confirmed gone afterward, rather than whether `rmSync` itself threw
 * — deleting a file that isn't there isn't a real failure (that's what `force: true` is for), and
 * conversely a permission error, a concurrent recreation, or any other surprise during removal must
 * not be reported as success just because it happened to be swallowed. Re-checking presence with
 * `hasPersistenceBrokenMarker` after the attempt catches both: it's the actual postcondition the
 * caller cares about ("is queue processing unblocked on the next start?"), not "did rmSync avoid
 * throwing?".
 */
export function clearPersistenceBrokenMarker(dataDir: string): boolean {
  try {
    fs.rmSync(markerPath(dataDir), { force: true })
  } catch {
    // Fall through to the presence re-check below rather than assuming failure here — e.g. a
    // permission error on a directory listing that doesn't actually prevent the file from being
    // gone. The re-check is the authoritative answer either way.
  }
  return !hasPersistenceBrokenMarker(dataDir)
}

/**
 * The GUI clears its own marker from the same process that may still have a provider/GitHub operation
 * in flight. Refuse until that stage settles: otherwise the operator can reconcile one snapshot, clear
 * the only restart guard, and restart while the old stage is still changing external state.
 */
export function assertCanClearPersistenceBroken(tasks: QueuedTask[]): void {
  if (tasks.some((task) => task.status === 'running' || task.active !== undefined)) {
    throw new Error(ACTIVE_WORKFLOW_MARKER_CLEAR_REFUSED)
  }
}
