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

  it('treats a permissions block that omits push as unknown, not as a definite read-only', () => {
    // Reporting "the credential has read-only access" from a block that never mentioned push would
    // name the wrong cause; absent knowledge belongs in permissions-unknown.
    const capability = evaluateRepoCapability(
      probe({ repository: { has_issues: true, permissions: { pull: true } } }),
    )
    expect(capability.gaps).toEqual(['permissions-unknown'])
    expect(capability.observed.push).toBeNull()
  })

  it('treats an absent permissions block as unknown, never as granted', () => {
    // Defensive: GitHub sends `permissions` on every authenticated request, so reaching this means
    // the response was not what we assumed — which must fail closed rather than pass.
    const capability = evaluateRepoCapability(probe({ repository: { has_issues: true } }))
    expect(capability.ok).toBe(false)
    expect(capability.gaps).toEqual(['permissions-unknown'])
    expect(capability.observed.push).toBeNull()
  })

  it('does not tell the operator to grant write access on an archived repo, where no grant can help', () => {
    const capability = evaluateRepoCapability(
      probe({ repository: { archived: true, has_issues: true, permissions: { push: true } } }),
    )
    const message = describeRepoCapability(capability)
    expect(message).toContain('cannot host the MAO issue/PR workflow')
    expect(message).not.toMatch(/Grant this credential/)
    expect(message).toMatch(/Fix that on GitHub, or track a different repository/)
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

  describe('a verdict spanning both a repository-state and a credential gap', () => {
    // Because gaps accumulate, these mixed sets are the *ordinary* shape — a read-only collaborator on
    // an archived repo hits one immediately. Asserting only the single-gap cases (as the tests below
    // do) reads like proof the archived case is handled while an "any credential gap" test quietly
    // hands it the grant-write-access remedy that can never work.
    const mixed: Array<[string, RepoCapabilityProbe['repository']]> = [
      ['archived + read-only', { archived: true, has_issues: true, permissions: { push: false } }],
      ['archived + permissions omitting push', { archived: true, has_issues: true, permissions: { pull: true } }],
      ['disabled + read-only', { disabled: true, has_issues: true, permissions: { push: false } }],
      ['Issues off + read-only', { has_issues: false, permissions: { push: false } }],
    ]

    it.each(mixed)('lets the repository-state gap decide the remedy for %s', (_name, repository) => {
      const capability = evaluateRepoCapability(probe({ repository }))
      const message = describeRepoCapability(capability)

      expect(message).toContain('cannot host the MAO issue/PR workflow')
      expect(message).not.toMatch(/is missing permissions|Grant this credential/)
      expect(message).toMatch(/Fix that on GitHub, or track a different repository/)
    })

    it('still names every gap, so nothing is hidden by choosing one next step', () => {
      const capability = evaluateRepoCapability(
        probe({ repository: { archived: true, has_issues: true, permissions: { push: false } } }),
      )
      expect(capability.gaps).toEqual(['archived', 'no-push-permission'])
      const message = describeRepoCapability(capability)
      expect(message).toContain('the repository is archived')
      expect(message).toContain('read-only access')
    })

    it('applies the credential remedy once no repository-state gap remains', () => {
      const capability = evaluateRepoCapability(probe({ repository: { has_issues: true, permissions: { push: false } } }))
      expect(describeRepoCapability(capability)).toMatch(/is missing permissions.*Grant this credential/s)
    })
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

    it('tells a tokenless operator to configure a token, not to grant a credential write access', () => {
      // This string is the feature's primary operator-facing output; naming a credential that does not
      // exist would send them to change GitHub grants that are not the problem.
      const capability = evaluateRepoCapability({ owner: 'acme', repo: 'widgets', failure: 'token-missing' })
      expect(describeRepoCapability(capability)).toBe(
        'acme/widgets cannot host the MAO issue/PR workflow: no GitHub token is configured. ' +
          'Configure a GitHub token in Global settings (or `mao config set-token`), then retry.',
      )
    })

    it('does not blame permissions for a repository that does not exist', () => {
      const capability = evaluateRepoCapability({ owner: 'acme', repo: 'typo', failure: 'not-found' })
      const message = describeRepoCapability(capability)
      expect(message).not.toMatch(/missing permissions|Grant this credential/)
      expect(message).toMatch(/does not exist, or this credential cannot see it/)
    })

    it('keeps the grant-write-access remedy for verdicts a credential change can actually fix', () => {
      const capability = evaluateRepoCapability({
        owner: 'acme',
        repo: 'widgets',
        failure: 'resource-not-accessible',
      })
      expect(describeRepoCapability(capability)).toMatch(
        /is missing permissions.*Grant this credential write access/s,
      )
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

    it('treats a whitespace-only scopes header as ambiguous rather than a classic token with no scopes', () => {
      const capability = evaluateRepoCapability(probe({ oauthScopes: '  ' }))
      expect(capability.ok).toBe(true)
      expect(capability.gaps).toEqual([])
      expect(capability.observed.credential).toBe('unknown')
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
    // Pinned exactly rather than pattern-matched: a `not.toMatch(/ghp_.../)` on an input that never
    // contained a secret passes no matter what the function does. Any new interpolation — a raw GitHub
    // response, a remote URL, a header — changes this string and fails here.
    expect(describeRepoCapability(capability)).toBe(
      'acme/widgets is missing permissions MAO needs to run its issue/PR workflow: the credential has ' +
        'read-only access to the repository (push is false). Grant this credential write access to the ' +
        'repository (Issues, Contents and Pull requests), then retry.',
    )
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
