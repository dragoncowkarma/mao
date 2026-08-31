import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSwarmArgs,
  resolveGitCheckoutRoot,
  resolveRuntimeDirectory,
  resolveSwarmScriptPath,
  runSwarm,
} from './swarm-runner.ts'

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

describe('resolveSwarmScriptPath', () => {
  it('resolves a symlinked CLI entry to the real bundle directory', () => {
    const { repoRoot } = makeCheckout()
    const runtimeDirectory = path.join(repoRoot, 'dist-cli')
    const binDirectory = path.join(repoRoot, 'bin')
    fs.mkdirSync(runtimeDirectory)
    fs.mkdirSync(binDirectory)
    const entryPath = path.join(runtimeDirectory, 'index.cjs')
    const symlinkPath = path.join(binDirectory, 'mao')
    fs.writeFileSync(entryPath, '# bundled CLI\n')
    fs.symlinkSync(entryPath, symlinkPath)

    expect(resolveRuntimeDirectory(symlinkPath, null)).toBe(fs.realpathSync.native(runtimeDirectory))
  })

  it('uses the CommonJS module directory when the bundle provides it', () => {
    expect(resolveRuntimeDirectory('/ignored/bin/mao', '/real/dist-cli')).toBe('/real/dist-cli')
  })

  it('resolves the asset beside the real CLI bundle directory', () => {
    const { repoRoot } = makeCheckout()
    const runtimeDirectory = path.join(repoRoot, 'dist-cli')
    fs.mkdirSync(runtimeDirectory)
    const assetPath = path.join(runtimeDirectory, 'swarm_orchestrator.py')
    fs.writeFileSync(assetPath, '# bundled asset\n')

    expect(resolveSwarmScriptPath(runtimeDirectory)).toBe(assetPath)
  })
})

describe('resolveGitCheckoutRoot', () => {
  it('resolves a nested path to its containing checkout', () => {
    const { repoRoot } = makeCheckout()
    const nestedPath = path.join(repoRoot, 'packages', 'example')
    fs.mkdirSync(nestedPath, { recursive: true })

    expect(resolveGitCheckoutRoot(nestedPath)).toBe(fs.realpathSync.native(repoRoot))
  })
})

describe('runSwarm', () => {
  it('launches Python shell-free in the selected repository and forwards its exit code', async () => {
    const { repoRoot, scriptPath } = makeCheckout()
    const nestedPath = path.join(repoRoot, 'packages', 'example')
    const canonicalRepoRoot = fs.realpathSync.native(repoRoot)
    fs.mkdirSync(nestedPath, { recursive: true })
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
        { repoRoot: nestedPath, interval: 15, dryRun: true, once: true },
        { scriptPath, pythonCommand: 'python-test', spawnProcess },
      ),
    ).resolves.toBe(0)

    expect(invocation).toMatchObject({
      command: 'python-test',
      args: [scriptPath, '--interval', '15', '--dry-run', '--once'],
      options: {
        cwd: canonicalRepoRoot,
        shell: false,
        stdio: 'inherit',
      },
    })
    expect(invocation?.options.env).toMatchObject({ MAO_SWARM_REPO_ROOT: canonicalRepoRoot })
  })

  it('fails before spawning when the selected directory is not a Git checkout', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-swarm-runner-'))
    tmpDirs.push(repoRoot)
    const scriptPath = path.join(repoRoot, 'swarm.py')
    fs.writeFileSync(scriptPath, '# test asset\n')

    await expect(runSwarm({ repoRoot }, { scriptPath })).rejects.toThrow(/not inside a Git checkout/)
  })
})
