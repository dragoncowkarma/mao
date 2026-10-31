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
  // Real-pathed, because the lock and the atomic write resolve symlinks before they touch the file
  // (`resolveStoreFilePath`). macOS's default `os.tmpdir()` is `/var/folders/…`, a symlink into
  // `/private/var`, so an unresolved path here never equals the path a spy or a message sees there —
  // and the race test below would quietly stop injecting its race.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-store-file-test-')))
  tmpDirs.push(dir)
  return path.join(dir, 'config.json')
}

/** A pid no live process on this host can have: far above Linux's pid_max and macOS's 99999. */
const DEAD_PID = 2 ** 30

/**
 * Another process that is certainly alive for the whole test: the one that started this worker. Not
 * `process.pid` — a lock naming this process's own pid on a token it does not hold is a stale one from an
 * earlier process that had the same pid, and is judged as such.
 */
const LIVE_OTHER_PID = process.ppid

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
    // A live pid, and a fresh lock — exactly a second MAO process mid-write.
    const filePath = tempConfigPath()
    const lockPath = plantLock(filePath, { pid: LIVE_OTHER_PID })
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
    plantLock(filePath, { pid: LIVE_OTHER_PID })
    const lock = createStoreWriteLock(filePath, { timeoutMs: 10 })

    let message = ''
    try {
      lock(() => undefined)
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toContain(`pid ${LIVE_OTHER_PID}`)
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
    plantLock(filePath, { pid: LIVE_OTHER_PID }, 5_000)
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
        fs.writeFileSync(lockPath, JSON.stringify({ pid: LIVE_OTHER_PID, host: os.hostname(), nonce: 'live' }))
      }
      return realRename(from, to)
    })
    const lock = createStoreWriteLock(filePath, { timeoutMs: 30 })

    // The live holder keeps its lock, so this acquisition waits it out instead of entering beside it.
    expect(() => lock(() => 'ran')).toThrow(StoreLockError)
    // And the race was really injected — a path that never matched the spy would skip it silently.
    expect(raced).toBe(true)
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).nonce).toBe('live')
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(['config.json.lock'])
  })

  it("breaks a lock naming this process's own pid that this process does not hold", () => {
    // A process killed mid-write and restarted under the same pid and hostname — a container's PID 1 —
    // finds its predecessor's lock. kill(pid, 0) succeeds for oneself, so only the held-token set can
    // tell it is stale; without it every write waits out the full stale age.
    const filePath = tempConfigPath()
    plantLock(filePath, { pid: process.pid }, 2_000)
    const lock = createStoreWriteLock(filePath, { timeoutMs: 30 })

    expect(lock(() => 'ran')).toBe('ran')
  })

  it('does not break a lock this process holds through another instance, however old it looks', () => {
    // Two stores on one file in one process share nothing but the disk, as two processes do. The live
    // holder's token is in the held set, so its lock is judged live by pid, not by age within staleMs.
    const filePath = tempConfigPath()
    const holder = createStoreWriteLock(filePath)
    const waiter = createStoreWriteLock(filePath, { timeoutMs: 30 })

    let refused: unknown
    holder(() => {
      const then = new Date(Date.now() - 2_000)
      fs.utimesSync(`${filePath}.lock`, then, then)
      try {
        waiter(() => 'ran')
      } catch (err) {
        refused = err
      }
    })

    expect(refused).toBeInstanceOf(StoreLockError)
  })

  it('leaves no lock behind when writing its token fails after the exclusive create', () => {
    // Otherwise a full disk leaves an empty lock no one owns, which every MAO process waits out by age.
    const filePath = tempConfigPath()
    const lock = createStoreWriteLock(filePath)
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device')
    })

    expect(() => lock(() => 'ran')).toThrow(/ENOSPC/)
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false)
    vi.restoreAllMocks()
    expect(lock(() => 'ran')).toBe('ran')
  })

  it.skipIf(process.platform === 'win32')('is one lock for a file however it is reached', () => {
    // The CLI pointed at the desktop app's config through a symlink must contend for the same lock.
    const real = tempConfigPath()
    fs.writeFileSync(real, '{}')
    const link = path.join(path.dirname(real), 'linked.json')
    fs.symlinkSync(real, link)
    const viaReal = createStoreWriteLock(real)
    const viaLink = createStoreWriteLock(link, { timeoutMs: 20 })

    let refused: unknown
    viaReal(() => {
      try {
        viaLink(() => 'ran')
      } catch (err) {
        refused = err
      }
    })

    expect(refused).toBeInstanceOf(StoreLockError)
  })

  it('leaves a lock it no longer owns in place on release', () => {
    // If this holder's lock was broken as abandoned and someone else took the slot, unlinking on release
    // would remove the other holder's lock mid-write.
    const filePath = tempConfigPath()
    const lock = createStoreWriteLock(filePath)

    lock(() => {
      fs.writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: LIVE_OTHER_PID, host: os.hostname(), nonce: 'other' }))
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

  it.skipIf(process.platform === 'win32')('writes through a symlink instead of replacing it', () => {
    // A rename over the link would turn a shared config into a private copy, silently forking it.
    const real = tempConfigPath()
    fs.writeFileSync(real, '{"theme":"light"}')
    const link = path.join(path.dirname(real), 'linked.json')
    fs.symlinkSync(real, link)

    writeStoreFileAtomic(link, '{"theme":"dark"}')

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf-8')).toBe('{"theme":"dark"}')
  })

  it.skipIf(process.platform === 'win32')('creates the target of a dangling symlink, as an in-place write would', () => {
    const dir = path.dirname(tempConfigPath())
    const link = path.join(dir, 'linked.json')
    fs.symlinkSync(path.join(dir, 'real.json'), link)

    writeStoreFileAtomic(link, '{}')

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'real.json'), 'utf-8')).toBe('{}')
  })

  it.skipIf(typeof process.getuid !== 'function' || process.getuid() !== 0)(
    "keeps the file's owner when root writes it",
    () => {
      // One `sudo mao …` used to leave an operator's own token file root-owned and unreadable to them.
      const filePath = tempConfigPath()
      fs.writeFileSync(filePath, '{}')
      fs.chownSync(filePath, 1234, 1234)

      writeStoreFileAtomic(filePath, '{"theme":"dark"}')

      expect(fs.statSync(filePath).uid).toBe(1234)
      expect(fs.statSync(filePath).gid).toBe(1234)
    },
  )

  it.skipIf(process.platform === 'win32')('follows a chain of dangling links to the file at its end', () => {
    const dir = path.dirname(tempConfigPath())
    fs.symlinkSync(path.join(dir, 'middle.json'), path.join(dir, 'first.json'))
    fs.symlinkSync(path.join(dir, 'real.json'), path.join(dir, 'middle.json'))

    writeStoreFileAtomic(path.join(dir, 'first.json'), '{}')

    expect(fs.readFileSync(path.join(dir, 'real.json'), 'utf-8')).toBe('{}')
    expect(fs.lstatSync(path.join(dir, 'first.json')).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(dir, 'middle.json')).isSymbolicLink()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')("resolves a dangling link's '..' from the directory's real location", () => {
    // The data dir is reached through a link; its config is a relative link not yet created. Reads follow
    // the kernel's resolution, so the write must land exactly where they will look.
    const root = path.dirname(tempConfigPath())
    const realDir = path.join(root, 'x', 'y')
    fs.mkdirSync(realDir, { recursive: true })
    fs.mkdirSync(path.join(root, 'x', 'shared'))
    const linkDir = path.join(root, 'link-dir')
    fs.symlinkSync(realDir, linkDir)
    fs.symlinkSync(path.join('..', 'shared', 'config.json'), path.join(realDir, 'config.json'))

    writeStoreFileAtomic(path.join(linkDir, 'config.json'), '{"theme":"dark"}')

    expect(fs.readFileSync(path.join(linkDir, 'config.json'), 'utf-8')).toBe('{"theme":"dark"}')
    expect(fs.readFileSync(path.join(root, 'x', 'shared', 'config.json'), 'utf-8')).toBe('{"theme":"dark"}')
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
