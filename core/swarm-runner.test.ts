import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveGitCheckoutRoot, runSwarm, SwarmRepositoryPathError } from './swarm-runner.ts'
import { runSwarmEngine } from './swarm/engine.ts'

vi.mock('./swarm/engine.ts', () => ({ runSwarmEngine: vi.fn(async () => 0) }))
const dirs: string[] = []
function checkout(marker: 'directory' | 'file' = 'directory') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-swarm-'))
  dirs.push(root)
  if (marker === 'directory') fs.mkdirSync(path.join(root, '.git'))
  else fs.writeFileSync(path.join(root, '.git'), 'gitdir: /somewhere')
  return root
}
afterEach(() => {
  vi.clearAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
describe('native swarm runner', () => {
  it.each(['directory', 'file'] as const)('resolves nested checkout with %s marker', (marker) => {
    const root = checkout(marker)
    const nested = path.join(root, 'nested')
    fs.mkdirSync(nested)
    expect(resolveGitCheckoutRoot(nested)).toBe(fs.realpathSync(root))
  })
  it('reports missing and non-checkout paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-no-checkout-'))
    dirs.push(root)
    expect(() => resolveGitCheckoutRoot(root)).toThrow(SwarmRepositoryPathError)
    expect(() => resolveGitCheckoutRoot(path.join(root, 'absent'))).toThrow(/does not exist/)
  })
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid interval %s before starting', async (interval) => {
    await expect(runSwarm({ interval })).rejects.toThrow(/positive integer/)
    expect(runSwarmEngine).not.toHaveBeenCalled()
  })
  it('delegates every mode directly to the native engine and returns its exit status', async () => {
    const root = checkout()
    vi.mocked(runSwarmEngine).mockResolvedValueOnce(143)
    const opts = { repoRoot: root, status: true, reset: true, dryRun: true, once: true, interval: 15 }
    expect(await runSwarm(opts)).toBe(143)
    expect(runSwarmEngine).toHaveBeenCalledWith(fs.realpathSync(root), opts)
  })
})
