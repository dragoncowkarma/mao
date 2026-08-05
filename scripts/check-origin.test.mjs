#!/usr/bin/env node
/**
 * Negative/positive matrix for scripts/check-origin.mjs, runnable anywhere
 * plain Node + git exist (`npm run test:origin`; wired into CI).
 *
 * Three oracles per invocation, so a regression in any prior review finding
 * actually fails the run:
 * - verdict: exact expected exit code;
 * - output grammar: every stdout line must match the helper's fixed-category
 *   grammar (success lines must equal the exact OK line), so a stray
 *   remote-derived string cannot hide in an otherwise-passing case;
 * - silence: stderr must be exactly empty — child git stderr passthrough was
 *   a real leak once;
 * plus a denylist of sentinel strings over combined output.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'check-origin.mjs')
const EXPECTED = 'github.com/example-owner/example-repo'
const GOOD = 'https://github.com/example-owner/example-repo.git'
const SENTINEL = 'FAKE_SENTINEL_123'
const FORBIDDEN = [SENTINEL, 'evil.example', 'x-access-token', 'attacker']

const OK_LINE = `OK: every origin fetch/push URL is ${EXPECTED}`
const LINE_GRAMMAR = new RegExp(
  '^(' +
    [
      OK_LINE.replace(/[/.]/g, '\\$&'),
      'FAIL\\(url \\d+\\): (whitespace in remote URL|disallowed scheme, port, query, or fragment|unparseable|unrecognized format|invalid path shape|mismatch)',
      'FAIL: (could not enumerate origin URLs|origin has no URLs)',
      'ORIGIN CHECK FAILED — do not fetch/branch/push',
    ].join('|') +
    ')$'
)

const git = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Runs the helper in `dir` and returns problems vs the three oracles. */
function checkRun(dir, want) {
  const r = spawnSync(process.execPath, [HELPER, EXPECTED], { cwd: dir, encoding: 'utf8' })
  const problems = []
  if (r.status !== want) problems.push(`exit ${r.status}, want ${want}`)
  if ((r.stderr ?? '') !== '') problems.push('stderr not empty')
  const lines = (r.stdout ?? '').split('\n').filter((l) => l !== '')
  for (const line of lines) {
    if (!LINE_GRAMMAR.test(line)) problems.push(`off-grammar stdout line`)
  }
  if (want === 0 && !lines.includes(OK_LINE)) problems.push('missing exact OK line')
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`.toLowerCase()
  for (const bad of FORBIDDEN) {
    if (combined.includes(bad.toLowerCase())) problems.push(`output leaks "${bad}"`)
  }
  return problems
}

const CASES = [
  { name: 'https with .git', want: 0, setup: (d) => git(d, 'remote', 'add', 'origin', GOOD) },
  { name: 'scp-style', want: 0, setup: (d) => git(d, 'remote', 'add', 'origin', 'git@github.com:example-owner/example-repo.git') },
  { name: 'ssh://', want: 0, setup: (d) => git(d, 'remote', 'add', 'origin', 'ssh://git@github.com/example-owner/example-repo.git') },
  { name: 'token userinfo, correct path', want: 0, setup: (d) => git(d, 'remote', 'add', 'origin', `https://x-access-token:${SENTINEL}@github.com/example-owner/example-repo.git`) },
  { name: 'deceptive path', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', 'https://evil.example/github.com/example-owner/example-repo.git') },
  { name: 'token userinfo, short path', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', `https://x-access-token:${SENTINEL}@github.com/example-owner`) },
  { name: 'sentinel in deceptive path', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', `https://evil.example/${SENTINEL}/example-repo.git`) },
  {
    name: 'divergent pushurl',
    want: 1,
    setup: (d) => {
      git(d, 'remote', 'add', 'origin', GOOD)
      git(d, 'config', 'remote.origin.pushurl', 'https://evil.example/steal/repo.git')
    },
  },
  {
    name: 'multiple pushurls, one hostile',
    want: 1,
    setup: (d) => {
      git(d, 'remote', 'add', 'origin', GOOD)
      git(d, 'config', 'remote.origin.pushurl', GOOD)
      git(d, 'config', '--add', 'remote.origin.pushurl', 'https://evil.example/steal/repo.git')
    },
  },
  {
    name: 'scp pushurl with query sentinel',
    want: 1,
    setup: (d) => {
      git(d, 'remote', 'add', 'origin', GOOD)
      git(d, 'config', 'remote.origin.pushurl', `git@github.com:example-owner/example-repo.git?access_token=${SENTINEL}`)
    },
  },
  { name: 'nonstandard port', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', 'https://github.com:8443/example-owner/example-repo.git') },
  { name: 'query string', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', `${GOOD}?x=1`) },
  { name: 'fragment', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', `${GOOD}#frag`) },
  // Canonicalization bypasses: Git forwards each of these paths verbatim to
  // git-upload-pack, so none of them is the same address as the clean form.
  { name: 'empty query delimiter', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', 'ssh://git@github.com/example-owner/example-repo.git?') },
  { name: 'empty fragment delimiter', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', 'ssh://git@github.com/example-owner/example-repo.git#') },
  { name: 'scp absolute path', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', 'git@github.com:/example-owner/example-repo.git') },
  { name: 'url double-slash path', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', 'ssh://git@github.com//example-owner/example-repo.git') },
  { name: 'trailing whitespace', want: 1, setup: (d) => git(d, 'remote', 'add', 'origin', 'git@github.com:example-owner/example-repo.git ') },
  { name: 'no origin remote', want: 1, setup: () => {} },
  {
    // remote.pushDefault redirects a bare `git push` elsewhere; the helper
    // only vouches for origin, which is why SKILL.md requires pinning
    // `git push --set-upstream origin <branch>`. The helper itself must
    // still pass here — and still not print the attacker remote.
    name: 'pushDefault to other remote (origin itself ok)',
    want: 0,
    setup: (d) => {
      git(d, 'remote', 'add', 'origin', GOOD)
      git(d, 'remote', 'add', 'attacker', 'https://evil.example/steal/repo.git')
      git(d, 'config', 'remote.pushDefault', 'attacker')
    },
  },
]

let failures = 0
const report = (name, problems) => {
  if (problems.length) {
    failures++
    console.log(`not ok - ${name}: ${problems.join('; ')}`)
  } else {
    console.log(`ok - ${name}`)
  }
}

for (const c of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'origin-test-'))
  try {
    git(dir, 'init', '-q', '-b', 'main')
    c.setup(dir)
    report(c.name, checkRun(dir, c.want))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Branch-conditional config: an `includeIf "onbranch:feature/**"` section can
// swap origin.pushurl the moment the branch exists, so a pre-branch preflight
// is stale evidence. The guard must pass on main and fail after the switch —
// which is exactly why SKILL.md requires re-running it right before push.
{
  const dir = mkdtempSync(join(tmpdir(), 'origin-test-'))
  try {
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x')
    git(dir, 'remote', 'add', 'origin', GOOD)
    writeFileSync(join(dir, '.git', 'evil.inc'), '[remote "origin"]\n\tpushurl = https://evil.example/steal/repo.git\n')
    appendFileSync(join(dir, '.git', 'config'), '\n[includeIf "onbranch:feature/**"]\n\tpath = evil.inc\n')
    const before = checkRun(dir, 0).map((p) => `pre-switch ${p}`)
    git(dir, 'switch', '-q', '-c', 'feature/probe')
    const after = checkRun(dir, 1).map((p) => `post-switch ${p}`)
    report('onbranch includeIf activates hostile pushurl', [...before, ...after])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const total = CASES.length + 1
if (failures) {
  console.log(`check-origin matrix: ${failures}/${total} case(s) FAILED`)
  process.exit(1)
}
console.log(`check-origin matrix: all ${total} cases passed, no leaks`)
