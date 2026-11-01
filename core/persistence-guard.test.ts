import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_WORKFLOW_MARKER_CLEAR_REFUSED,
  assertCanClearPersistenceBroken,
  clearPersistenceBrokenMarker,
  hasPersistenceBrokenMarker,
  writePersistenceBrokenMarker,
} from './persistence-guard.ts'
import type { QueuedTask } from './workflow-engine.ts'

const tmpDirs: string[] = []

function makeTmpDataDir(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-persistence-guard-test-'))
  tmpDirs.push(dataDir)
  return dataDir
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

describe('persistence-guard', () => {
  it('round-trips: absent, then present after write, then absent after clear', () => {
    const dataDir = makeTmpDataDir()
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)

    writePersistenceBrokenMarker(dataDir, new Error('disk full'))
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)

    expect(clearPersistenceBrokenMarker(dataDir)).toBe(true)
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(false)
  })

  it('clearPersistenceBrokenMarker() reports success when there was never a marker to begin with', () => {
    const dataDir = makeTmpDataDir()
    expect(clearPersistenceBrokenMarker(dataDir)).toBe(true)
  })

  it('clearPersistenceBrokenMarker() reports failure — not a false "cleared" — when the marker survives the removal attempt', () => {
    const dataDir = makeTmpDataDir()
    writePersistenceBrokenMarker(dataDir, new Error('disk full'))

    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    // The removal call itself may throw and be swallowed internally, but the marker is still on
    // disk afterward — clearPersistenceBrokenMarker() must reflect that real postcondition, not
    // report success just because rmSync's throw didn't propagate.
    expect(clearPersistenceBrokenMarker(dataDir)).toBe(false)

    vi.restoreAllMocks()
    expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
  })

  it('fails closed when presence cannot be established, rather than reading the marker as absent', () => {
    // existsSync answers false for *any* error, which made the catch in hasPersistenceBrokenMarker dead
    // code: a fresh process would then boot unblocked and resume the stale queue (issue #76).
    const dataDir = makeTmpDataDir()
    for (const code of ['EACCES', 'EIO']) {
      vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
        throw Object.assign(new Error(`${code}: cannot check`), { code })
      })
      expect(hasPersistenceBrokenMarker(dataDir), code).toBe(true)
      // The clear reports its postcondition through the same check, so it must not claim success either.
      expect(clearPersistenceBrokenMarker(dataDir), code).toBe(false)
      vi.restoreAllMocks()
    }
    // A missing data directory is a fresh install, not an unanswerable check.
    expect(hasPersistenceBrokenMarker(path.join(dataDir, 'not-created-yet'))).toBe(false)
  })

  // The mocked case above proves the catch is reachable; this proves a real permission failure reaches it.
  // POSIX permission bits only, and root ignores them.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails closed for a data directory this process may not search',
    () => {
      const dataDir = makeTmpDataDir()
      writePersistenceBrokenMarker(dataDir, new Error('disk full'))
      fs.chmodSync(dataDir, 0o600)
      try {
        expect(fs.existsSync(path.join(dataDir, 'workflow-persistence-broken.marker'))).toBe(false)
        expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)
        expect(clearPersistenceBrokenMarker(dataDir)).toBe(false)
      } finally {
        fs.chmodSync(dataDir, 0o700)
      }
    },
  )

  it('reads a data directory that is a file as holding no marker, because none can exist beneath it', () => {
    // ENOTDIR proves absence. Failing closed here would tell the operator to reconcile GitHub and clear a
    // marker that cannot be cleared, while the store's own whole-file report names the real fault.
    const dataDir = makeTmpDataDir()
    const notADirectory = path.join(dataDir, 'config.json')
    fs.writeFileSync(notADirectory, '{}')

    expect(hasPersistenceBrokenMarker(notADirectory)).toBe(false)
  })

  // Creating a symlink needs a privilege Windows withholds by default; the EACCES/EIO case above already
  // covers the fail-closed rule there.
  it.skipIf(process.platform === 'win32')(
    'counts a marker that is a dangling symlink as present, and clears the link itself',
    () => {
      const dataDir = makeTmpDataDir()
      const marker = path.join(dataDir, 'workflow-persistence-broken.marker')
      fs.symlinkSync(path.join(dataDir, 'nowhere'), marker)

      expect(fs.existsSync(marker)).toBe(false)
      expect(hasPersistenceBrokenMarker(dataDir)).toBe(true)

      expect(clearPersistenceBrokenMarker(dataDir)).toBe(true)
      expect(fs.lstatSync(marker, { throwIfNoEntry: false })).toBeUndefined()
    },
  )

  it('refuses to clear while this process still has an active workflow stage', () => {
    const running = {
      id: 'running',
      title: 'Running task',
      repo: { owner: 'acme', repo: 'widgets' },
      stage: 'pr',
      history: [],
      status: 'running',
      autoAdvance: true,
      github: {},
    } satisfies QueuedTask

    expect(() => assertCanClearPersistenceBroken([running])).toThrow(
      ACTIVE_WORKFLOW_MARKER_CLEAR_REFUSED,
    )
    expect(() => assertCanClearPersistenceBroken([{ ...running, status: 'pending' }])).not.toThrow()
  })
})
