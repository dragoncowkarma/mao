#!/usr/bin/env node
/**
 * Preflight guard: verify that EVERY effective fetch/push URL of `origin`
 * points at the expected host/owner/repo, without ever printing a raw remote
 * URL or anything derived from one (host, path, userinfo, query) — malformed
 * or hostile remotes can smuggle credentials into any of those parts.
 *
 * Usage (any shell, no env syntax needed):
 *   node scripts/check-origin.mjs "github.com/<owner>/<repo>"
 * (MAO_EXPECTED_REMOTE is honored as a fallback when no argument is given.)
 *
 * Output contract:
 * - Success: one `OK: …` line echoing only the operator-supplied expectation.
 * - Failure: fixed-category lines with a 1-based URL index, e.g.
 *   `FAIL(url 2): mismatch` — never any remote-derived string. Child git
 *   stderr is captured and discarded for the same reason.
 * Exit codes: 0 all match; 1 any failure (fail-closed); 2 bad invocation.
 * The committed negative matrix (scripts/check-origin.test.mjs, run via
 * `npm run test:origin` and in CI) asserts both the verdicts and the
 * no-leak contract on combined stdout+stderr.
 */
import { execFileSync } from 'node:child_process'

const expected = (process.argv[2] || process.env.MAO_EXPECTED_REMOTE || '').toLowerCase()
if (!/^[a-z0-9.-]+\/[^/]+\/[^/]+$/.test(expected)) {
  console.error('Usage: node scripts/check-origin.mjs "host/owner/repo" (e.g. github.com/dragoncowkarma/mao)')
  process.exit(2)
}

const urls = []
try {
  // --all lists every fetch URL; --push --all lists every push URL and falls
  // back to the fetch URL when no pushurl is configured. A divergent
  // remote.origin.pushurl (git pushes to every configured push URL) is
  // invisible to a fetch-URL-only check, so both must be enumerated. stderr
  // is piped and discarded: git error text must not reach the log either.
  for (const extra of [[], ['--push']]) {
    const out = execFileSync('git', ['remote', 'get-url', ...extra, '--all', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const line of out.split('\n')) if (line.trim() && !urls.includes(line.trim())) urls.push(line.trim())
  }
} catch {
  console.log('FAIL: could not enumerate origin URLs')
  process.exit(1)
}

let ok = urls.length > 0
if (!ok) console.log('FAIL: origin has no URLs')

urls.forEach((raw, i) => {
  const fail = (category) => {
    ok = false
    console.log(`FAIL(url ${i + 1}): ${category}`)
  }
  let host = ''
  let path = ''
  if (/^[a-z][\w+.-]*:\/\//i.test(raw)) {
    let u
    try {
      u = new URL(raw)
    } catch {
      return fail('unparseable')
    }
    // Fail closed on anything beyond plain https/ssh with default port and no
    // query/fragment — each of those changes (or hides) the real authority.
    if ((u.protocol !== 'https:' && u.protocol !== 'ssh:') || u.port || u.search || u.hash) {
      return fail('disallowed scheme, port, query, or fragment')
    }
    host = u.hostname
    path = u.pathname
  } else {
    const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(raw)
    if (!scp) return fail('unrecognized format')
    if (/[?#]/.test(scp[2])) return fail('disallowed scheme, port, query, or fragment')
    host = scp[1]
    path = scp[2]
  }
  const got = `${host}/${path.replace(/^\/+/, '').replace(/\.git$/, '')}`.toLowerCase()
  if (got !== expected) fail('mismatch')
})

console.log(ok ? `OK: every origin fetch/push URL is ${expected}` : 'ORIGIN CHECK FAILED — do not fetch/branch/push')
process.exit(ok ? 0 : 1)
