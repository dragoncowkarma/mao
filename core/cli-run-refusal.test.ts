import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writePersistenceBrokenMarker } from './persistence-guard.ts'
import { QUEUE_PERSISTENCE_BROKEN, type QueuedTask } from './workflow-engine.ts'

/**
 * `mao run` as a process, refusing to start (issue #76).
 *
 * Under core/ only because nothing collects tests under cli/ yet (issue #83) — move it into that project
 * once it exists. It imports nothing from cli/: it bundles the entry point with scripts/build-cli.mjs's
 * options and runs the result, so rule 1's dependency direction holds and the core project keeps its
 * zero-plugin node environment (rule 8).
 *
 * core/shell-queue-gate.test.ts pins the shell gate as source text, and core/app.test.ts proves the engine
 * stays blocked past it. Neither can show the contract cron relies on: the process exits non-zero on its
 * own, says why and what to run, and changes nothing on disk. Deleting the gate fails the source pin, but
 * disabling it while keeping its text — an inverted condition, `&& false`, the `return` moved above
 * `process.exitCode = 1` — leaves every other test green, because the engine still blocks, while `mao run`
 * idles forever (or exits 0) with no failure status.
 *
 * Isolation is the fixture's point, not a detail. The child inherits nothing but PATH (and SystemRoot on
 * Windows), so no GITHUB_TOKEN, MAO_DATA_DIR or NODE_OPTIONS from the developer's shell or from vitest
 * reaches it; HOME, USERPROFILE, XDG_CONFIG_HOME and APPDATA point into the temp directory, so even a
 * regression that ignored MAO_DATA_DIR would resolve `defaultDataDir()` there rather than to a real
 * config; and the fixture holds no token and no AI provider, so a bypassed gate cannot reach GitHub or an
 * AI CLI — it fails here by never exiting (the poller's interval keeps it alive) until `timeout` kills it.
 * Only refusing invocations are spawned: an unrefused `mao run` never exits on its own, and the resume it
 * would perform after the marker is cleared is proven in-process by core/app.test.ts.
 */

const REPO_ROOT = path.join(
  (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'),
  '..',
)
const SPAWN_TIMEOUT_MS = 30_000
const tracked = { owner: 'acme', repo: 'widgets' }

/**
 * scripts/build-cli.mjs's esbuild options, minus its entry point and output path. A copy, because that
 * script runs its build at top level and cannot be imported — so the first test below compares the two,
 * or a change to one alone would leave CI exercising a bundle production no longer ships.
 */
const BUNDLE_OPTIONS = { bundle: true, platform: 'node', format: 'cjs', target: 'node18' } as const

let workDir = ''
let bundle = ''

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-run-'))
  bundle = path.join(workDir, 'bundle', 'index.cjs')
  // Into a temp directory so dist-cli/ is never touched. The swarm asset copy is left out: only `mao swarm`
  // resolves it, and only when invoked.
  await build({
    ...BUNDLE_OPTIONS,
    entryPoints: [path.join(REPO_ROOT, 'cli', 'index.ts')],
    outfile: bundle,
    logLevel: 'silent',
  })
}, 120_000)

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
})

/** A fresh HOME holding `data/config.json` (one tracked repository plus `workflowTasks`). */
function makeHome(name: string, workflowTasks: unknown) {
  const home = path.join(workDir, name)
  const dataDir = path.join(home, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ githubRepos: [tracked], workflowTasks }, null, 2),
  )
  return { home, dataDir }
}

/** The same HOME with one pending task and the persistence-broken marker beside it. */
function markedHome(name: string) {
  const pending: QueuedTask = {
    id: 'stale-pending',
    title: 'Pending task',
    repo: tracked,
    stage: 'issue',
    history: [],
    status: 'pending',
    autoAdvance: false,
    github: {},
  }
  const made = makeHome(name, [pending])
  writePersistenceBrokenMarker(made.dataDir, new Error('disk full'))
  return made
}

/** Every entry under `dir` with its bytes, recursively, so "changes nothing" covers new files too. */
function snapshot(dir: string, prefix = ''): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const key = prefix + entry.name
    if (entry.isDirectory()) Object.assign(entries, { [`${key}/`]: '<directory>' }, snapshot(full, `${key}/`))
    else entries[key] = fs.readFileSync(full, 'utf-8')
  }
  return entries
}

function runCli(home: string, args: string[]) {
  const inherited: Record<string, string> = {}
  for (const key of ['PATH', 'SystemRoot']) {
    const value = process.env[key]
    if (value !== undefined) inherited[key] = value
  }
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: home,
    encoding: 'utf8',
    env: {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      APPDATA: home,
      MAO_DATA_DIR: path.join(home, 'data'),
    },
    timeout: SPAWN_TIMEOUT_MS,
  })
}

/**
 * The interlock every test runs before it spawns anything that writes or polls: the child must read this
 * fixture and no other config. `config show` is a one-shot read (resume: false) that redacts secrets, so a
 * regression that resolved a real data directory is caught here, before `run` or a clear could touch it.
 */
function expectFixtureConfig(home: string, expected: Record<string, unknown>) {
  const shown = runCli(home, ['config', 'show'])
  expect(shown.status, shown.stderr).toBe(0)
  expect(JSON.parse(shown.stdout)).toMatchObject({
    githubToken: '[unset]',
    githubRepos: [tracked],
    aiProviders: [],
    ...expected,
  })
}

/** What `mao run` owes cron when it refuses: a real exit status, and no sign that the engine started. */
function expectRefused(run: ReturnType<typeof runCli>) {
  expect(run.error, `mao run did not exit within ${SPAWN_TIMEOUT_MS}ms: the refusal gate let the poller start`)
    .toBeUndefined()
  expect(run.signal, 'mao run was killed instead of exiting on its own').toBeNull()
  expect(run.status).toBe(1)
  expect(run.stdout).not.toContain('engine started')
}

it("bundles with scripts/build-cli.mjs's own esbuild options", () => {
  const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build-cli.mjs'), 'utf-8')
  const start = script.indexOf('await build({')
  const options = script.slice(start, script.indexOf('})', start))
  const keys = [...options.matchAll(/^\s+(\w+):/gm)].map((match) => match[1])

  expect(keys.sort()).toEqual([...Object.keys(BUNDLE_OPTIONS), 'entryPoints', 'outfile'].sort())
  for (const [key, value] of Object.entries(BUNDLE_OPTIONS)) {
    expect(options).toContain(`${key}: ${typeof value === 'string' ? `'${value}'` : value}`)
  }
})

describe('mao run with a persistence-broken marker (issue #76)', () => {
  it('exits 1 on its own, names the way out, and changes nothing', { timeout: 90_000 }, () => {
    const { home } = markedHome('refusal')
    expectFixtureConfig(home, { workflowPersistenceBroken: true })
    const before = snapshot(home)

    const run = runCli(home, ['run'])

    expectRefused(run)
    expect(run.stderr).toContain(QUEUE_PERSISTENCE_BROKEN)
    expect(run.stderr).toContain('Nothing was started.')
    expect(run.stderr).toContain('mao config clear-persistence-broken')
    // config.json, the marker and HOME byte for byte: no task state, no workspaces/ clone, no lock file,
    // and nothing under a default data directory.
    expect(snapshot(home)).toEqual(before)
  })

  it('clears the marker in the same data directory `mao run` reads', { timeout: 90_000 }, () => {
    const { home, dataDir } = markedHome('clear')
    expectFixtureConfig(home, { workflowPersistenceBroken: true })

    const cleared = runCli(home, ['config', 'clear-persistence-broken'])
    expect(cleared.status, cleared.stderr).toBe(0)
    expect(cleared.stdout).toContain('Cleared workflowPersistenceBroken')

    // This fixture's own marker, not merely some marker somewhere.
    expect(fs.lstatSync(path.join(dataDir, 'workflow-persistence-broken.marker'), { throwIfNoEntry: false }))
      .toBeUndefined()
    expectFixtureConfig(home, { workflowPersistenceBroken: false })
  })
})

describe('mao run with an unusable stored queue', () => {
  // The marker's sibling gate in the same shell block, and the precedent it follows: before this file it
  // too was pinned only as source text.
  it('exits 1 on its own, names its own way out, and changes nothing', { timeout: 90_000 }, () => {
    const { home } = makeHome('queue-latch', { not: 'an array' })
    expectFixtureConfig(home, { workflowQueueRecoveryRequired: true, workflowPersistenceBroken: false })
    const before = snapshot(home)

    const run = runCli(home, ['run'])

    expectRefused(run)
    expect(run.stderr).toContain('"workflowTasks"')
    expect(run.stderr).toContain('mao workflow confirm-queue-recovery')
    expect(run.stderr).not.toContain('clear-persistence-broken')
    expect(snapshot(home)).toEqual(before)
  })
})
