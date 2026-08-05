#!/usr/bin/env node
/**
 * Preflight guard: verify that EVERY effective fetch/push URL of `origin`
 * points at the expected host/owner/repo, without ever printing a raw remote
 * URL or anything derived from one (host, path, userinfo, query) — malformed
 * or hostile remotes can smuggle credentials into any of those parts.
 *
 * Identity is compared on Git's terms, not on a lenient normalization: Git
 * hands the *path* through to the server (trailing whitespace, `?`/`#`
 * characters, absolute or doubled slashes all reach `git-upload-pack`), so a
 * URL is accepted only when its raw form is whitespace-clean and ?/#-free and
 * its path has exactly the canonical shape — URL form `/owner/repo[.git]`,
 * SCP form the relative `owner/repo[.git]`. Anything else fails closed.
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
 * The committed matrix (scripts/check-origin.test.mjs, `npm run test:origin`,
 * also in CI) asserts verdicts, an exact output grammar, and empty stderr.
 *
 * Scope note: this vouches for `origin` at the moment it runs. Branch-scoped
 * config (`includeIf "onbranch:…"`) can change `origin.pushurl` the moment a
 * branch is created or switched — re-run the guard after the final branch
 * switch, immediately before pushing (see SKILL.md).
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
  // Lines are kept RAW (no trim): whitespace in a configured URL is part of
  // the path Git would send, so it must fail the check, not be groomed away.
  for (const extra of [[], ['--push']]) {
    const out = execFileSync('git', ['remote', 'get-url', ...extra, '--all', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const line of out.split('\n')) if (line !== '' && !urls.includes(line)) urls.push(line)
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
  // Raw-level gates, before any parser gets to normalize the evidence away:
  // surrounding whitespace and ?/# delimiters (even empty ones — WHATWG
  // reports `?`-with-nothing-after as an empty search) are all forwarded to
  // the server as part of the address, so they are identity-relevant.
  if (raw !== raw.trim()) return fail('whitespace in remote URL')
  if (raw.includes('?') || raw.includes('#')) return fail('disallowed scheme, port, query, or fragment')

  let host = ''
  let pathMatch = null
  if (/^[a-z][\w+.-]*:\/\//i.test(raw)) {
    let u
    try {
      u = new URL(raw)
    } catch {
      return fail('unparseable')
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'ssh:') || u.port || u.search || u.hash) {
      return fail('disallowed scheme, port, query, or fragment')
    }
    host = u.hostname
    // Exactly one leading slash and exactly two non-empty segments — a
    // doubled slash (`//owner/repo`) is a different address on the wire.
    pathMatch = /^\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(u.pathname)
  } else {
    const scp = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(raw)
    if (!scp) return fail('unrecognized format')
    host = scp[1]
    // SCP paths are relative on the wire; a leading slash is an absolute
    // path on the server and therefore a different repository address.
    pathMatch = /^([^/]+)\/([^/]+?)(?:\.git)?$/.exec(scp[2])
  }
  if (!pathMatch) return fail('invalid path shape')
  const got = `${host}/${pathMatch[1]}/${pathMatch[2]}`.toLowerCase()
  if (got !== expected) fail('mismatch')
})

console.log(ok ? `OK: every origin fetch/push URL is ${expected}` : 'ORIGIN CHECK FAILED — do not fetch/branch/push')
process.exit(ok ? 0 : 1)
