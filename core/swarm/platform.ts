import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  evaluateRepoCapability, describeRepoCapability, describeUnverifiedGrants,
  type RepoCapabilitySnapshot, type RepoCapabilityFailure, type RepoWorkflowCapability,
} from '../repo-capabilities.ts'

export class SwarmPreflightError extends Error {
  constructor(message: string, readonly causeCode = 'preflight') { super(message) }
}
export class SwarmPreflightConfigError extends SwarmPreflightError {}
export class SwarmPreflightTransientError extends SwarmPreflightError {}

export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (
  command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
) => Promise<CommandResult>
/** CLI completion and the watchdog settle independently; a missing close cannot stall polling. */
export function createCommandRunner(execute: typeof execFile = execFile, deadlineMs = 60_000): CommandRunner {
  return (command, args, cwd, env) => new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      action()
    }
    let child
    try {
      child = execute(command, args, { cwd, env, encoding: 'utf8', timeout: deadlineMs,
        killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        settle(() => {
          if (!error) { resolve({ code: 0, stdout, stderr }); return }
          if (error.killed) {
            reject(new SwarmPreflightTransientError('CLI operation exceeded its deadline', 'command-timeout'))
          } else if (typeof error.code !== 'number') {
            reject(new SwarmPreflightConfigError('Required CLI operation could not start', 'command-start'))
          } else resolve({ code: error.code, stdout, stderr })
        })
      })
    } catch {
      settle(() => reject(new SwarmPreflightConfigError('Required CLI operation could not start', 'command-start')))
      return
    }
    if (settled) return
    timer = setTimeout(() => settle(() => {
      try { child.kill('SIGKILL') } catch { /* Deadline rejection does not depend on OS termination. */ }
      reject(new SwarmPreflightTransientError('CLI operation exceeded its deadline', 'command-timeout'))
    }), deadlineMs)
  })
}
/** Only fixed error categories leave this module: subprocess errors can carry credential URLs. */
export const runCommand: CommandRunner = createCommandRunner()

export interface RepoTarget { host: string; owner: string; repo: string; ssh?: string; https?: string }
export interface PlatformOptions { run?: CommandRunner; env?: NodeJS.ProcessEnv }
export interface WorktreeEntry { worktree: string; branch?: string; [key: string]: string | undefined }
const identity = (target: RepoTarget) => `${target.host}/${target.owner}/${target.repo}`.toLowerCase()
const invalidRemote = () => new SwarmPreflightConfigError('Origin is not a supported GitHub repository URL', 'origin-is-not-a-supported-github')
const exists = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false })
const canonical = (file: string) => exists(file) ? fs.realpathSync.native(file) : path.resolve(file)

/** Read Git's registry rather than guessing checkout ownership from a directory name. */
export function parseWorktrees(raw: string): WorktreeEntry[] {
  return raw.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const entry: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ')
      entry[space < 0 ? line : line.slice(0, space)] = space < 0 ? '' : line.slice(space + 1)
    }
    if (!entry.worktree) throw new SwarmPreflightConfigError('Git returned an incomplete worktree registry', 'git-returned-an-incomplete-worktree-registry')
    return entry as WorktreeEntry
  })
}

/** Parse full gh --include output. Projection with --jq is forbidden: absent fields must fail closed. */
export function parseApiResponse(raw: string): {
  status: number; headers: Record<string, string>; body: Record<string, unknown>
} {
  const normalized = raw.replace(/\r\n/g, '\n')
  const boundary = normalized.indexOf('\n\n')
  const match = /^HTTP\/\S+\s+(\d{3})\b/.exec(normalized)
  if (boundary < 0 || !match) throw new SwarmPreflightTransientError('GitHub returned an unreadable HTTP envelope', 'github-returned-an-unreadable-http-envelope')
  const headers: Record<string, string> = {}
  for (const line of normalized.slice(0, boundary).split('\n').slice(1)) {
    const colon = line.indexOf(':')
    if (colon >= 0) headers[line.slice(0, colon).toLowerCase().trim()] = line.slice(colon + 1).trim()
  }
  let body: unknown
  try { body = JSON.parse(normalized.slice(boundary + 2)) } catch {
    throw new SwarmPreflightTransientError('GitHub returned an unreadable JSON response', 'github-returned-an-unreadable-json-response')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SwarmPreflightTransientError('GitHub response is not an object', 'github-response-is-not-an-object')
  }
  return { status: Number(match[1]), headers, body: body as Record<string, unknown> }
}

/** Active gh credentials and checkout transport are checked independently; neither proves the other. */
export class SwarmPlatform {
  readonly root: string
  repo = ''
  target?: RepoTarget
  private readonly run: CommandRunner
  private readonly suppliedEnv?: NodeJS.ProcessEnv
  private lastCapabilityVerdict?: string
  private get env(): NodeJS.ProcessEnv { return this.suppliedEnv ?? process.env }
  constructor(root: string, readonly options: PlatformOptions = {}) {
    this.root = canonical(root)
    this.run = options.run ?? runCommand
    this.suppliedEnv = options.env
  }
  private async git(args: string[], cwd = this.root, check = true): Promise<CommandResult> {
    const result = await this.run('git', args, cwd, this.env)
    if (check && result.code !== 0) throw new SwarmPreflightConfigError('Git operation failed; local state was preserved', 'git-operation-failed-local-state-was')
    return result
  }
  async bindOrigin(verifyTransport = true): Promise<RepoTarget> {
    if (verifyTransport && this.env.GIT_CONFIG_PARAMETERS) {
      throw new SwarmPreflightConfigError('Unset GIT_CONFIG_PARAMETERS before binding origin', 'unset-git-config-parameters-before-binding')
    }
    this.target = await this.resolveOrigin(this.root, verifyTransport)
    this.repo = `${this.target.owner}/${this.target.repo}`
    return this.target
  }
  boundEnvironment(): NodeJS.ProcessEnv {
    if (!this.target) throw new SwarmPreflightConfigError('Origin repository context has not been bound', 'origin-repository-context-has-not-been')
    return { ...this.env, GH_HOST: this.target.host, GH_REPO: `${this.target.host}/${this.repo}` }
  }
  async gh(args: string[]): Promise<string> {
    const result = await this.run('gh', args, this.root, this.boundEnvironment())
    if (result.code !== 0) throw new SwarmPreflightTransientError('GitHub CLI operation failed; retry later', 'github-cli-operation-failed-retry-later')
    return result.stdout.trim()
  }
  async json<T>(args: string[]): Promise<T> {
    const raw = await this.gh(args)
    try { return JSON.parse(raw) as T } catch {
      throw new SwarmPreflightTransientError('GitHub CLI returned unreadable JSON', 'github-cli-returned-unreadable-json')
    }
  }
  async parseRemote(remote: string, cwd = this.root, verifyTransport = true): Promise<RepoTarget> {
    if (!remote || remote.trim() !== remote || /[\s?#\\]/.test(remote)) throw invalidRemote()
    let host: string, repositoryPath: string, user: string | undefined, port: string | undefined
    let ssh = false
    if (remote.includes('://')) {
      let url: URL
      try { url = new URL(remote) } catch { throw invalidRemote() }
      if (!['https:', 'ssh:'].includes(url.protocol)) throw invalidRemote()
      host = url.hostname.toLowerCase()
      repositoryPath = /^\w+:\/\/[^/]+(\/.*)$/.exec(remote)?.[1] ?? ''
      ssh = url.protocol === 'ssh:'
      if (ssh) {
        if (url.password) throw invalidRemote()
        user = url.username || undefined
        port = url.port || undefined
      } else if (url.port && url.port !== '443') throw invalidRemote()
    } else {
      const match = /^(?:([A-Za-z0-9_.-]+)@)?([A-Za-z0-9_.-]+):([^/].*)$/.exec(remote)
      if (!match) throw invalidRemote()
      user = match[1]; host = match[2].toLowerCase(); repositoryPath = match[3]; ssh = true
    }
    const match = /^\/?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repositoryPath)
    if (!/^[a-z0-9.-]+$/.test(host) || !match || [match[1], match[2]].some((part) => part === '.' || part === '..')) throw invalidRemote()
    const target: RepoTarget = { host, owner: match[1], repo: match[2] }
    if (!ssh) { target.https = `https://${host}:443`; return target }
    if (verifyTransport) {
      if (this.env.GIT_SSH || this.env.GIT_SSH_COMMAND) {
        throw new SwarmPreflightConfigError('Custom SSH transport prevents origin verification', 'custom-ssh-transport-prevents-origin-verification')
      }
      const config = await this.git(['config', '--get', 'core.sshCommand'], cwd, false)
      if (![0, 1].includes(config.code) || config.stdout.trim()) {
        throw new SwarmPreflightConfigError('Custom core.sshCommand prevents origin verification', 'custom-core-sshcommand-prevents-origin-verification')
      }
    }
    const args = ['-G']
    if (user) args.push('-l', user)
    if (port) args.push('-p', port)
    args.push('--', host)
    const result = await this.run('ssh', args, cwd, this.env)
    if (result.code !== 0) throw new SwarmPreflightConfigError('SSH could not resolve origin endpoint', 'ssh-could-not-resolve-origin-endpoint')
    const values: Record<string, string> = {}
    for (const line of result.stdout.split('\n')) {
      const match = /^(\S+)\s+(.+)$/.exec(line)
      if (match) values[match[1].toLowerCase()] = match[2].trim()
    }
    if (['proxycommand', 'proxyjump'].some((key) => values[key] && values[key].toLowerCase() !== 'none')) {
      throw new SwarmPreflightConfigError('SSH proxy transport prevents endpoint verification', 'ssh-proxy-transport-prevents-endpoint-verification')
    }
    if (!values.hostname || !values.user || !/^\d+$/.test(values.port ?? '') ||
      Number(values.port) < 1 || Number(values.port) > 65535) {
      throw new SwarmPreflightConfigError('SSH returned an incomplete endpoint', 'ssh-returned-an-incomplete-endpoint')
    }
    let endpoint = `${values.user}@${values.hostname.toLowerCase()}:${Number(values.port)}`
    if (endpoint === 'git@ssh.github.com:443') endpoint = 'git@github.com:22'
    if (values.user !== 'git' || (Number(values.port) !== 22 && endpoint !== 'git@github.com:22')) {
      throw new SwarmPreflightConfigError('Non-standard SSH endpoint cannot be bound to GitHub', 'non-standard-ssh-endpoint-cannot-be')
    }
    target.ssh = endpoint
    target.host = endpoint.slice(endpoint.indexOf('@') + 1, endpoint.lastIndexOf(':'))
    return target
  }
  async resolveOrigin(cwd = this.root, verifyTransport = true): Promise<RepoTarget> {
    const targets: RepoTarget[] = []
    for (const push of [false, true]) {
      const result = await this.git(['remote', 'get-url', '--all', ...(push ? ['--push'] : []), 'origin'], cwd)
      const urls = result.stdout.split(/\r?\n/).filter(Boolean)
      if (!urls.length) throw invalidRemote()
      for (const url of urls) targets.push(await this.parseRemote(url, cwd, verifyTransport))
    }
    const first = targets[0]
    if (targets.some((target) => identity(target) !== identity(first))) {
      throw new SwarmPreflightConfigError('Origin fetch and push URLs identify different repositories', 'origin-fetch-and-push-urls-identify')
    }
    const ssh = [...new Set(targets.flatMap((target) => target.ssh ? [target.ssh] : []))]
    const https = [...new Set(targets.flatMap((target) => target.https ? [target.https] : []))]
    if (ssh.length > 1 || https.length > 1) {
      throw new SwarmPreflightConfigError('Origin URLs resolve to inconsistent transport endpoints', 'origin-urls-resolve-to-inconsistent-transport')
    }
    return { ...first, ssh: ssh[0], https: https[0] }
  }
  async assertRepoWritable(): Promise<RepoWorkflowCapability> {
    if (!this.target) throw new SwarmPreflightConfigError('Origin repository context has not been bound', 'origin-repository-context-has-not-been')
    const result = await this.run('gh', ['api', '--include', '--method', 'GET', 'repos/{owner}/{repo}'],
      this.root, this.boundEnvironment())
    let response: ReturnType<typeof parseApiResponse> | undefined
    try { response = parseApiResponse(result.stdout) } catch { /* classify fixed failures below */ }
    const status = response?.status
    const diagnostic = `${result.stdout}\n${result.stderr}`.toLowerCase()
    let failure: RepoCapabilityFailure | undefined
    if (status === 401) failure = 'bad-credentials'
    else if (status === 404) failure = 'not-found'
    else if (status === 451) failure = 'legally-unavailable'
    else if (status === 403 || status === 429) {
      if (response?.headers['x-ratelimit-remaining'] === '0' || response?.headers['retry-after'] || /rate limit/.test(diagnostic)) {
        throw new SwarmPreflightTransientError('GitHub rate-limited the preflight; retry later', 'github-rate-limited-the-preflight-retry')
      }
      if (response?.headers['x-github-sso']) failure = 'sso-authorization-required'
      else if (/installation has been suspended/.test(diagnostic)) failure = 'installation-suspended'
      else if (/resource not accessible by/.test(diagnostic)) failure = 'resource-not-accessible'
    } else if (!status && /bad credentials/.test(diagnostic)) failure = 'bad-credentials'
    else if (!status && (result.code === 4 || /not logged in|authentication required|gh auth login|no oauth token/.test(diagnostic))) {
      throw new SwarmPreflightConfigError('Authenticate the active gh CLI with gh auth login, then retry', 'authenticate-the-active-gh-cli-with')
    }
    const { owner, repo } = this.target
    let capability: RepoWorkflowCapability
    if (failure) capability = evaluateRepoCapability({ owner, repo, failure })
    else {
      if (result.code !== 0 || !response || response.status < 200 || response.status >= 300) {
        throw new SwarmPreflightTransientError('GitHub preflight was inconclusive; retry later', 'github-preflight-was-inconclusive-retry-later')
      }
      if (typeof response.body.full_name !== 'string') {
        throw new SwarmPreflightTransientError('GitHub omitted repository identity', 'github-omitted-repository-identity')
      }
      if (response.body.full_name.toLowerCase() !== this.repo.toLowerCase()) {
        throw new SwarmPreflightConfigError('GitHub repository identity differs from checkout origin', 'github-repository-identity-differs-from-checkout')
      }
      capability = evaluateRepoCapability({ owner, repo,
        repository: response.body as RepoCapabilitySnapshot, oauthScopes: response.headers['x-oauth-scopes'] })
    }
    // Keep probing on every boundary. Only the operator diagnostic is deduplicated: a changed
    // verdict (including a known blocker or proven classic scopes) re-arms the caveat if it returns.
    const verdict = JSON.stringify(capability)
    const changed = verdict !== this.lastCapabilityVerdict
    this.lastCapabilityVerdict = verdict
    if (!capability.ok) throw new SwarmPreflightConfigError(describeRepoCapability(capability), 'repo-capability')
    const warning = describeUnverifiedGrants(capability)
    if (warning && changed) console.warn(warning)
    return capability
  }
  async prepareDispatch(cwd: string, expectedBranch?: string): Promise<NodeJS.ProcessEnv> {
    if (this.env.GIT_CONFIG_PARAMETERS || process.env.GIT_CONFIG_PARAMETERS) {
      throw new SwarmPreflightConfigError('Unset GIT_CONFIG_PARAMETERS before dispatch', 'unset-git-config-parameters-before-dispatch')
    }
    const actual = await this.resolveOrigin(cwd)
    if (!this.target || identity(actual) !== identity(this.target) ||
      actual.ssh !== this.target.ssh || actual.https !== this.target.https) {
      throw new SwarmPreflightConfigError('Dispatch checkout origin or transport differs from startup binding', 'dispatch-checkout-origin-or-transport-differs')
    }
    const result = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, false)
    const branch = result.stdout.trim() || undefined
    if (expectedBranch ? result.code !== 0 || branch !== expectedBranch : result.code !== 0 &&
      !(result.code === 1 && canonical(cwd) === this.root)) {
      throw new SwarmPreflightConfigError('Dispatch checkout does not own the expected branch', 'dispatch-checkout-does-not-own-the')
    }
    const keys = ['remote.pushDefault', ...(branch ? [`branch.${branch}.pushRemote`, `branch.${branch}.remote`] : [])]
    for (const key of keys) {
      const config = await this.git(['config', '--show-scope', '--get', key], cwd, false)
      if (config.code === 1) continue
      const match = /^(\S+)\t([^\n]*)\n?$/.exec(config.stdout)
      if (config.code !== 0 || !match || (['local', 'worktree'].includes(match[1]) && match[2] !== 'origin')) {
        throw new SwarmPreflightConfigError('Dispatch checkout selects a push remote other than origin', 'dispatch-checkout-selects-a-push-remote')
      }
    }
    const env = this.boundEnvironment()
    const count = Number(env.GIT_CONFIG_COUNT ?? '0')
    if (!Number.isSafeInteger(count) || count < 0 || count > 10000) {
      throw new SwarmPreflightConfigError('Invalid inherited command-scope Git configuration count', 'invalid-inherited-command-scope-git-configuration')
    }
    keys.forEach((key, offset) => {
      env[`GIT_CONFIG_KEY_${count + offset}`] = key
      env[`GIT_CONFIG_VALUE_${count + offset}`] = 'origin'
    })
    env.GIT_CONFIG_COUNT = String(count + keys.length)
    return env
  }
  async fetchPrHead(pr: number, expectedHead: string): Promise<string> {
    if (!Number.isSafeInteger(pr) || pr < 1 || !/^[a-f0-9]{40,64}$/i.test(expectedHead)) {
      throw new SwarmPreflightTransientError('PR has no valid immutable head snapshot', 'pr-has-no-valid-immutable-head')
    }
    await this.prepareDispatch(this.root)
    await this.git(['fetch', '--no-tags', 'origin', `refs/pull/${pr}/head`])
    const result = await this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    if (result.stdout.trim().toLowerCase() !== expectedHead.toLowerCase()) {
      throw new SwarmPreflightTransientError('PR head changed while preparing revision; retry next cycle', 'pr-head-changed-while-preparing-revision')
    }
    return expectedHead.toLowerCase()
  }
  private async worktrees(): Promise<WorktreeEntry[]> {
    return parseWorktrees((await this.git(['worktree', 'list', '--porcelain'])).stdout)
  }
  private async branchSha(branch: string): Promise<string | undefined> {
    const result = await this.git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], this.root, false)
    return result.code === 0 && /^[a-f0-9]{40,64}$/i.test(result.stdout.trim()) ? result.stdout.trim() : undefined
  }
  private async advanceBranch(branch: string, expected: string, checkout?: string): Promise<void> {
    const current = await this.branchSha(branch)
    if (current === expected) return
    if (!current || (await this.git(['merge-base', '--is-ancestor', current, expected], this.root, false)).code !== 0) {
      throw new SwarmPreflightConfigError('Local revision branch diverges; preserving local work for inspection', 'local-revision-branch-diverges-preserving-local')
    }
    if (checkout) {
      const status = await this.git(['status', '--porcelain', '--untracked-files=no'], checkout)
      if (status.stdout) throw new SwarmPreflightConfigError('Revision checkout has tracked changes; preserving them', 'revision-checkout-has-tracked-changes-preserving')
      await this.git(['merge', '--no-overwrite-ignore', '--ff-only', expected], checkout)
    } else await this.git(['update-ref', `refs/heads/${branch}`, expected, current])
    if ((await this.branchSha(branch)) !== expected) {
      throw new SwarmPreflightConfigError('Revision branch changed concurrently; preserving its current state', 'revision-branch-changed-concurrently-preserving-its')
    }
  }
  async createWorktree(issue: number, branch: string, expectedHead?: string): Promise<string> {
    if (!Number.isSafeInteger(issue) || issue < 1 || !branch ||
      (await this.git(['check-ref-format', '--branch', branch], this.root, false)).code !== 0) {
      throw new SwarmPreflightConfigError('Invalid task branch or issue identity', 'invalid-task-branch-or-issue-identity')
    }
    if (expectedHead && !/^[a-f0-9]{40,64}$/i.test(expectedHead)) {
      throw new SwarmPreflightConfigError('Invalid verified revision head', 'invalid-verified-revision-head')
    }
    if (exists(path.join(this.root, '.worktrees'))?.isSymbolicLink()) {
      throw new SwarmPreflightConfigError('Refusing symlinked worktree parent', 'refusing-symlinked-worktree-parent')
    }
    const checkout = path.join(this.root, '.worktrees', String(issue))
    const state = exists(checkout)
    if (state?.isSymbolicLink()) throw new SwarmPreflightConfigError('Refusing symlinked worktree path', 'refusing-symlinked-worktree-path')
    let entries = await this.worktrees()
    let entry = entries.find((item) => canonical(item.worktree) === canonical(checkout))
    if (!state && entry) {
      await this.git(['worktree', 'prune'])
      entries = await this.worktrees()
      entry = entries.find((item) => canonical(item.worktree) === canonical(checkout))
    }
    if (state) {
      if (!exists(path.join(checkout, '.git')) || !entry) {
        await this.git(['worktree', 'repair', checkout], this.root, false)
        entries = await this.worktrees()
        entry = entries.find((item) => canonical(item.worktree) === canonical(checkout))
      }
      if (exists(path.join(checkout, '.git')) && entry?.branch === `refs/heads/${branch}`) {
        if (expectedHead) await this.advanceBranch(branch, expectedHead.toLowerCase(), checkout)
        return checkout
      }
      if (!state.isDirectory() || fs.readdirSync(checkout).length) {
        throw new SwarmPreflightConfigError('Non-empty invalid worktree path was preserved for inspection', 'non-empty-invalid-worktree-path-was')
      }
      fs.rmdirSync(checkout)
    }
    if ((await this.worktrees()).some((item) => item.branch === `refs/heads/${branch}`)) {
      throw new SwarmPreflightConfigError('Task branch is already checked out; reuse or reconcile that checkout', 'task-branch-is-already-checked-out')
    }
    const sha = await this.branchSha(branch)
    if (sha && expectedHead) await this.advanceBranch(branch, expectedHead.toLowerCase())
    if (!sha) await this.git(['branch', '--', branch, expectedHead ?? 'origin/main'])
    fs.mkdirSync(path.dirname(checkout), { recursive: true })
    await this.git(['worktree', 'add', checkout, branch])
    return checkout
  }
  async cleanupWorktree(issue: number, branch: string): Promise<void> {
    if (!Number.isSafeInteger(issue) || issue < 1 || !branch.startsWith(`worker/${issue}-`)) return
    const defaultPath = path.join(this.root, '.worktrees', String(issue))
    if (exists(defaultPath)?.isSymbolicLink()) return
    let entries = await this.worktrees()
    // A reused branch may live outside .worktrees. Ownership comes from Git's registry.
    const entry = entries.find((item) => item.branch === `refs/heads/${branch}`)
    if (entry) {
      if (exists(entry.worktree)?.isSymbolicLink()) return
      const checkout = canonical(entry.worktree)
      if (checkout === this.root || exists(checkout)?.isSymbolicLink()) return
      if (!exists(path.join(checkout, '.git'))) {
        await this.git(['worktree', 'repair', checkout], this.root, false)
        if (!exists(path.join(checkout, '.git'))) return
      }
      const current = await this.git(['symbolic-ref', '--quiet', 'HEAD'], checkout, false)
      if (current.code !== 0 || current.stdout.trim() !== `refs/heads/${branch}`) return
      const status = await this.git(['status', '--porcelain', '--untracked-files=all', '--ignored=matching'], checkout, false)
      if (status.code !== 0 || status.stdout.trim()) return
      if ((await this.git(['worktree', 'remove', checkout], this.root, false)).code !== 0) return
    } else if (exists(defaultPath)) {
      // Preserve unmatched directories, including empty registered checkouts of another branch.
      return
    }
    entries = await this.worktrees()
    if (entries.some((item) => item.branch === `refs/heads/${branch}`)) return
    if (await this.branchSha(branch)) await this.git(['branch', '-D', '--', branch])
  }
  async syncMain(dryRun = false): Promise<void> {
    if (dryRun) return
    await this.prepareDispatch(this.root)
    await this.git(['fetch', 'origin', 'main'])
    const branch = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], this.root, false)
    if (branch.code !== 0 || branch.stdout.trim() !== 'main') return
    if ((await this.git(['status', '--porcelain'])).stdout.trim()) return
    const behind = await this.git(['merge-base', '--is-ancestor', 'main', 'origin/main'], this.root, false)
    if (behind.code === 0) await this.git(['merge', '--no-overwrite-ignore', '--ff-only', 'origin/main'])
  }
}

/** Unknown/missing associations fail closed; API authors are never inferred from display text. */
export function isTrustedComment(
  comment: { author?: { login?: string } | null; authorAssociation?: string }, user: string,
): boolean {
  return Boolean(user && comment.author?.login && (comment.author.login === user ||
    ['OWNER', 'COLLABORATOR', 'MEMBER'].includes(comment.authorAssociation ?? '')))
}
