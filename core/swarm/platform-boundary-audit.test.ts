import { describe, expect, it, vi } from 'vitest'
import { SwarmPlatform } from './platform.ts'
import type { CommandRunner, RepoTarget } from './platform.ts'

describe('independent origin identity and SSH endpoint guards (#64)', () => {
  it('checks host identity independently of endpoint metadata returned by the resolver', async () => {
    const run = vi.fn<CommandRunner>()
    const platform = new SwarmPlatform('/repo', { run, env: {} })
    const target: RepoTarget = {
      host: 'github.com', owner: 'acme', repo: 'widgets', https: 'https://github.com:443',
    }
    platform.target = target
    platform.repo = 'acme/widgets'
    // Pin the independent host guard even if endpoint resolution acquires new equivalences later.
    // A resolver cannot authorize a different API host by retaining old transport metadata.
    vi.spyOn(platform, 'resolveOrigin').mockResolvedValue({ ...target, host: 'other.example' })
    await expect(platform.prepareDispatch('/worker', 'worker/1-task')).rejects.toThrow('differs from startup')
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['evilgithub.com', 'notgithub.com'])('refuses the github.com suffix lookalike %s on port 443', async (host) => {
    const run: CommandRunner = async (command) => command === 'ssh'
      ? { code: 0, stdout: `hostname ${host}\nuser git\nport 443\n`, stderr: '' }
      : { code: 1, stdout: '', stderr: '' }
    const platform = new SwarmPlatform('/repo', { run, env: {} })
    await expect(platform.parseRemote('git@alias:acme/widgets')).rejects.toThrow('Non-standard SSH endpoint')
  })
})
