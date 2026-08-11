import { describe, expect, it } from 'vitest'
import { hasAssignment, parseAssignmentTags } from './assignment.ts'

describe('parseAssignmentTags', () => {
  it('parses Worker/Reviewer/Maintainer tags out of free-form text', () => {
    const body = 'Please fix the bug.\n\n[Worker: agent-cli]\nSome more context.\n[Reviewer: agent-cli2]'
    expect(parseAssignmentTags(body)).toEqual({ worker: 'agent-cli', reviewer: 'agent-cli2' })
  })

  it('parses all three roles together', () => {
    const body = '[Worker: agent-a] [Reviewer: agent-b] [Maintainer: agent-b]'
    expect(parseAssignmentTags(body)).toEqual({ worker: 'agent-a', reviewer: 'agent-b', maintainer: 'agent-b' })
  })

  it('is case-insensitive on the role keyword', () => {
    expect(parseAssignmentTags('[worker: agent-a] [MAINTAINER: agent-b]')).toEqual({
      worker: 'agent-a',
      maintainer: 'agent-b',
    })
  })

  it('returns an empty object when no tags are present', () => {
    expect(parseAssignmentTags('just a normal issue body, nothing tagged here')).toEqual({})
  })

  it('handles null/undefined/empty input without throwing', () => {
    expect(parseAssignmentTags(undefined)).toEqual({})
    expect(parseAssignmentTags(null)).toEqual({})
    expect(parseAssignmentTags('')).toEqual({})
  })

  it('keeps the last occurrence when a role tag appears more than once', () => {
    expect(parseAssignmentTags('[Worker: agent-a] ... edit: [Worker: agent-b]')).toEqual({ worker: 'agent-b' })
  })

  it('ignores malformed tags (missing colon, empty id, unknown role keyword)', () => {
    expect(parseAssignmentTags('[Worker] [Reviewer:] [Owner: agent-a]')).toEqual({})
  })
})

describe('hasAssignment', () => {
  it('is false for an empty assignment and true once any role is set', () => {
    expect(hasAssignment({})).toBe(false)
    expect(hasAssignment({ worker: 'agent-a' })).toBe(true)
    expect(hasAssignment({ reviewer: 'agent-a' })).toBe(true)
    expect(hasAssignment({ maintainer: 'agent-a' })).toBe(true)
  })
})
