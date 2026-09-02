import { describe, expect, it } from 'vitest'
import { CliProvider } from './cli-provider.ts'

describe('CliProvider', () => {
  it('throws an error synchronously when command is not configured', () => {
    const provider = new CliProvider({
      id: 'test-cli',
      name: 'Test CLI',
      kind: 'cli',
    })

    expect(() => provider.run('hello')).toThrow(/CLI command is not set/)
  })

  it('rejects the promise cleanly instead of crashing the process when stdin write encounters EPIPE', async () => {
    // Spawn a node child process that exits immediately without reading stdin.
    // When a large payload is written to stdin, Node emits an EPIPE error on child.stdin.
    const provider = new CliProvider({
      id: 'test-cli',
      name: 'Test CLI',
      kind: 'cli',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    })

    const largePrompt = 'a'.repeat(2 * 1024 * 1024)

    // Should reject (either with EPIPE or process exit code depending on race), but never crash the process with an unhandled stream error
    let rejectedError: unknown
    try {
      await provider.run(largePrompt)
    } catch (err) {
      rejectedError = err
    }

    expect(rejectedError).toBeDefined()
    expect(rejectedError).toBeInstanceOf(Error)
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
