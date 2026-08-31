import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSwarmArgs, runSwarm } from './swarm-runner.ts'

const tmpDirs: string[] = []

function makeCheckout(): { repoRoot: string; scriptPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-swarm-runner-'))
  tmpDirs.push(repoRoot)
  fs.mkdirSync(path.join(repoRoot, '.git'))
  const scriptPath = path.join(repoRoot, 'swarm.py')
  fs.writeFileSync(scriptPath, '# test asset\n')
  return { repoRoot, scriptPath }
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('buildSwarmArgs', () => {
  it('maps every supported CLI option to a fixed argv element', () => {
    expect(
      buildSwarmArgs('/tmp/swarm.py', {
        interval: 45,
        dryRun: true,
        once: true,
        status: true,
        reset: true,
      }),
    ).toEqual(['/tmp/swarm.py', '--interval', '45', '--dry-run', '--once', '--status', '--reset'])
  })

  it('rejects intervals that would make the polling loop invalid', () => {
    expect(() => buildSwarmArgs('/tmp/swarm.py', { interval: 0 })).toThrow(/positive integer/)
    expect(() => buildSwarmArgs('/tmp/swarm.py', { interval: 1.5 })).toThrow(/positive integer/)
  })
})

describe('runSwarm', () => {
  it('launches Python shell-free in the selected repository and forwards its exit code', async () => {
    const { repoRoot, scriptPath } = makeCheckout()
    let invocation:
      | { command: string; args: string[]; options: SpawnOptions }
      | undefined

    const spawnProcess = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
      invocation = { command, args, options }
      const child = new EventEmitter() as ChildProcess
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    }

    await expect(
      runSwarm(
        { repoRoot, interval: 15, dryRun: true, once: true },
        { scriptPath, pythonCommand: 'python-test', spawnProcess },
      ),
    ).resolves.toBe(0)

    expect(invocation).toMatchObject({
      command: 'python-test',
      args: [scriptPath, '--interval', '15', '--dry-run', '--once'],
      options: {
        cwd: repoRoot,
        shell: false,
        stdio: 'inherit',
      },
    })
    expect(invocation?.options.env).toMatchObject({ MAO_SWARM_REPO_ROOT: repoRoot })
  })

  it('fails before spawning when the selected directory is not a Git checkout', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-swarm-runner-'))
    tmpDirs.push(repoRoot)
    const scriptPath = path.join(repoRoot, 'swarm.py')
    fs.writeFileSync(scriptPath, '# test asset\n')

    await expect(runSwarm({ repoRoot }, { scriptPath })).rejects.toThrow(/not a Git checkout/)
  })
})
