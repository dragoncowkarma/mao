import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StoreLockError, createStoreWriteLock, writeStoreFileAtomic } from './store-file.ts'

const tmpDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-store-file-test-'))
  tmpDirs.push(dir)
  return path.join(dir, 'config.json')
}

/** A pid no live process on this host can have: far above Linux's pid_max and macOS's 99999. */
const DEAD_PID = 2 ** 30

/** Plants another holder's lock file, as a second process (or a crashed one) would have left it. */
function plantLock(filePath: string, owner: { pid: number; host?: string }, ageMs = 0) {
  const lockPath = `${filePath}.lock`
  fs.writeFileSync(lockPath, JSON.stringify({ pid: owner.pid, host: owner.host ?? os.hostname(), nonce: 'planted' }))
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs)
    fs.utimesSync(lockPath, then, then)
  }
  return lockPath
}

/**
 * The lock both `MaoStore` backends take around every write (issue #73).
 *
 * Two lock instances on one path stand in for two processes: the instances share nothing but the file on
 * disk, which is exactly what two MAO processes share.
 */
describe('createStoreWriteLock', () => {
  it('excludes a second holder for the whole critical section, and releases afterwards', () => {
    const filePath = tempConfigPath()
    const first = createStoreWriteLock(filePath)
    const second = createStoreWriteLock(filePath, { timeoutMs: 30 })

    let refused: unknown
    first(() => {
      try {
        second(() => 'ran inside the first holder')
      } catch (err) {
        refused = err
      }
    })

    expect(refused).toBeInstanceOf(StoreLockError)
    expect((refused as Error).message).toMatch(/nothing was written/i)
    // Released: the other holder gets it at once, and nothing is left behind afterwards.
    expect(second(() => 'ran')).toBe('ran')
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false)
  })

  it('releases when the critical section throws', () => {
    const filePath = tempConfigPath()
    const lock = createStoreWriteLock(filePath)

    expect(() =>
      lock(() => {
        throw new Error('write failed')
      }),
    ).toThrow('write failed')
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false)
  })

  it('refuses a nested acquisition at once instead of waiting on itself', () => {
    const filePath = tempConfigPath()
    const lock = createStoreWriteLock(filePath)

    expect(() => lock(() => lock(() => 'nested'))).toThrow(/Re-entrant/)
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false)
  })

  it('waits out a live holder rather than breaking its lock', () => {
    // This process's own pid is alive, and the lock is fresh — exactly a second MAO process mid-write.
    const filePath = tempConfigPath()
    const lockPath = plantLock(filePath, { pid: process.pid })
    const lock = createStoreWriteLock(filePath, { timeoutMs: 40 })

    const startedAt = Date.now()
    expect(() => lock(() => 'ran')).toThrow(StoreLockError)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40)
    // The holder's lock is untouched: refusing must not take it down with us.
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).nonce).toBe('planted')
  })

  it('names the holder and the lock file, and nothing from the config file', () => {
    const filePath = tempConfigPath()
    fs.writeFileSync(filePath, JSON.stringify({ githubToken: 'ghp_SENTINEL_SECRET' }))
    plantLock(filePath, { pid: process.pid })
    const lock = createStoreWriteLock(filePath, { timeoutMs: 10 })

    let message = ''
    try {
      lock(() => undefined)
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toContain(`pid ${process.pid}`)
    expect(message).toContain(`${filePath}.lock`)
    expect(message).not.toContain('ghp_SENTINEL_SECRET')
  })

  it('breaks a lock whose owner no longer exists on this host', () => {
    // A holder killed mid-write (SIGKILL, power loss, Ctrl+C on a one-shot command) leaves its lock
    // behind. Leaving it would refuse every write until a human noticed.
    const filePath = tempConfigPath()
    plantLock(filePath, { pid: DEAD_PID }, 2_000)
    const lock = createStoreWriteLock(filePath, { timeoutMs: 50 })

    expect(lock(() => 'ran')).toBe('ran')
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false)
    expect(fs.readdirSync(path.dirname(filePath))).toEqual([])
  })

  it('does not trust a dead pid on a lock younger than the grace period', () => {
    // Same hostname across containers with separate pid namespaces can make a live holder look dead.
    const filePath = tempConfigPath()
    plantLock(filePath, { pid: DEAD_PID })
    const lock = createStoreWriteLock(filePath, { timeoutMs: 30 })

    expect(() => lock(() => 'ran')).toThrow(StoreLockError)
  })

  it('does not judge another host’s pid by this host’s process table', () => {
    const filePath = tempConfigPath()
    plantLock(filePath, { pid: DEAD_PID, host: `not-${os.hostname()}` }, 2_000)
    const lock = createStoreWriteLock(filePath, { timeoutMs: 30 })

    expect(() => lock(() => 'ran')).toThrow(StoreLockError)
  })

  it('breaks any lock older than the stale age, whoever holds it', () => {
    const filePath = tempConfigPath()
    plantLock(filePath, { pid: process.pid }, 5_000)
    const lock = createStoreWriteLock(filePath, { timeoutMs: 30, staleMs: 1_000 })

    expect(lock(() => 'ran')).toBe('ran')
  })

  it('treats an unreadable lock as an unknown holder, judged by age alone', () => {
    const filePath = tempConfigPath()
    fs.writeFileSync(`${filePath}.lock`, '')
    const lock = createStoreWriteLock(filePath, { timeoutMs: 30, staleMs: 1_000 })

    expect(() => lock(() => 'ran')).toThrow(/an unidentified process/)

    const then = new Date(Date.now() - 5_000)
    fs.utimesSync(`${filePath}.lock`, then, then)
    expect(lock(() => 'ran')).toBe('ran')
  })

  it('puts back a fresh lock taken between judging the old one abandoned and moving it', () => {
    // The breaker's race: it reads a dead owner's lock, and before its rename lands that owner's lock is
    // broken by someone else and a new live holder takes the slot. The rename then moves the LIVE lock.
    // The breaker must notice (the moved bytes are not the ones it judged) and hand the lock back.
    const filePath = tempConfigPath()
    const lockPath = plantLock(filePath, { pid: DEAD_PID }, 2_000)
    const realRename = fs.renameSync
    let raced = false
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!raced && String(from) === lockPath) {
        raced = true
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'live' }))
      }
      return realRename(from, to)
    })
    const lock = createStoreWriteLock(filePath, { timeoutMs: 30 })

    // The live holder keeps its lock, so this acquisition waits it out instead of entering beside it.
    expect(() => lock(() => 'ran')).toThrow(StoreLockError)
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).nonce).toBe('live')
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['config.json.lock'])
  })

  it('leaves a lock it no longer owns in place on release', () => {
    // If this holder's lock was broken as abandoned and someone else took the slot, unlinking on release
    // would remove the other holder's lock mid-write.
    const filePath = tempConfigPath()
    const lock = createStoreWriteLock(filePath)

    lock(() => {
      fs.writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'other' }))
    })

    expect(JSON.parse(fs.readFileSync(`${filePath}.lock`, 'utf-8')).nonce).toBe('other')
  })
})

describe('writeStoreFileAtomic', () => {
  it('replaces the file and leaves no temporary file behind', () => {
    const filePath = tempConfigPath()
    fs.writeFileSync(filePath, '{"theme":"light"}')

    writeStoreFileAtomic(filePath, '{"theme":"dark"}')

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"theme":"dark"}')
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['config.json'])
  })

  it('replaces by rename, so a reader holding the old file never sees a partial write', () => {
    // The property merge-on-write rests on: another process re-reading to merge its one key must only
    // ever see a whole file. An in-place write truncates the same inode; a rename swaps in a new one.
    const filePath = tempConfigPath()
    fs.writeFileSync(filePath, '{"theme":"light"}')
    const before = fs.statSync(filePath).ino

    writeStoreFileAtomic(filePath, '{"theme":"dark"}')

    expect(fs.statSync(filePath).ino).not.toBe(before)
  })

  it.skipIf(process.platform === 'win32')('keeps the permission bits an operator set on the file', () => {
    // A rename replaces the inode, and config.json holds the GitHub token in plaintext: losing a
    // `chmod 600` on the first write after it would be a quiet security regression.
    const filePath = tempConfigPath()
    fs.writeFileSync(filePath, '{}')
    fs.chmodSync(filePath, 0o600)

    writeStoreFileAtomic(filePath, '{"theme":"dark"}')

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('creates the file and its directory when neither exists', () => {
    const filePath = path.join(path.dirname(tempConfigPath()), 'nested', 'config.json')

    writeStoreFileAtomic(filePath, '{}')

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{}')
  })

  it('leaves the original intact and removes its temporary file when the replace fails', () => {
    // A directory at the target makes the rename fail after the temporary file was fully written.
    const filePath = tempConfigPath()
    fs.mkdirSync(filePath)

    expect(() => writeStoreFileAtomic(filePath, '{"theme":"dark"}')).toThrow()
    expect(fs.statSync(filePath).isDirectory()).toBe(true)
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['config.json'])
  })
})
