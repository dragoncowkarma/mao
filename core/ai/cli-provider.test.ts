import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliProvider } from './cli-provider.ts'

describe('CliProvider', () => {
  it('sends Codex reasoning explicitly through the shared config flag builder', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-codex-flags-'))
    try {
      const command = path.join(directory, 'codex')
      fs.symlinkSync(process.execPath, command)
      const provider = new CliProvider({
        id: 'codex', name: 'Codex', kind: 'cli', command,
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--'],
        model: 'gpt-5.6-luna', effort: 'ultra',
      })
      expect(JSON.parse(await provider.run('prompt'))).toEqual([
        '--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort=max',
      ])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('throws an error synchronously when command is not configured', () => {
    const provider = new CliProvider({
      id: 'test-cli',
      name: 'Test CLI',
      kind: 'cli',
    })

    expect(() => provider.run('hello')).toThrow(/CLI command is not set/)
  })

  it('rejects the promise cleanly with EPIPE when stdin write encounters a closed pipe', async () => {
    // Spawn a process that exits immediately without consuming stdin.
    // Writing a 1MB payload to a closed stdin pipe reliably emits EPIPE on child.stdin
    // before the process exit event can settle the run() promise.
    const provider = new CliProvider({
      id: 'test-cli',
      name: 'Test CLI',
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    })

    const largePrompt = 'a'.repeat(1024 * 1024)

    const runPromise = provider.run(largePrompt)
    await expect(runPromise).rejects.toThrow(/EPIPE/)
    await expect(runPromise).rejects.toMatchObject({ code: 'EPIPE' })
  })

  it('resolves standard output when the CLI command succeeds', async () => {
    const provider = new CliProvider({
      id: 'test-cli',
      name: 'Test CLI',
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("success output")'],
    })

    const result = await provider.run('input prompt')
    expect(result).toBe('success output')
  })

  it('rejects with non-zero exit code and stderr when the CLI fails', async () => {
    const provider = new CliProvider({
      id: 'test-cli',
      name: 'Test CLI',
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("failure details"); process.exit(42)'],
    })

    await expect(provider.run('input prompt')).rejects.toThrow(/CLI exited with code 42: failure details/)
  })
})
