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

const FENCE_OPEN_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/

/**
 * Blanks out fenced code blocks line by line, tracking open/close state explicitly rather than trying
 * to express GFM's fence rule as a single regex (two attempts at that both had real bugs — see git
 * history). The rule being implemented: a fence opens on a line that (after up to 3 spaces of
 * indentation) starts with 3+ of the same character (backtick or tilde); it closes on the next such
 * line using the *same character*, with a run length *at least* as long as the opening's (not
 * necessarily identical — CommonMark explicitly allows a longer closing fence), and nothing else but
 * trailing whitespace. An unterminated fence is treated as extending to the end of the text. This is a
 * coarse, not fully markdown-spec-accurate, filter — good enough to rule out the common cases without
 * needing a full markdown parser.
 */
function stripFencedCodeBlocks(text: string): string {
  const lines = text.split('\n')
  let fenceChar: string | null = null
  let fenceLen = 0
  const out = lines.map((line) => {
    if (fenceChar === null) {
      const open = line.match(FENCE_OPEN_LINE)
      if (!open) return line
      fenceChar = open[1][0]
      fenceLen = open[1].length
      return ''
    }
    const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLen},}[ \\t]*$`)
    if (closeRe.test(line)) {
      fenceChar = null
      fenceLen = 0
    }
    return ''
  })
  return out.join('\n')
}

/**
 * Strips markdown constructs that commonly *quote* or *illustrate* this exact tag syntax rather than
 * declare it — fenced code blocks (see stripFencedCodeBlocks), inline code spans, HTML comments, and
 * blockquote lines — before tag matching runs. Without this, an issue that merely documents the
 * `[Worker: id]` format (in a code fence, inline code, or an issue-template HTML-comment hint) would
 * have that example text parsed as a real directive.
 */
function stripQuotedText(text: string): string {
  return stripFencedCodeBlocks(text)
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
