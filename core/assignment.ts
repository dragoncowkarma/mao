import type { WorkflowRoleAssignment } from './workflow-engine.ts'

/**
 * Matches swarm_orchestrator.py-style role metadata tags: `[Worker: <id>]`, `[Reviewer: <id>]`,
 * `[Maintainer: <id>]`. Unlike swarm_orchestrator's `[Worker: <ai> | Model: <model> | Reasoning:
 * <reasoning>]` tags, mao's carry only a provider id — model/effort already live on that provider's
 * own registered config (see AiProviderConfig), so there's nothing else to parse out of the tag.
 * The id itself is taken verbatim (any character except `]`, `|`, or whitespace — so an id containing
 * a space, e.g. copied from a display name rather than a slug, will not match; stick to the same
 * charset conventions used elsewhere for provider ids). It's matched against registered provider ids
 * at selection time (`WorkflowEngine.selectAgent()`), not during parsing, so an unknown-but-well-formed
 * id surfaces as a normal retryable task error rather than being silently dropped.
 */
const ROLE_TAG_PATTERN = /\[\s*(worker|reviewer|maintainer)\s*:\s*([^\]\s|]+)\s*\]/gi

/**
 * Strips markdown constructs that commonly *quote* or *illustrate* this exact tag syntax rather than
 * declare it — fenced code blocks, inline code spans, HTML comments, and blockquote lines — before tag
 * matching runs. Without this, an issue that merely documents the `[Worker: id]` format (in a code
 * fence, inline code, or an issue-template HTML-comment hint) would have that example text parsed as a
 * real directive. This is a coarse, not fully markdown-spec-accurate, filter — good enough to rule out
 * the common cases without needing a full markdown parser.
 *
 * The fenced-code-block pattern is deliberately line-anchored (`^...fence chars...$` per line, via the
 * `m` flag), not just "fence chars...anything...fence chars" anywhere in the text: GFM allows both ```
 * and ~~~ as fence characters, but only when the fence stands alone on its own line (optionally
 * indented up to 3 spaces, optionally followed by an info string on the *opening* line only). An
 * earlier version matched any `~~~`/``` occurrence anywhere — including inside ordinary prose, e.g.
 * "Decorative ~~~ marker" — which could span across and strip a *real* tag sitting between two such
 * unrelated occurrences. The closing fence must reuse the exact opening delimiter via a backreference.
 */
function stripQuotedText(text: string): string {
  return text
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n(?:[\s\S]*?\n)?[ \t]{0,3}\1[ \t]*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
}

/**
 * Parses role-assignment tags out of free-form text (a GitHub issue or PR body/comment). Tags quoted
 * inside a code fence, inline code span, HTML comment, or blockquote are ignored (see stripQuotedText)
 * so documenting the tag format doesn't itself act as a directive. A role that appears more than once
 * (outside of quoted text) keeps its last occurrence, so an editor can amend an existing tag by simply
 * appending a new one further down rather than needing to edit the original in place. Returns an empty
 * object (never throws) when no tags are present — callers should treat that as "no explicit
 * assignment" and fall back to the default maker-checker rotation.
 */
export function parseAssignmentTags(text: string | null | undefined): WorkflowRoleAssignment {
  const assignment: WorkflowRoleAssignment = {}
  for (const match of stripQuotedText(text ?? '').matchAll(ROLE_TAG_PATTERN)) {
    const role = match[1].toLowerCase() as keyof WorkflowRoleAssignment
    assignment[role] = match[2]
  }
  return assignment
}

/** True when `assignment` has at least one role pinned — lets callers avoid attaching an empty override. */
export function hasAssignment(assignment: WorkflowRoleAssignment): boolean {
  return assignment.worker !== undefined || assignment.reviewer !== undefined || assignment.maintainer !== undefined
}
