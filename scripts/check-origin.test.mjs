#!/usr/bin/env node
/**
 * Negative/positive matrix for scripts/check-origin.mjs, runnable anywhere
 * plain Node + git exist (`npm run test:origin`; wired into CI).
 *
 * Beyond verdicts (exit codes), every case asserts the no-leak contract:
 * the helper's combined stdout+stderr must never contain the credential
 * sentinel, a hostile host, userinfo, or any other remote-derived string —
 * only fixed categories, URL indexes, and the operator-supplied expectation.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER = join(dirname(fileURLToPath(import.meta.url)), 'check-origin.mjs')
const EXPECTED = 'github.com/example-owner/example-repo'
const GOOD = 'https://github.com/example-owner/example-repo.git'
const SENTINEL = 'FAKE_SENTINEL_123'
// Strings that must never appear in any helper output, success or failure.
const FORBIDDEN = [SENTINEL, 'evil.example', 'x-access-token', 'attacker']

const git = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Each case sets up remotes in a fresh repo and states the expected verdict. */
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
for (const c of CASES) {
  const dir = mkdtempSync(join(tmpdir(), 'origin-test-'))
  try {
    git(dir, 'init', '-q')
    c.setup(dir)
    const r = spawnSync(process.execPath, [HELPER, EXPECTED], { cwd: dir, encoding: 'utf8' })
    const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const problems = []
    if (r.status !== c.want) problems.push(`exit ${r.status}, want ${c.want}`)
    for (const bad of FORBIDDEN) {
      if (combined.toLowerCase().includes(bad.toLowerCase())) problems.push(`output leaks "${bad}"`)
    }
    if (problems.length) {
      failures++
      console.log(`not ok - ${c.name}: ${problems.join('; ')}`)
    } else {
      console.log(`ok - ${c.name}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (failures) {
  console.log(`check-origin matrix: ${failures}/${CASES.length} case(s) FAILED`)
  process.exit(1)
}
console.log(`check-origin matrix: all ${CASES.length} cases passed, no leaks`)
