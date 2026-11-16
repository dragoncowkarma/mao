import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, type execFile } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SwarmPlatform, SwarmPreflightConfigError, SwarmPreflightTransientError, createCommandRunner,
  parseApiResponse, parseWorktrees, isTrustedComment, type CommandRunner, type CommandResult,
} from './platform.ts'

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const missing = (): CommandResult => ({ code: 1, stdout: '', stderr: '' })
const envelope = (body: unknown, status = 200, headers = '') =>
  `HTTP/2.0 ${status} OK\r\n${headers}\r\n\r\n${JSON.stringify(body)}`
function fixture(options: {
  fetch?: string[]; push?: string[]; ssh?: string; snapshot?: unknown; response?: CommandResult
  config?: Record<string, string>; env?: NodeJS.ProcessEnv; branch?: string
} = {}) {
  const calls: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = []
  const run: CommandRunner = async (command, args, cwd, env) => {
    calls.push({ command, args, cwd, env })
    if (command === 'ssh') return ok(options.ssh ?? 'hostname github.com\nuser git\nport 22\n')
    if (command === 'gh') return options.response ?? ok(envelope(options.snapshot ?? {
      full_name: 'acme/widgets', permissions: { push: true },
    }))
    if (args[0] === 'remote') return ok((args.includes('--push') ? options.push : options.fetch)?.join('\n') ??
      'https://github.com/acme/widgets.git\n')
    if (args[0] === 'symbolic-ref') return options.branch === '' ? missing() : ok(options.branch ?? 'main\n')
    if (args[0] === 'config') {
      const value = options.config?.[args.at(-1)!]
      return value === undefined ? missing() : ok(value)
    }
    return ok()
  }
  return { platform: new SwarmPlatform('/repo', { run, env: options.env ?? {} }), calls }
}

describe('Swarm origin and credential binding', () => {
  it.each([
    'http://github.com/acme/widgets.git', 'https://github.com:8443/acme/widgets',
    'https://github.com/acme/widgets?', 'https://github.com/acme/widgets#',
    'https://github.com/acme/widgets/extra', 'https://github.com//acme/widgets',
    ' git@github.com:acme/widgets', 'git@github.com:/acme/widgets',
    'file:///acme/widgets', 'https://evil.example/github.com/acme/widgets',
  ])('refuses unsupported remote syntax without exposing the value: %s', async (remote) => {
    const { platform } = fixture()
    await expect(platform.parseRemote(remote)).rejects.toThrow(SwarmPreflightConfigError)
  })
  it('rejects a divergent second push URL', async () => {
    const { platform, calls } = fixture({ push: [
      'https://github.com/acme/widgets', 'https://github.com/other/widgets',
    ] })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow('different repositories')
    expect(calls.some(({ command }) => command === 'gh')).toBe(false)
  })
  it('reads the complete API body and passes three-state permissions through shared core policy', async () => {
    const { platform, calls } = fixture({ snapshot: { full_name: 'acme/widgets', permissions: { push: 'true' } } })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow('permissions block')
    const probe = calls.find(({ command }) => command === 'gh')!
    expect(probe.args).toEqual(['api', '--include', '--method', 'GET', 'repos/{owner}/{repo}'])
    expect(probe.env).toMatchObject({ GH_HOST: 'github.com', GH_REPO: 'github.com/acme/widgets' })
  })
  it.each([
    [{ archived: true, permissions: { push: true } }, 'archived'],
    [{ disabled: true, permissions: { push: true } }, 'disabled'],
    [{ has_issues: false, permissions: { push: true } }, 'Issues feature'],
    [{ permissions: { push: false } }, 'read-only'],
    [{ permissions: null }, 'permissions block'],
    [{ permissions: { push: null } }, 'permissions block'],
  ])('preserves negative shared capability verdict %#', async (snapshot, reason) => {
    const { platform } = fixture({ snapshot: { full_name: 'acme/widgets', ...snapshot } })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow(reason)
  })
  it('honors private classic-token scope restrictions', async () => {
    const { platform } = fixture({ response: ok(envelope({
      full_name: 'acme/widgets', private: true, permissions: { push: true },
    }, 200, 'x-oauth-scopes: public_repo')) })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow('classic token')
  })
  it.each([401, 404, 451])('reports definitive HTTP %s failures', async (status) => {
    const { platform } = fixture({ response: { code: 1, stdout: envelope({}, status), stderr: '' } })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow(SwarmPreflightConfigError)
  })
  it.each([403, 429, 500])('keeps HTTP %s inconclusive failures transient', async (status) => {
    const { platform } = fixture({ response: { code: 1, stdout: envelope({}, status), stderr: 'secret-value' } })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow(SwarmPreflightTransientError)
  })
  it('keeps a rate-limited resource error transient', async () => {
    const { platform } = fixture({ response: { code: 1, stdout: envelope({
      message: 'Resource not accessible by integration',
    }, 403, 'x-ratelimit-remaining: 0'), stderr: '' } })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow(SwarmPreflightTransientError)
  })
  it('rejects mismatched API identity', async () => {
    const { platform } = fixture({ snapshot: { full_name: 'other/widgets', permissions: { push: true } } })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow('identity differs')
  })
  it('dry run binds origin without a capability probe', async () => {
    const { platform, calls } = fixture({ env: { GH_REPO: 'other/repo', GH_HOST: 'evil.example' } })
    await platform.bindOrigin(false)
    expect(calls.some(({ command }) => command === 'gh')).toBe(false)
    expect(platform.boundEnvironment()).toMatchObject({ GH_HOST: 'github.com', GH_REPO: 'github.com/acme/widgets' })
  })
  it('resolves the documented alternate SSH endpoint', async () => {
    const { platform } = fixture({ ssh: 'hostname ssh.github.com\nuser git\nport 443\n' })
    expect(await platform.parseRemote('git@alias:acme/widgets.git')).toMatchObject({
      host: 'github.com', ssh: 'git@github.com:22', owner: 'acme', repo: 'widgets',
    })
  })
  it.each(['proxycommand malicious command', 'proxyjump proxy.example', 'port 2222', 'user other'])
  ('rejects unprovable SSH transport %s', async (setting) => {
    const { platform } = fixture({ ssh: `hostname github.com\nuser git\nport 22\n${setting}\n` })
    await expect(platform.parseRemote('git@github.com:acme/widgets')).rejects.toThrow(SwarmPreflightConfigError)
  })
  it.each([{ GIT_SSH: '/custom' }, { GIT_SSH_COMMAND: 'custom ssh' }])('rejects custom SSH transport %#', async (env) => {
    const { platform } = fixture({ env })
    await expect(platform.parseRemote('git@github.com:acme/widgets')).rejects.toThrow('Custom SSH')
  })
  it('rejects configured SSH command', async () => {
    const { platform } = fixture({ config: { 'core.sshCommand': 'custom ssh' } })
    await expect(platform.parseRemote('git@github.com:acme/widgets')).rejects.toThrow('core.sshCommand')
  })
  it('rejects command-scope configuration parameters before probing', async () => {
    const { platform, calls } = fixture({ env: { GIT_CONFIG_PARAMETERS: "'remote.pushDefault=other'" } })
    await expect(platform.bindOrigin()).rejects.toThrow('GIT_CONFIG_PARAMETERS')
    expect(calls).toHaveLength(0)
  })
  it('pins highest-precedence selectors while preserving credential environment', async () => {
    const { platform } = fixture({ env: { GH_TOKEN: 'private-value', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.pushDefault', GIT_CONFIG_VALUE_0: 'other' } })
    await platform.bindOrigin(false)
    const env = await platform.prepareDispatch('/repo')
    expect(env).toMatchObject({ GH_TOKEN: 'private-value', GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_1: 'remote.pushDefault', GIT_CONFIG_VALUE_1: 'origin',
      GIT_CONFIG_KEY_2: 'branch.main.pushRemote', GIT_CONFIG_VALUE_2: 'origin',
      GIT_CONFIG_KEY_3: 'branch.main.remote', GIT_CONFIG_VALUE_3: 'origin' })
  })
  it.each(['local', 'worktree'])('rejects effective %s push selector override', async (scope) => {
    const { platform } = fixture({ config: { 'remote.pushDefault': `${scope}\tother\n` } })
    await platform.bindOrigin(false)
    await expect(platform.prepareDispatch('/repo')).rejects.toThrow('other than origin')
  })
  it('allows global selectors because child command scope overrides them', async () => {
    const { platform } = fixture({ config: { 'remote.pushDefault': 'global\tother\n' } })
    await platform.bindOrigin(false)
    expect((await platform.prepareDispatch('/repo')).GIT_CONFIG_VALUE_0).toBe('origin')
  })
  it('permits detached repository-root checker but refuses detached worker', async () => {
    const { platform } = fixture({ branch: '' })
    await platform.bindOrigin(false)
    await expect(platform.prepareDispatch('/repo')).resolves.toMatchObject({ GIT_CONFIG_COUNT: '1' })
    await expect(platform.prepareDispatch('/worker', 'worker/1-task')).rejects.toThrow('expected branch')
  })
})

describe('parser and comment trust boundaries', () => {
  it.each(['[]', 'null', '{broken', 'HTTP/2 200 OK\n\n[]'])('fails closed on malformed HTTP envelope %s', (raw) => {
    expect(() => parseApiResponse(raw)).toThrow(SwarmPreflightTransientError)
  })
  it('retains complete body fields and lowercases headers', () => {
    expect(parseApiResponse(envelope({ full_name: 'acme/widgets', nested: { data: true } }, 200,
      'X-OAuth-Scopes: repo'))).toMatchObject({ headers: { 'x-oauth-scopes': 'repo' },
      body: { full_name: 'acme/widgets', nested: { data: true } } })
  })
  it('parses paths with spaces from authoritative porcelain', () => {
    expect(parseWorktrees('worktree /repo path\nHEAD abc\nbranch refs/heads/main\n\n')).toEqual([
      { worktree: '/repo path', HEAD: 'abc', branch: 'refs/heads/main' },
    ])
  })
  it('requires a trusted association or current authenticated login', () => {
    expect(isTrustedComment({ author: { login: 'other' } }, 'me')).toBe(false)
    expect(isTrustedComment({ author: { login: 'me' } }, 'me')).toBe(true)
    expect(isTrustedComment({ author: { login: 'other' }, authorAssociation: 'MEMBER' }, 'me')).toBe(true)
    expect(isTrustedComment({ authorAssociation: 'OWNER' }, 'me')).toBe(false)
    expect(isTrustedComment({ author: null, authorAssociation: 'OWNER' }, 'me')).toBe(false)
    expect(isTrustedComment({ author: { login: '' }, authorAssociation: 'OWNER' }, 'me')).toBe(false)
    expect(isTrustedComment({ author: { login: 'other' }, authorAssociation: 'OWNER' }, '')).toBe(false)
    expect(isTrustedComment({ author: { login: 'other' }, authorAssociation: 'CONTRIBUTOR' }, 'me')).toBe(false)
  })
})

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })) })
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-platform-'))
  roots.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  fs.writeFileSync(path.join(root, 'tracked'), 'initial\n')
  git('add', 'tracked'); git('commit', '-m', 'Initial')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  return { root, git, platform: new SwarmPlatform(root, { env: { ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }) }
}
describe('real Git worktree preservation', () => {
  it('reuses the registered task checkout and preserves untracked files', async () => {
    const { root, platform } = repository()
    const checkout = await platform.createWorktree(1, 'worker/1-task')
    fs.writeFileSync(path.join(checkout, 'untracked'), 'keep')
    expect(await platform.createWorktree(1, 'worker/1-task')).toBe(checkout)
    expect(fs.readFileSync(path.join(root, '.worktrees/1/untracked'), 'utf8')).toBe('keep')
  })
  it('preserves a nonempty unregistered directory', async () => {
    const { root, platform } = repository()
    fs.mkdirSync(path.join(root, '.worktrees/1'), { recursive: true })
    fs.writeFileSync(path.join(root, '.worktrees/1/preserve'), 'keep')
    await expect(platform.createWorktree(1, 'worker/1-task')).rejects.toThrow('preserved')
    expect(fs.readFileSync(path.join(root, '.worktrees/1/preserve'), 'utf8')).toBe('keep')
  })
  it('refuses duplicate branch ownership in a different checkout', async () => {
    const { root, git, platform } = repository()
    const alternate = path.join(root, 'alternate')
    git('worktree', 'add', '-b', 'worker/1-task', alternate, 'main')
    await expect(platform.createWorktree(1, 'worker/1-task')).rejects.toThrow('already checked out')
    expect(fs.existsSync(path.join(alternate, '.git'))).toBe(true)
  })
  it('fast forwards only to the provided verified revision head', async () => {
    const { root, git, platform } = repository()
    const checkout = await platform.createWorktree(1, 'worker/1-task')
    fs.writeFileSync(path.join(root, 'new-file'), 'remote change')
    git('add', 'new-file'); git('commit', '-m', 'Remote update')
    const head = git('rev-parse', 'HEAD')
    await platform.createWorktree(1, 'worker/1-task', head)
    expect(fs.readFileSync(path.join(checkout, 'new-file'), 'utf8')).toBe('remote change')
  })
  it('preserves tracked changes when revision branch trails head', async () => {
    const { root, git, platform } = repository()
    const checkout = await platform.createWorktree(1, 'worker/1-task')
    fs.writeFileSync(path.join(checkout, 'tracked'), 'local edits')
    fs.writeFileSync(path.join(root, 'new-file'), 'remote change')
    git('add', 'new-file'); git('commit', '-m', 'Remote update')
    await expect(platform.createWorktree(1, 'worker/1-task', git('rev-parse', 'HEAD'))).rejects.toThrow('tracked changes')
    expect(fs.readFileSync(path.join(checkout, 'tracked'), 'utf8')).toBe('local edits')
  })
  it('preserves a conflicting ignored file during fast forward', async () => {
    const { root, git, platform } = repository()
    fs.writeFileSync(path.join(root, '.gitignore'), 'conflict\n')
    git('add', '.gitignore'); git('commit', '-m', 'Ignore conflict')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    const checkout = await platform.createWorktree(1, 'worker/1-task')
    fs.writeFileSync(path.join(checkout, 'conflict'), 'local ignored value')
    fs.writeFileSync(path.join(root, 'conflict'), 'remote tracked value')
    git('add', '-f', 'conflict'); git('commit', '-m', 'Track conflict')
    await expect(platform.createWorktree(1, 'worker/1-task', git('rev-parse', 'HEAD'))).rejects.toThrow()
    expect(fs.readFileSync(path.join(checkout, 'conflict'), 'utf8')).toBe('local ignored value')
  })
  it('removes a clean merged branch at an alternate registered path', async () => {
    const { root, git, platform } = repository()
    const alternate = path.join(root, 'alternate')
    git('worktree', 'add', '-b', 'worker/1-task', alternate, 'main')
    await platform.cleanupWorktree(1, 'worker/1-task')
    expect(fs.existsSync(alternate)).toBe(false)
    expect(() => git('show-ref', '--verify', 'refs/heads/worker/1-task')).toThrow()
  })
  it('preserves dirty alternate worktrees and unexpected branch names', async () => {
    const { root, git, platform } = repository()
    const alternate = path.join(root, 'alternate')
    git('worktree', 'add', '-b', 'worker/1-task', alternate, 'main')
    fs.writeFileSync(path.join(alternate, 'untracked'), 'keep')
    await platform.cleanupWorktree(1, 'worker/1-task')
    expect(fs.existsSync(alternate)).toBe(true)
    await platform.cleanupWorktree(1, 'main')
    expect(git('branch', '--show-current')).toBe('main')
  })
})

describe('dispatch revalidation and immutable revision boundaries', () => {
  it('does not normalize suspicious whitespace away from effective remote URLs', async () => {
    const { platform } = fixture({ fetch: [' https://github.com/acme/widgets'] })
    await expect(platform.bindOrigin().then(() => platform.assertRepoWritable())).rejects.toThrow(SwarmPreflightConfigError)
  })
  it('refuses dot-segment remote paths before URL normalization', async () => {
    const { platform } = fixture()
    await expect(platform.parseRemote('https://github.com/acme/../acme/widgets')).rejects.toThrow()
    await expect(platform.parseRemote('https://github.com/acme\\widgets')).rejects.toThrow()
  })
  it('rechecks origin after binding at the dispatch boundary', async () => {
    const fetch = ['https://github.com/acme/widgets']
    const { platform } = fixture({ fetch })
    await platform.bindOrigin(false)
    fetch[0] = 'https://github.com/other/widgets'
    await expect(platform.prepareDispatch('/repo')).rejects.toThrow()
  })
  it('fetches only the numbered PR ref and verifies FETCH_HEAD', async () => {
    const head = 'a'.repeat(40)
    const calls: string[][] = []
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args)
      if (args[0] === 'remote') return ok('https://github.com/acme/widgets\n')
      if (args[0] === 'config') return missing()
      if (args[0] === 'symbolic-ref') return ok('main\n')
      if (args[0] === 'rev-parse') return ok(head)
      return ok()
    }
    const platform = new SwarmPlatform('/repo', { run: runner, env: {} })
    await platform.bindOrigin(false)
    expect(await platform.fetchPrHead(5, head)).toBe(head)
    expect(calls).toContainEqual(['fetch', '--no-tags', 'origin', 'refs/pull/5/head'])
    await expect(platform.fetchPrHead(5, 'b'.repeat(40))).rejects.toThrow('head changed')
    expect(calls.some((args) => args[0] === 'branch')).toBe(false)
  })
  it('preserves worktree parent symlinks', async () => {
    const { root, platform } = repository()
    const external = path.join(root, 'external')
    fs.mkdirSync(external)
    fs.symlinkSync(external, path.join(root, '.worktrees'))
    await expect(platform.createWorktree(1, 'worker/1-task')).rejects.toThrow('symlinked')
    expect(fs.readdirSync(external)).toEqual([])
  })
  it('preserves ignored files during alternate-path cleanup', async () => {
    const { root, git, platform } = repository()
    const alternate = path.join(root, 'alternate')
    git('worktree', 'add', '-b', 'worker/1-task', alternate, 'main')
    fs.writeFileSync(path.join(root, '.git/info/exclude'), 'private-artifact\n')
    fs.writeFileSync(path.join(alternate, 'private-artifact'), 'keep')
    await platform.cleanupWorktree(1, 'worker/1-task')
    expect(fs.readFileSync(path.join(alternate, 'private-artifact'), 'utf8')).toBe('keep')
  })
})


describe('CLI independent hard deadline', () => {
  afterEach(() => vi.useRealTimers())
  it('rejects on schedule even when SIGKILL fails and the child never invokes its callback', async () => {
    vi.useFakeTimers()
    const kill = vi.fn(() => { throw new Error('OS kill denied') })
    const execute = vi.fn(() => ({ kill })) as unknown as typeof execFile
    const pending = createCommandRunner(execute, 1000)('git', ['status'], '/repo', {})
    const rejection = expect(pending).rejects.toMatchObject({ causeCode: 'command-timeout' })
    await vi.advanceTimersByTimeAsync(1000)
    await rejection
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(execute).toHaveBeenCalledWith('git', ['status'], expect.objectContaining({
      timeout: 1000, killSignal: 'SIGKILL', encoding: 'utf8',
    }), expect.any(Function))
  })
  it('clears the deadline after synchronous completion and ignores late callbacks', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    let callback: (error: null, stdout: string, stderr: string) => void = () => {}
    const execute = ((...args: unknown[]) => {
      callback = args[3] as typeof callback
      callback(null, 'done', '')
      return { kill }
    }) as unknown as typeof execFile
    expect(await createCommandRunner(execute, 1000)('git', [], '/repo', {})).toEqual(ok('done'))
    callback(null, 'late', '')
    await vi.advanceTimersByTimeAsync(1000)
    expect(kill).not.toHaveBeenCalled()
  })
  it('accepts a single trailing slash after repository identity, while refusing doubled separators', async () => {
    const { platform } = fixture()
    expect(await platform.parseRemote('https://github.com/acme/widgets.git/')).toMatchObject({ owner: 'acme', repo: 'widgets' })
    expect(await platform.parseRemote('git@github.com:acme/widgets.git/')).toMatchObject({ owner: 'acme', repo: 'widgets' })
    await expect(platform.parseRemote('https://github.com/acme/widgets.git//')).rejects.toThrow()
  })
})

describe('issue 64 checkout-specific dispatch contract', () => {
  function checkoutFixture(workerOrigin: string, config: Record<string, string> = {}) {
    const calls: { args: string[]; cwd: string }[] = []
    const run: CommandRunner = async (_command, args, cwd) => {
      calls.push({ args, cwd })
      if (args[0] === 'remote') return ok(cwd === '/worker' ? workerOrigin : 'https://github.com/acme/widgets')
      if (args[0] === 'symbolic-ref') return ok(cwd === '/worker' ? 'worker/1-task\n' : 'main\n')
      if (args[0] === 'config') {
        const value = cwd === '/worker' ? config[args.at(-1)!] : undefined
        return value === undefined ? missing() : ok(value)
      }
      return ok()
    }
    return { platform: new SwarmPlatform('/repo', { run, env: {} }), calls }
  }
  it.each([
    'https://other.example/acme/widgets',
    'https://github.com/other/widgets',
    'https://github.com/acme/other',
  ])('inspects the worker cwd and refuses changed identity component %s', async (origin) => {
    const { platform, calls } = checkoutFixture(origin)
    await platform.bindOrigin()
    await expect(platform.prepareDispatch('/worker', 'worker/1-task')).rejects.toThrow('differs from startup')
    expect(calls.filter(({ args }) => args[0] === 'remote').map(({ cwd }) => cwd)).toEqual([
      '/repo', '/repo', '/worker', '/worker',
    ])
  })
  it.each(['remote.pushDefault', 'branch.worker/1-task.pushRemote', 'branch.worker/1-task.remote'])
  ('checks effective worker configuration for %s independently of root settings', async (key) => {
    const { platform, calls } = checkoutFixture('https://github.com/acme/widgets', { [key]: 'worktree\tother\n' })
    await platform.bindOrigin()
    await expect(platform.prepareDispatch('/worker', 'worker/1-task')).rejects.toThrow('other than origin')
    expect(calls).toContainEqual({ args: ['config', '--show-scope', '--get', key], cwd: '/worker' })
  })
  it('refuses multiline selector output instead of using its first or last value', async () => {
    const { platform } = checkoutFixture('https://github.com/acme/widgets', {
      'branch.worker/1-task.remote': 'worktree\torigin\nworktree\tother\n',
    })
    await platform.bindOrigin()
    await expect(platform.prepareDispatch('/worker', 'worker/1-task')).rejects.toThrow('other than origin')
  })
  it('pins every worker selector using the checked-out worker branch', async () => {
    const { platform } = checkoutFixture('https://github.com/acme/widgets')
    await platform.bindOrigin()
    expect(await platform.prepareDispatch('/worker', 'worker/1-task')).toMatchObject({
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'remote.pushDefault', GIT_CONFIG_VALUE_0: 'origin',
      GIT_CONFIG_KEY_1: 'branch.worker/1-task.pushRemote', GIT_CONFIG_VALUE_1: 'origin',
      GIT_CONFIG_KEY_2: 'branch.worker/1-task.remote', GIT_CONFIG_VALUE_2: 'origin',
    })
  })
  it('does not equate a lookalike SSH host with the documented alternate endpoint', async () => {
    const { platform } = fixture({ ssh: 'hostname ssh.github.com.evil.example\nuser git\nport 443\n' })
    await expect(platform.parseRemote('git@alias:acme/widgets')).rejects.toThrow('Non-standard SSH endpoint')
  })
})

describe('unverified grant diagnostic transitions', () => {
  const unknown = () => envelope({ full_name: 'acme/widgets', permissions: { push: true } })
  it('keeps every boundary probe while suppressing identical caveats until the verdict changes', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = ok(unknown())
    const { platform, calls } = fixture({ response })
    await platform.bindOrigin()
    for (let i = 0; i < 4; i++) await platform.assertRepoWritable()
    expect(warning).toHaveBeenCalledTimes(1)
    expect(calls.filter(({ command }) => command === 'gh')).toHaveLength(4)

    response.stdout = envelope({ full_name: 'acme/widgets', permissions: { push: false } })
    await expect(platform.assertRepoWritable()).rejects.toThrow('read-only')
    response.stdout = unknown()
    await platform.assertRepoWritable()
    expect(warning).toHaveBeenCalledTimes(2)

    response.stdout = envelope({ full_name: 'acme/widgets', permissions: { push: true } }, 200, 'x-oauth-scopes: repo')
    await platform.assertRepoWritable()
    expect(warning).toHaveBeenCalledTimes(2)
    response.stdout = unknown()
    await platform.assertRepoWritable()
    expect(warning).toHaveBeenCalledTimes(3)
    expect(calls.filter(({ command }) => command === 'gh')).toHaveLength(8)
    expect(warning.mock.calls.every(([message]) => String(message).includes('remain unverified'))).toBe(true)
  })
  it('does not mistake an inconclusive network failure for a newly observed capability verdict', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = ok(unknown())
    const { platform, calls } = fixture({ response })
    await platform.bindOrigin()
    await platform.assertRepoWritable()
    response.code = 1
    response.stdout = envelope({}, 500)
    await expect(platform.assertRepoWritable()).rejects.toThrow(SwarmPreflightTransientError)
    response.code = 0
    response.stdout = unknown()
    await platform.assertRepoWritable()
    expect(warning).toHaveBeenCalledTimes(1)
    expect(calls.filter(({ command }) => command === 'gh')).toHaveLength(3)
  })
  it('starts each independent platform instance with a visible caveat', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 2; i++) {
      const { platform } = fixture()
      await platform.bindOrigin()
      await platform.assertRepoWritable()
    }
    expect(warning).toHaveBeenCalledTimes(2)
  })
})
