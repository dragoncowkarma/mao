import { describe, expect, it } from 'vitest'
import {
  RepoCapabilityError,
  describeRepoCapability,
  describeUnverifiedGrants,
  evaluateRepoCapability,
  type RepoCapabilityProbe,
} from './repo-capabilities.ts'

/** A repo that passes everything, so each test can vary exactly one signal. */
function probe(overrides: Partial<RepoCapabilityProbe> = {}): RepoCapabilityProbe {
  return {
    owner: 'acme',
    repo: 'widgets',
    repository: {
      archived: false,
      disabled: false,
      has_issues: true,
      private: true,
      permissions: { admin: false, push: true, pull: true },
    },
    ...overrides,
  }
}

describe('evaluateRepoCapability', () => {
  it('passes a writable repo and reports nothing missing', () => {
    const capability = evaluateRepoCapability(probe())
    expect(capability.ok).toBe(true)
    expect(capability.gaps).toEqual([])
    expect(capability.observed.push).toBe(true)
  })

  it('rejects a read-only repo when push is false', () => {
    const capability = evaluateRepoCapability(
      probe({ repository: { has_issues: true, permissions: { push: false, pull: true } } }),
    )
    expect(capability.ok).toBe(false)
    expect(capability.gaps).toContain('no-push-permission')
    expect(capability.observed.push).toBe(false)
  })

  it('treats an absent permissions block as unknown, never as granted', () => {
    // Defensive: GitHub sends `permissions` on every authenticated request, so reaching this means
    // the response was not what we assumed — which must fail closed rather than pass.
    const capability = evaluateRepoCapability(probe({ repository: { has_issues: true } }))
    expect(capability.ok).toBe(false)
    expect(capability.gaps).toEqual(['permissions-unknown'])
    expect(capability.observed.push).toBeNull()
  })

  it('rejects an archived repo even though the role still says push', () => {
    const capability = evaluateRepoCapability(
      probe({ repository: { archived: true, has_issues: true, permissions: { push: true } } }),
    )
    expect(capability.gaps).toEqual(['archived'])
  })

  it('rejects a disabled repo', () => {
    const capability = evaluateRepoCapability(
      probe({ repository: { disabled: true, has_issues: true, permissions: { push: true } } }),
    )
    expect(capability.gaps).toEqual(['disabled'])
  })

  it('rejects a repo with Issues turned off, because the issue stage cannot create one', () => {
    const capability = evaluateRepoCapability(
      probe({ repository: { has_issues: false, permissions: { push: true } } }),
    )
    expect(capability.gaps).toEqual(['issues-disabled'])
  })

  it('accumulates every gap rather than stopping at the first', () => {
    const capability = evaluateRepoCapability(
      probe({ repository: { archived: true, has_issues: false, permissions: { push: false } } }),
    )
    expect(capability.gaps).toEqual(['archived', 'issues-disabled', 'no-push-permission'])
    expect(describeRepoCapability(capability)).toMatch(/archived.*Issues.*read-only/s)
  })

  describe('lookup failures', () => {
    const cases: Array<[RepoCapabilityProbe['failure'], string]> = [
      ['token-missing', 'token-missing'],
      ['not-found', 'repo-not-found'],
      ['bad-credentials', 'bad-credentials'],
      ['sso-authorization-required', 'sso-authorization-required'],
      ['installation-suspended', 'installation-suspended'],
      ['resource-not-accessible', 'resource-not-accessible'],
      ['legally-unavailable', 'legally-unavailable'],
    ]

    it.each(cases)('maps the %s lookup failure to the %s gap with nothing observed', (failure, gap) => {
      const capability = evaluateRepoCapability({ owner: 'acme', repo: 'widgets', failure })
      expect(capability.ok).toBe(false)
      expect(capability.gaps).toEqual([gap])
      expect(capability.unverified).toEqual([])
      expect(capability.observed).toEqual({
        archived: null,
        disabled: null,
        hasIssues: null,
        push: null,
        private: null,
        credential: 'unknown',
      })
    })

    it('explains a missing token without inventing repository facts', () => {
      const capability = evaluateRepoCapability({ owner: 'acme', repo: 'widgets', failure: 'token-missing' })
      expect(describeRepoCapability(capability)).toMatch(/acme\/widgets.*no GitHub token is configured/)
    })
  })

  describe('credential inference from x-oauth-scopes', () => {
    it('reports the three pipeline grants as unverified when no scopes header identifies the token', () => {
      // A fine-grained PAT or GitHub App installation token: GitHub sends no scopes header and offers
      // no non-mutating endpoint that enumerates its per-resource grants.
      const capability = evaluateRepoCapability(probe())
      expect(capability.ok).toBe(true)
      expect(capability.observed.credential).toBe('unknown')
      expect(capability.unverified).toEqual(['issues-write', 'contents-write', 'pull-requests-write'])
      expect(describeUnverifiedGrants(capability)).toMatch(/Issues: write.*unverified/s)
    })

    it('treats a present-but-empty scopes header as ambiguous, not as a token with no access', () => {
      // Hanging a workflow-blocking verdict on header presence alone would lock out any credential
      // that happens to echo an empty x-oauth-scopes.
      const capability = evaluateRepoCapability(probe({ oauthScopes: '' }))
      expect(capability.ok).toBe(true)
      expect(capability.gaps).toEqual([])
      expect(capability.observed.credential).toBe('unknown')
      expect(capability.unverified).toHaveLength(3)
    })

    it('accepts a classic token carrying repo scope and claims nothing unverified', () => {
      const capability = evaluateRepoCapability(probe({ oauthScopes: 'read:org, repo, gist' }))
      expect(capability.ok).toBe(true)
      expect(capability.observed.credential).toBe('classic')
      expect(capability.unverified).toEqual([])
      expect(describeUnverifiedGrants(capability)).toBeUndefined()
    })

    it('rejects a classic token whose scopes provably cannot write, even with push permission', () => {
      const capability = evaluateRepoCapability(probe({ oauthScopes: 'read:user, gist' }))
      expect(capability.ok).toBe(false)
      expect(capability.gaps).toEqual(['oauth-scope-missing'])
    })

    it('accepts public_repo on a public repository', () => {
      const capability = evaluateRepoCapability(
        probe({
          oauthScopes: 'public_repo',
          repository: { has_issues: true, private: false, permissions: { push: true } },
        }),
      )
      expect(capability.ok).toBe(true)
    })

    it('accepts public_repo when the repo payload omits `private` rather than failing closed on it', () => {
      const capability = evaluateRepoCapability(
        probe({ oauthScopes: 'public_repo', repository: { has_issues: true, permissions: { push: true } } }),
      )
      expect(capability.ok).toBe(true)
    })

    it('rejects public_repo on a private repository', () => {
      const capability = evaluateRepoCapability(probe({ oauthScopes: 'public_repo' }))
      expect(capability.gaps).toEqual(['oauth-scope-missing'])
    })

    it('does not report unverified grants for a repo that already failed', () => {
      const capability = evaluateRepoCapability(
        probe({ repository: { has_issues: true, permissions: { push: false } } }),
      )
      expect(capability.unverified).toEqual([])
    })
  })
})

describe('describeRepoCapability', () => {
  it('never interpolates anything but the repo name and its own fixed strings', () => {
    // The message is persisted in task errors and printed by both shells, so a token or an
    // authenticated remote URL reaching it would be a durable leak.
    const capability = evaluateRepoCapability(
      probe({ owner: 'acme', repo: 'widgets', repository: { has_issues: true, permissions: { push: false } } }),
    )
    const message = describeRepoCapability(capability)
    expect(message).toContain('acme/widgets')
    expect(message).not.toMatch(/ghp_|github_pat_|x-access-token|Authorization|https:\/\//)
  })

  it('applies to every repository including MAO\'s own, with no exemption', () => {
    const capability = evaluateRepoCapability({
      owner: 'dragoncowkarma',
      repo: 'mao',
      repository: { has_issues: true, permissions: { push: false } },
    })
    expect(capability.ok).toBe(false)
    expect(describeRepoCapability(capability)).toContain('dragoncowkarma/mao')
  })
})

describe('RepoCapabilityError', () => {
  it('carries the structured verdict alongside the actionable message', () => {
    const capability = evaluateRepoCapability(
      probe({ repository: { has_issues: false, permissions: { push: false } } }),
    )
    const error = new RepoCapabilityError(capability)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('RepoCapabilityError')
    expect(error.capability.gaps).toEqual(['issues-disabled', 'no-push-permission'])
    expect(error.message).toBe(describeRepoCapability(capability))
  })
})
