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

  it('accepts ids containing characters other than letters/digits/dot/underscore/hyphen, e.g. a slash', () => {
    expect(parseAssignmentTags('[Worker: openai/gpt-4]')).toEqual({ worker: 'openai/gpt-4' })
    expect(parseAssignmentTags('[Reviewer: team@bot]')).toEqual({ reviewer: 'team@bot' })
  })

  it('does not match an id containing a space (ambiguous — cannot tell where the id ends)', () => {
    expect(parseAssignmentTags('[Worker: my provider]')).toEqual({})
    // a malformed tag doesn't swallow or corrupt a well-formed sibling tag
    expect(parseAssignmentTags('[Worker: my provider] [Reviewer: agent-b]')).toEqual({ reviewer: 'agent-b' })
  })

  it('ignores a tag written inside a backtick-fenced code block', () => {
    const body = 'Here is the format:\n```\n[Worker: example-id]\n```\nDon\'t assign anyone yet.'
    expect(parseAssignmentTags(body)).toEqual({})
  })

  it('ignores a tag written inside a tilde-fenced code block (GFM allows ~~~ as well as ```)', () => {
    const body = 'Here is the format:\n~~~\n[Worker: example-id]\n~~~\nDon\'t assign anyone yet.'
    expect(parseAssignmentTags(body)).toEqual({})
  })

  it('does NOT treat a stray fence-like substring mid-prose as a real fence, and preserves a real tag between two such occurrences', () => {
    const body = 'Decorative ~~~ marker\n[Worker: agent-real]\n~~~ not a closing fence'
    expect(parseAssignmentTags(body)).toEqual({ worker: 'agent-real' })
  })

  it('ignores a tag written inside an inline code span', () => {
    expect(parseAssignmentTags('Use the tag like `[Worker: example-id]` in your issue.')).toEqual({})
  })

  it('ignores a tag hidden inside an HTML comment', () => {
    expect(parseAssignmentTags('<!-- [Worker: hidden-id] -->\nActual issue body here.')).toEqual({})
  })

  it('ignores a tag inside a blockquoted line', () => {
    expect(parseAssignmentTags('> Someone quoted: [Worker: quoted-id]')).toEqual({})
  })

  it('still matches a real tag that merely sits alongside quoted example text', () => {
    const body =
      'Format reference: `[Worker: example-id]` (just an example).\n\n' +
      'Real assignment:\n[Worker: agent-real] [Reviewer: agent-real-2]'
    expect(parseAssignmentTags(body)).toEqual({ worker: 'agent-real', reviewer: 'agent-real-2' })
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
