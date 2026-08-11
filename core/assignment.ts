import type { WorkflowRoleAssignment } from './workflow-engine.ts'

/**
 * Matches swarm_orchestrator.py-style role metadata tags: `[Worker: <id>]`, `[Reviewer: <id>]`,
 * `[Maintainer: <id>]`. Unlike swarm_orchestrator's `[Worker: <ai> | Model: <model> | Reasoning:
 * <reasoning>]` tags, mao's carry only a provider id — model/effort already live on that provider's
 * own registered config (see AiProviderConfig), so there's nothing else to parse out of the tag.
 * The id itself is taken verbatim here; it's matched against registered provider ids at selection
 * time (`WorkflowEngine.selectAgent()`), not during parsing, so an unknown id surfaces as a normal
 * retryable task error rather than being silently dropped.
 */
const ROLE_TAG_PATTERN = /\[\s*(worker|reviewer|maintainer)\s*:\s*([a-zA-Z0-9._-]+)\s*\]/gi

/**
 * Parses role-assignment tags out of free-form text (a GitHub issue or PR body/comment). A role that
 * appears more than once keeps its last occurrence, so an editor can amend an existing tag by simply
 * appending a new one further down rather than needing to edit the original in place. Returns an
 * empty object (never throws) when no tags are present — callers should treat that as "no explicit
 * assignment" and fall back to the default maker-checker rotation.
 */
export function parseAssignmentTags(text: string | null | undefined): WorkflowRoleAssignment {
  const assignment: WorkflowRoleAssignment = {}
  for (const match of (text ?? '').matchAll(ROLE_TAG_PATTERN)) {
    const role = match[1].toLowerCase() as keyof WorkflowRoleAssignment
    assignment[role] = match[2]
  }
  return assignment
}

/** True when `assignment` has at least one role pinned — lets callers avoid attaching an empty override. */
export function hasAssignment(assignment: WorkflowRoleAssignment): boolean {
  return assignment.worker !== undefined || assignment.reviewer !== undefined || assignment.maintainer !== undefined
}
