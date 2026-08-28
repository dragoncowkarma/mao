import fs from 'node:fs'
import path from 'node:path'

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
 * Presence of the file (not its contents) is the signal `createMaoApp` checks before allowing
 * auto-resume — `fs.existsSync` doesn't require successfully parsing anything, so a partially
 * written or corrupted marker still fails safely closed (blocks resume) rather than open.
 */
const MARKER_FILE_NAME = 'workflow-persistence-broken.marker'

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

/** Removes the marker once an operator has verified the queue and target repo by hand. Silently no-ops if absent. */
export function clearPersistenceBrokenMarker(dataDir: string): void {
  try {
    fs.rmSync(markerPath(dataDir), { force: true })
  } catch {
    // Best-effort; nothing more to do if even removing it fails.
  }
}
