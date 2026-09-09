/**
 * Non-mutating preflight for the one question MAO has to answer before it touches a repository:
 * *does the current GitHub credential have what the issue -> PR -> review -> merge pipeline needs here?*
 *
 * Every stage performs real external writes (create issue, create branch + commit, open PR, post a
 * review, merge). Discovering a missing grant only after an AI provider has already been billed — or,
 * worse, halfway through those writes — is the failure this module exists to prevent, so the verdict
 * is derived purely from read-only GitHub data. Deliberately NOT a write probe: creating and deleting
 * a throwaway issue/branch/PR to "prove" access would itself be an unattended write against a
 * repository the operator may not have meant to touch.
 *
 * The evaluation is a pure function over an already-fetched snapshot, so the whole verdict matrix is
 * testable without Octokit; core/github-service.ts owns the single HTTP read that produces it.
 *
 * **What a passing verdict does and does not mean.** `ok: true` means *nothing GitHub is willing to
 * tell us rules this repository out* — not that a write is guaranteed to succeed. GitHub exposes no
 * non-mutating endpoint that enumerates a fine-grained token's or a GitHub App installation's
 * per-resource grants, so those are reported in `unverified` and never folded into `ok`. That
 * separation is the structural half of issue #48's honesty requirement; `describeUnverifiedGrants()`
 * is the prose half.
 */

/**
 * A hard reason the repository cannot host the workflow. Every gap is fatal — `ok` is
 * `gaps.length === 0`. Each one is a *permanent* condition: transient failures (rate limiting, 5xx,
 * socket errors, a request deadline) are never represented here, because a task that fails on one
 * must stay retryable rather than be told it lacks permission.
 */
export type RepoCapabilityGap =
  | 'token-missing'
  | 'repo-not-found'
  | 'bad-credentials'
  | 'sso-authorization-required'
  | 'installation-suspended'
  | 'resource-not-accessible'
  | 'legally-unavailable'
  | 'archived'
  | 'disabled'
  | 'issues-disabled'
  | 'permissions-unknown'
  | 'no-push-permission'
  | 'oauth-scope-missing'

/**
 * A grant the pipeline needs that GitHub exposes no non-mutating way to confirm for this credential.
 * Reported separately from `gaps` on purpose: it is neither proof of access nor proof of its absence,
 * and issue #48's requirement 4 is that MAO never presents an unprovable grant as proven.
 */
export type RepoCapabilityUnverified = 'issues-write' | 'contents-write' | 'pull-requests-write'

/**
 * How the credential identifies itself. Only `classic` is actually established — by a non-empty
 * `x-oauth-scopes` response header, which GitHub sends for classic PATs and OAuth-app tokens.
 * Everything else is `unknown`: an absent *or empty* header is consistent with a fine-grained token,
 * a GitHub App installation token, and a classic token carrying no scopes at all, and hanging a
 * workflow-blocking verdict on that ambiguity would lock out perfectly authorized credentials.
 */
export type RepoCredentialKind = 'classic' | 'unknown'

/**
 * The subset of GitHub's `GET /repos/{owner}/{repo}` payload the verdict is derived from.
 *
 * Deliberately excludes the repository's merge-method settings (`allow_merge_commit` and friends).
 * They live in the same payload and the merge stage does depend on them, but they are configuration
 * rather than permission — gating *registration* on them would refuse a repository whose issue and
 * PR work is perfectly fine, which is a worse failure than the one it prevents.
 */
export interface RepoCapabilitySnapshot {
  archived?: boolean
  disabled?: boolean
  has_issues?: boolean
  private?: boolean
  /** Present on every authenticated request; its absence is treated as "unknown", never as "granted". */
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean }
}

/** Lookup outcomes that are a verdict in themselves rather than a snapshot to evaluate. */
export type RepoCapabilityFailure =
  | 'token-missing'
  | 'not-found'
  | 'bad-credentials'
  | 'sso-authorization-required'
  | 'installation-suspended'
  | 'resource-not-accessible'
  | 'legally-unavailable'

export interface RepoCapabilityProbe {
  owner: string
  repo: string
  /**
   * Set when the lookup produced a definitive negative verdict rather than a snapshot. Transient
   * failures are deliberately not representable here — the caller rethrows those instead.
   */
  failure?: RepoCapabilityFailure
  repository?: RepoCapabilitySnapshot
  /**
   * Raw `x-oauth-scopes` response header, when GitHub sent one. Pass it through verbatim — including
   * an empty string — rather than normalizing with `?? ''`: only a *non-empty* value identifies a
   * classic token whose scopes are authoritative (see `RepoCredentialKind`).
   */
  oauthScopes?: string
}

/**
 * Structured verdict. Every field is derived from repository metadata and HTTP status, so the whole
 * object is safe to log, persist in a task error, and show in the GUI.
 */
export interface RepoWorkflowCapability {
  owner: string
  repo: string
  /** No *known* blocker. Read together with `unverified` — see this module's doc comment. */
  ok: boolean
  gaps: RepoCapabilityGap[]
  unverified: RepoCapabilityUnverified[]
  observed: {
    archived: boolean | null
    disabled: boolean | null
    hasIssues: boolean | null
    push: boolean | null
    private: boolean | null
    credential: RepoCredentialKind
  }
}

const FAILURE_GAPS: Record<RepoCapabilityFailure, RepoCapabilityGap> = {
  'token-missing': 'token-missing',
  'not-found': 'repo-not-found',
  'bad-credentials': 'bad-credentials',
  'sso-authorization-required': 'sso-authorization-required',
  'installation-suspended': 'installation-suspended',
  'resource-not-accessible': 'resource-not-accessible',
  'legally-unavailable': 'legally-unavailable',
}

const GAP_REASONS: Record<RepoCapabilityGap, string> = {
  'token-missing': 'no GitHub token is configured',
  'repo-not-found': 'the repository does not exist, or this credential cannot see it (GitHub reports both as 404)',
  'bad-credentials': 'GitHub rejected the credential',
  'sso-authorization-required':
    'the organization enforces SAML SSO and this credential has not been authorized for it',
  'installation-suspended': 'the GitHub App installation for this repository is suspended',
  'resource-not-accessible':
    'GitHub refused the read outright, which is how it reports a token or App installation that was ' +
    'never granted access to this repository',
  'legally-unavailable': 'the repository is unavailable for legal reasons',
  archived: 'the repository is archived, so GitHub rejects every write',
  disabled: 'the repository is disabled',
  'issues-disabled': 'the Issues feature is turned off, so the issue stage cannot create an issue',
  'permissions-unknown': 'GitHub returned no permissions block, so write access cannot be established',
  'no-push-permission': 'the credential has read-only access to the repository (push is false)',
  'oauth-scope-missing': "the classic token's scopes cover neither repo nor public_repo write access",
}

const UNVERIFIED_LABELS: Record<RepoCapabilityUnverified, string> = {
  'issues-write': 'Issues: write',
  'contents-write': 'Contents: write',
  'pull-requests-write': 'Pull requests: write',
}

/** Every fine-grained grant the pipeline needs, in the order the stages consume them. */
const PIPELINE_GRANTS: RepoCapabilityUnverified[] = ['issues-write', 'contents-write', 'pull-requests-write']

/** Splits an `x-oauth-scopes` header into its comma-separated scope names. */
function parseScopes(header: string): Set<string> {
  return new Set(
    header
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  )
}

/**
 * Turns a read-only snapshot into the verdict.
 *
 * `permissions.push` is a necessary-but-not-sufficient signal, and what it is derived from differs by
 * credential: for a classic token it is the authenticated user's repository role; for a GitHub App
 * installation it is computed from the installation's granted permission set (so it tracks
 * `contents: write` rather than a human role); for a fine-grained token it can reflect the granting
 * user's role rather than the token's own per-resource grants. Only the classic case is fully
 * knowable here — its scopes come back in a header — so for every other credential the three
 * pipeline grants go to `unverified`. That over-reports for an installation token whose `push: true`
 * really did come from `contents: write`, and it is deliberately conservative in that direction:
 * claiming an unprovable grant is the failure mode issue #48 forbids.
 */
export function evaluateRepoCapability(probe: RepoCapabilityProbe): RepoWorkflowCapability {
  const { owner, repo } = probe

  if (probe.failure) {
    return {
      owner,
      repo,
      ok: false,
      gaps: [FAILURE_GAPS[probe.failure]],
      unverified: [],
      observed: { archived: null, disabled: null, hasIssues: null, push: null, private: null, credential: 'unknown' },
    }
  }

  const repository = probe.repository ?? {}
  // Only a header carrying at least one actual scope establishes a classic token. Absent, empty and
  // whitespace-only are all ambiguous — a truthiness test would read `' '` as a classic token with
  // zero scopes and hard-fail it on `oauth-scope-missing`.
  const scopes = parseScopes(probe.oauthScopes ?? '')
  const credential: RepoCredentialKind = scopes.size > 0 ? 'classic' : 'unknown'
  // `typeof`, not a truthiness/`=== true` test on the block: a permissions object that omits `push`
  // tells us nothing about push, and reporting that as a definite "read-only" would name the wrong
  // cause. Absent knowledge is 'permissions-unknown'; only an explicit false is 'no-push-permission'.
  const push = typeof repository.permissions?.push === 'boolean' ? repository.permissions.push : null

  const gaps: RepoCapabilityGap[] = []
  if (repository.archived === true) gaps.push('archived')
  if (repository.disabled === true) gaps.push('disabled')
  if (repository.has_issues === false) gaps.push('issues-disabled')
  if (push === null) gaps.push('permissions-unknown')
  else if (!push) gaps.push('no-push-permission')

  // A classic token's scopes ARE readable, so a token that provably cannot write is a hard gap even
  // when the repository role would allow it. `public_repo` is accepted whenever the repository is not
  // known to be private — an absent `private` field must not turn a working token into a failure.
  if (credential === 'classic') {
    const canWrite = scopes.has('repo') || (repository.private !== true && scopes.has('public_repo'))
    if (!canWrite) gaps.push('oauth-scope-missing')
  }

  return {
    owner,
    repo,
    ok: gaps.length === 0,
    gaps,
    // Only reported for a verdict that otherwise passes — a failing repo's missing grants are already
    // named in `gaps` — and only for credentials whose per-resource grants GitHub keeps opaque.
    unverified: gaps.length === 0 && credential === 'unknown' ? [...PIPELINE_GRANTS] : [],
    observed: {
      archived: repository.archived ?? null,
      disabled: repository.disabled ?? null,
      hasIssues: repository.has_issues ?? null,
      push,
      private: repository.private ?? null,
      credential,
    },
  }
}

/** Gaps a credential change can actually fix. The rest need a token, a different repo, or a GitHub-side change. */
const CREDENTIAL_GAPS: RepoCapabilityGap[] = [
  'bad-credentials',
  'sso-authorization-required',
  'installation-suspended',
  'resource-not-accessible',
  'permissions-unknown',
  'no-push-permission',
  'oauth-scope-missing',
]

/**
 * Actionable, secret-free explanation of a failed verdict. Names the repository and every missing
 * capability, and interpolates nothing but the owner/repo pair and this module's own fixed strings —
 * never the token, an authenticated remote URL, or a raw GitHub response. The result is persisted in
 * a task error, printed by both shells, and rendered in the GUI, so it must stay safe to write down.
 *
 * The remediation sentence is derived from the gaps rather than fixed, because only about half of them
 * are credential problems. Telling an operator with no token configured to "grant this credential write
 * access", or saying an archived or non-existent repository is "missing permissions", names a cause
 * that is false and a fix that cannot work — and this string is the feature's primary operator-facing
 * output, so a wrong one sends them to fix the wrong thing.
 */
export function describeRepoCapability(capability: RepoWorkflowCapability): string {
  const target = `${capability.owner}/${capability.repo}`
  if (capability.ok) return `${target} has no known blocker for the MAO workflow`

  const reasons = capability.gaps.map((gap) => GAP_REASONS[gap]).join('; ')
  const needsCredential = capability.gaps.some((gap) => CREDENTIAL_GAPS.includes(gap))
  const lead = needsCredential
    ? `${target} is missing permissions MAO needs to run its issue/PR workflow`
    : `${target} cannot host the MAO issue/PR workflow`

  let remedy: string
  if (capability.gaps.includes('token-missing')) {
    remedy = 'Configure a GitHub token in Global settings (or `mao config set-token`), then retry.'
  } else if (needsCredential) {
    remedy = 'Grant this credential write access to the repository (Issues, Contents and Pull requests), then retry.'
  } else {
    remedy = 'Fix that on GitHub, or track a different repository.'
  }

  return `${lead}: ${reasons}. ${remedy}`
}

/**
 * The caveat that has to travel with a *passing* verdict whenever the credential's individual grants
 * are opaque. Callers surface it instead of implying the preflight proved more than it did.
 */
export function describeUnverifiedGrants(capability: RepoWorkflowCapability): string | undefined {
  if (capability.unverified.length === 0) return undefined
  const grants = capability.unverified.map((grant) => UNVERIFIED_LABELS[grant]).join(', ')
  return (
    `${capability.owner}/${capability.repo}: repository push permission is necessary but not sufficient, and ` +
    'GitHub exposes no non-mutating way to confirm this credential\'s individual ' +
    `${grants} grants — they remain unverified, so a write can still fail with a permission error.`
  )
}

/** Thrown when a repository fails the preflight. Carries the structured verdict for callers that want the detail. */
export class RepoCapabilityError extends Error {
  readonly capability: RepoWorkflowCapability

  constructor(capability: RepoWorkflowCapability) {
    super(describeRepoCapability(capability))
    this.name = 'RepoCapabilityError'
    this.capability = capability
  }
}
