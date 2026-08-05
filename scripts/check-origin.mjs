#!/usr/bin/env node
/**
 * Preflight guard: verify that EVERY effective fetch/push URL of `origin`
 * points at the expected host/owner/repo, without ever printing a raw remote
 * URL (it can embed a token, and malformed URLs can smear credentials across
 * naive field-splitting).
 *
 * Usage: MAO_EXPECTED_REMOTE="github.com/<owner>/<repo>" node scripts/check-origin.mjs
 * Exit 0 and a final "OK" line only when every URL matches; any unparseable,
 * off-scheme, port/query-bearing, or mismatching URL fails closed (exit 1).
 * Mismatches are reported as parsed host/path only — never the raw URL, and
 * never userinfo (the WHATWG URL parser isolates credentials; the SCP-form
 * regex strips the leading user@ before anything is printed).
 */
import { execFileSync } from 'node:child_process'

const expected = (process.env.MAO_EXPECTED_REMOTE || '').toLowerCase()
if (!/^[a-z0-9.-]+\/[^/]+\/[^/]+$/.test(expected)) {
  console.error('Set MAO_EXPECTED_REMOTE="host/owner/repo" (e.g. github.com/dragoncowkarma/mao)')
  process.exit(2)
}

const urls = new Set()
try {
  // --all lists every fetch URL; --push --all lists every push URL and falls
  // back to the fetch URL when no pushurl is configured. A divergent
  // remote.origin.pushurl (git pushes to every configured push URL) is
  // invisible to a fetch-URL-only check, so both must be enumerated.
  for (const extra of [[], ['--push']]) {
    const out = execFileSync('git', ['remote', 'get-url', ...extra, '--all', 'origin'], { encoding: 'utf8' })
    for (const line of out.split('\n')) if (line.trim()) urls.add(line.trim())
  }
} catch {
  console.log('FAIL: could not enumerate origin URLs (no origin remote?)')
  process.exit(1)
}

let ok = urls.size > 0
for (const raw of urls) {
  let host = ''
  let path = ''
  if (/^[a-z][\w+.-]*:\/\//i.test(raw)) {
    let u
    try {
      u = new URL(raw)
    } catch {
      ok = false
      console.log('FAIL: unparseable remote URL (redacted)')
      continue
    }
    // Fail closed on anything beyond plain https/ssh with default port and no
    // query — a nonstandard port or query string changes the real authority.
    if ((u.protocol !== 'https:' && u.protocol !== 'ssh:') || u.port || u.search) {
      ok = false
      console.log(`FAIL: disallowed scheme/port/query (${u.protocol} host=${u.hostname})`)
      continue
    }
    host = u.hostname
    path = u.pathname
  } else {
    const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(raw)
    if (!scp) {
      ok = false
      console.log('FAIL: unrecognized remote format (redacted)')
      continue
    }
    host = scp[1]
    path = scp[2]
  }
  const got = `${host}/${path.replace(/^\/+/, '').replace(/\.git$/, '')}`.toLowerCase()
  if (got !== expected) {
    ok = false
    console.log(`FAIL: a remote URL resolves to ${got}`)
  }
}

console.log(ok ? `OK: every origin fetch/push URL is ${expected}` : 'ORIGIN CHECK FAILED — do not fetch/branch/push')
process.exit(ok ? 0 : 1)
