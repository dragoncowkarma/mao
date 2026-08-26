import { AI_EFFORTS, type AiEffort } from './ai/types.ts'
import type { ProviderOverride, WorkflowRoleAssignment } from './workflow-engine.ts'

/**
 * Matches swarm_orchestrator.py-style role metadata tags: `[Worker: <id>]`, `[Reviewer: <id>]`,
 * `[Maintainer: <id>]`. Unlike swarm_orchestrator's `[Worker: <ai> | Model: <model> | Reasoning:
 * <reasoning>]` tags, mao's carry only a provider id: model/effort default to that provider's own
 * registered config (see AiProviderConfig) and are overridden — for the whole task, not per role —
 * by the separate `[Model: …]`/`[Effort: …]` tags below, mirroring the task-level `model`/`effort`
 * fields of `ProviderOverride` (a per-role model would have nowhere to go).
 * The id itself is taken verbatim (any character except `]`, `|`, or whitespace — so an id containing
 * a space, e.g. copied from a display name rather than a slug, will not match; stick to the same
 * charset conventions used elsewhere for provider ids). It's matched against registered provider ids
 * at selection time (`WorkflowEngine.selectAgent()`), not during parsing, so an unknown-but-well-formed
 * id surfaces as a normal retryable task error rather than being silently dropped.
 */
const ROLE_TAG_PATTERN = /\[\s*(worker|reviewer|maintainer)\s*:\s*([^\]\s|]+)\s*\]/gi

/**
 * Matches a task-level `[Model: <id>]` tag. The value follows the same charset rule as a role tag's
 * provider id (any character except `]`, `|`, or whitespace), so a model id written with a space is
 * ignored rather than half-parsed — model *ids* (`claude-opus-5`, `gpt-5-codex`) don't contain
 * spaces even when their display names do. The value is passed through verbatim: unlike a provider
 * id it is never matched against anything mao knows about, so an unusable model surfaces as a
 * provider-side error when the stage runs.
 */
const MODEL_TAG_PATTERN = /\[\s*model\s*:\s*([^\]\s|]+)\s*\]/gi

/**
 * Matches a task-level `[Effort: <level>]` tag. Unlike ids, effort levels are a closed set that
 * includes a two-word value (`extra high`), so the value here may contain inner whitespace and is
 * validated against `AI_EFFORTS` after normalizing case and runs of whitespace. An unrecognized
 * level is dropped (the task simply keeps its provider's configured effort) rather than throwing —
 * consistent with the rest of this parser, which never rejects an issue body. Note validation runs
 * *after* last-occurrence-wins, not as a filter before it: a later amendment always supersedes an
 * earlier tag, so `[Effort: high]` followed by `[Effort: turbo]` yields no effort override at all
 * rather than resurrecting the superseded `high`.
 */
const EFFORT_TAG_PATTERN = /\[\s*effort\s*:\s*([^\]|]+?)\s*\]/gi

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
  return collectRoles(stripQuotedText(text ?? ''))
}

/** Role-tag collection over text that has already been through stripQuotedText(). */
function collectRoles(stripped: string): WorkflowRoleAssignment {
  const assignment: WorkflowRoleAssignment = {}
  for (const match of stripped.matchAll(ROLE_TAG_PATTERN)) {
    const role = match[1].toLowerCase() as keyof WorkflowRoleAssignment
    assignment[role] = match[2]
  }
  return assignment
}

/** Captured value of the last match of `pattern` (a repeated tag's winner), or undefined if none. */
function lastMatch(stripped: string, pattern: RegExp): string | undefined {
  let value: string | undefined
  for (const match of stripped.matchAll(pattern)) value = match[1]
  return value
}

/** Normalizes a raw `[Effort: …]` value and returns it only if it names a known level. */
function toEffort(raw: string): AiEffort | undefined {
  const normalized = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  return (AI_EFFORTS as readonly string[]).includes(normalized) ? (normalized as AiEffort) : undefined
}

/**
 * Parses every directive mao understands out of a GitHub issue/PR body and folds them into the
 * `ProviderOverride` shape the workflow engine consumes: `[Worker|Reviewer|Maintainer: <providerId>]`
 * role pins (see parseAssignmentTags) plus task-level `[Model: <id>]` / `[Effort: <level>]` tags.
 * This is what lets an auto-triggered issue — one filed on GitHub rather than enqueued through the
 * CLI, which has had `--model`/`--effort` flags all along — pin a model or reasoning effort at all.
 *
 * The same quoting rules apply to every tag (code fences, inline code, HTML comments and blockquotes
 * are stripped first) and a repeated tag keeps its last occurrence — including when that last one is
 * an unrecognized effort level, which drops the override entirely rather than falling back to the tag
 * it superseded. Returns `undefined` — not an empty object — when a body carries no directives, so
 * callers can pass the result straight through as "no override" without an emptiness check of their own.
 *
 * Note the model/effort tags are *preferences applied to whichever provider maker-checker ends up
 * choosing*, exactly like their CLI-flag equivalents: they never influence provider selection, and a
 * body that pins only a model still rotates providers the default way.
 */
export function parseProviderOverride(text: string | null | undefined): ProviderOverride | undefined {
  const stripped = stripQuotedText(text ?? '')
  const roles = collectRoles(stripped)

  const override: ProviderOverride = {}
  if (hasAssignment(roles)) override.roles = roles

  // Resolve last-occurrence-wins first, then validate that winner — never validate per match, which
  // would let an invalid amendment fall through to a superseded earlier tag (see EFFORT_TAG_PATTERN).
  const lastModel = lastMatch(stripped, MODEL_TAG_PATTERN)
  if (lastModel !== undefined) override.model = lastModel

  const lastEffort = lastMatch(stripped, EFFORT_TAG_PATTERN)
  const effort = lastEffort === undefined ? undefined : toEffort(lastEffort)
  if (effort !== undefined) override.effort = effort

  return Object.keys(override).length > 0 ? override : undefined
}

/** True when `assignment` has at least one role pinned — lets callers avoid attaching an empty override. */
export function hasAssignment(assignment: WorkflowRoleAssignment): boolean {
  return assignment.worker !== undefined || assignment.reviewer !== undefined || assignment.maintainer !== undefined
}
