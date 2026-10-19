import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * File-level primitives for the single JSON blob both `MaoStore` backends persist to — issue #73.
 *
 * Every field of `MaoStoreSchema` lives in one `config.json`, and more than one MAO process can have it
 * open at once: a long-running `mao run` (or the desktop app) beside any number of one-shot CLI commands.
 * Two things are needed for their writes not to undo each other, and this module is both:
 *
 * - **A write that replaces the file atomically**, so a process re-reading the file to merge its one key
 *   never sees half of another process's write. `FileStore` merges into a fresh read on every `set()`
 *   (see there), which is only sound if that read can never land on a torn file. electron-store already
 *   writes this way (conf goes through `atomically`).
 * - **A cross-process write lock** around read → compare → write, so a conditional write
 *   (`MaoStore.setIfUnchanged`) cannot pass its compare and then overwrite a change another MAO process
 *   made in the interval before its rename. `createGuardedStore` takes it for both backends.
 *
 * Neither reaches writers that skip the lock — a hand-edit, another tool, or electron-store's own
 * constructor-time merge of its defaults — so "exclusive" here always means "among MAO's own writes".
 */

/** Runs `critical` while holding the config file's cross-process write lock. Synchronous by design. */
export type StoreWriteLock = <T>(critical: () => T) => T

export interface StoreWriteLockOptions {
  /** How long to wait for another holder before giving up with `StoreLockError`. */
  timeoutMs?: number
  /** Age after which a lock is treated as abandoned whoever holds it. See `STORE_LOCK_STALE_MS`. */
  staleMs?: number
}

/**
 * How long a write waits for another process's lock before refusing.
 *
 * Bounded because a write that can hang is a stall (AGENTS.md: every external call is time-bounded), and
 * short because the wait is synchronous — on the desktop app it blocks the main process. Generous all the
 * same: a live holder keeps the lock only for one read, one serialization and one rename of the config
 * file, which is milliseconds.
 */
export const STORE_LOCK_TIMEOUT_MS = 5_000

/**
 * The age past which a lock is abandoned even if its owner looks alive (or cannot be identified, e.g.
 * another host on a shared volume). Far beyond any real hold, so a lock this old means its holder was
 * frozen or killed mid-write — and leaving it in place would refuse every write until a human noticed.
 */
export const STORE_LOCK_STALE_MS = 30_000

/**
 * How old a lock must be before a dead owner pid alone is trusted to mean "abandoned". A pid that does
 * not exist on this host normally settles it, but the same hostname across containers with separate pid
 * namespaces can make a live holder look dead — and no live holder keeps the lock this long.
 */
const DEAD_OWNER_GRACE_MS = 1_000

/**
 * The write lock could not be taken, so nothing was written.
 *
 * Value-free like every store error: it names the lock file and its holder's pid/host, neither of which is
 * secret, and never anything from `config.json`, which holds the GitHub token in plaintext.
 */
export class StoreLockError extends Error {
  readonly lockPath: string

  constructor(lockPath: string, holder: string, waitedMs: number) {
    super(
      `[store] Another MAO process is writing ${lockPath.replace(/\.lock$/, '')} (lock held by ${holder}) ` +
        `and did not finish within ${waitedMs} ms, so nothing was written. If no other MAO process is ` +
        `running, delete ${lockPath} and retry.`,
    )
    this.name = 'StoreLockError'
    this.lockPath = lockPath
  }
}

interface LockOwner {
  pid: number
  host: string
  nonce: string
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<LockOwner>
    if (
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.host === 'string' &&
      typeof parsed.nonce === 'string'
    ) {
      return { pid: parsed.pid, host: parsed.host, nonce: parsed.nonce }
    }
  } catch {
    // An owner still writing its token, or a lock file mangled by hand: the owner is unknown, so only
    // age can declare it abandoned.
  }
  return undefined
}

function describeOwner(owner: LockOwner | undefined): string {
  return owner ? `pid ${owner.pid} on ${owner.host}` : 'an unidentified process'
}

/** `kill(pid, 0)` delivers nothing; it only asks whether the pid exists. EPERM means it does. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * A cross-process write lock for `filePath`, held as an `O_EXCL`-created `<filePath>.lock`.
 *
 * Synchronous on purpose: `setIfUnchanged`'s guarantee rests on nothing being able to run between its
 * compare and its write, and an `await` in here would hand exactly that interval to the event loop.
 *
 * Abandoned locks are broken rather than left to wedge every write, because a holder can die mid-write
 * (SIGKILL, power loss, Ctrl+C on a one-shot command). A lock is abandoned when its owner pid no longer
 * exists on this host (after `DEAD_OWNER_GRACE_MS`), or when it is older than `staleMs` regardless.
 * Breaking it moves the file aside and then checks the moved bytes are the ones judged abandoned; if a
 * fresh lock was taken in between, it is put back. That narrows, but does not remove, the race between two
 * processes breaking the same dead lock at the same moment — a crash inside a millisecond hold *and* two
 * simultaneous breakers, which is the residue this does not claim to close.
 *
 * Not re-entrant: a nested call would wait on itself until the timeout, so it is refused at once instead.
 */
export function createStoreWriteLock(filePath: string, options: StoreWriteLockOptions = {}): StoreWriteLock {
  const lockPath = `${filePath}.lock`
  const timeoutMs = options.timeoutMs ?? STORE_LOCK_TIMEOUT_MS
  const staleMs = options.staleMs ?? STORE_LOCK_STALE_MS
  let held = false

  /** Moves an abandoned lock out of the way. True when the caller should retry acquiring at once. */
  function breakIfAbandoned(): { retry: boolean; owner: LockOwner | undefined } {
    let text: string
    let mtimeMs: number
    try {
      text = fs.readFileSync(lockPath, 'utf-8')
      mtimeMs = fs.statSync(lockPath).mtimeMs
    } catch (err) {
      if (isMissing(err)) return { retry: true, owner: undefined }
      throw err
    }
    const owner = parseOwner(text)
    const age = Date.now() - mtimeMs
    const ownerDead = owner !== undefined && owner.host === os.hostname() && !isProcessAlive(owner.pid)
    if (!(ownerDead && age >= DEAD_OWNER_GRACE_MS) && age < staleMs) return { retry: false, owner }

    const aside = `${lockPath}.abandoned-${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      fs.renameSync(lockPath, aside)
    } catch (err) {
      // Someone else broke it (or its owner released it) first. Either way the slot may be free.
      if (isMissing(err)) return { retry: true, owner }
      throw err
    }
    try {
      if (fs.readFileSync(aside, 'utf-8') !== text) {
        // What was moved is not what was judged: a new holder took the lock after the judgment. Hand its
        // lock back — `link` refuses if the slot was taken again meanwhile, which is the residue above.
        try {
          fs.linkSync(aside, lockPath)
        } catch {
          // Slot already taken again; nothing left to restore it to.
        }
      }
    } finally {
      fs.rmSync(aside, { force: true })
    }
    return { retry: true, owner }
  }

  function acquire(): string {
    const token = JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: randomBytes(12).toString('hex') })
    const startedAt = Date.now()
    let delayMs = 2
    for (;;) {
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true })
        fs.writeFileSync(lockPath, token, { flag: 'wx' })
        return token
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      const { retry, owner } = breakIfAbandoned()
      if (retry) continue
      const waited = Date.now() - startedAt
      if (waited >= timeoutMs) throw new StoreLockError(lockPath, describeOwner(owner), waited)
      sleepSync(Math.min(delayMs, timeoutMs - waited))
      delayMs = Math.min(delayMs * 2, 50)
    }
  }

  /** Removes the lock only if it is still this holder's — a lock broken as abandoned now belongs to another. */
  function release(token: string) {
    try {
      if (fs.readFileSync(lockPath, 'utf-8') === token) fs.unlinkSync(lockPath)
    } catch {
      // Already gone, or unreadable: a lock this process cannot remove is one the next writer will judge
      // by age, which is the same path a crash takes.
    }
  }

  return function withStoreWriteLock<T>(critical: () => T): T {
    if (held) throw new Error(`[store] Re-entrant write to ${filePath}: the write lock is already held here.`)
    const token = acquire()
    held = true
    try {
      return critical()
    } finally {
      held = false
      release(token)
    }
  }
}

/** Errors a rename can raise on Windows while another process has the target open for a read. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Replaces `filePath` with `text` so that no reader can ever observe a partial file: the bytes go to a
 * temporary file in the same directory, are flushed, and are then renamed over the target.
 *
 * The temporary file inherits the target's permission bits, because a rename replaces the inode — and
 * `config.json` holds the GitHub token in plaintext, so an operator's `chmod 600` must survive a write.
 * (An in-place `writeFileSync`, which this replaces, kept the mode implicitly.) A new file gets the same
 * default an in-place write would have.
 *
 * A failure removes the temporary file and leaves the target exactly as it was.
 */
export function writeStoreFileAtomic(filePath: string, text: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  let mode: number | undefined
  try {
    mode = fs.statSync(filePath).mode & 0o777
  } catch (err) {
    if (!isMissing(err)) throw err
  }

  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    fs.writeFileSync(tempPath, text, { flag: 'wx', mode: mode ?? 0o666 })
    // The creation mode is filtered through the umask; set it exactly so a write never changes it.
    if (mode !== undefined) fs.chmodSync(tempPath, mode)
    const fd = fs.openSync(tempPath, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.renameSync(tempPath, filePath)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (process.platform !== 'win32' || !code || !TRANSIENT_RENAME_CODES.has(code) || attempt >= 10) throw err
        sleepSync(10 * attempt)
      }
    }
  } catch (err) {
    fs.rmSync(tempPath, { force: true })
    throw err
  }
}
