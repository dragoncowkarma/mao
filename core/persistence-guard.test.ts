import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearPersistenceBrokenMarker,
  hasPersistenceBrokenMarker,
  writePersistenceBrokenMarker,
} from './persistence-guard.ts'

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
})
