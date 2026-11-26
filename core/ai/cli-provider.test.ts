import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliProvider } from './cli-provider.ts'

describe('CliProvider', () => {
  it('sends the saved Codex reasoning verbatim through the config flag', async () => {
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
        '--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort=ultra',
      ])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['agy', 'gemini-2.5-flash', 'high', ['--model', 'gemini-2.5-flash', '--effort', 'high']],
    ['claude', 'private-model', 'ultracode', ['--model', 'private-model', '--effort', 'ultracode']],
    ['claude', 'private-model', 'extra high', ['--model', 'private-model', '--effort', 'extra high']],
    ['custom-cli', 'private-model', 'ultra', ['--model', 'private-model', '--effort', 'ultra']],
  ] as const)('preserves saved configuration for %s using %s and %s', async (name, model, effort, expected) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-provider-flags-'))
    try {
      const command = path.join(directory, name)
      fs.symlinkSync(process.execPath, command)
      const provider = new CliProvider({
        id: name, name, kind: 'cli', command,
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--'],
        model, effort,
      })
      expect(JSON.parse(await provider.run('prompt', { allowToolUse: true }))).toEqual([
        ...expected, ...(name === 'claude' ? ['--dangerously-skip-permissions'] : []),
      ])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['claude-3-5-haiku', 'claude-haiku-4-5', 'haiku'])('omits unsupported effort for a saved %s provider', async (model) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-haiku-flags-'))
    try {
      const command = path.join(directory, 'claude')
      fs.symlinkSync(process.execPath, command)
      const provider = new CliProvider({
        id: 'haiku', name: 'Haiku', kind: 'cli', command,
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--'],
        model, effort: 'high',
      })
      expect(JSON.parse(await provider.run('prompt', { allowToolUse: true }))).toEqual([
        '--model', model, '--dangerously-skip-permissions',
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
