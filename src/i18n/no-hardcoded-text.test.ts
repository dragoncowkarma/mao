import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every word the renderer shows has to come from the message catalogs (`src/i18n/messages/`), or
 * switching the language leaves it behind in English — and nothing else would notice: `tsc` accepts a
 * literal, and every existing renderer test reads English anyway.
 *
 * Read through the TypeScript AST, like `src/electron-ipc-surface.test.ts`, for the same reason: a
 * regex over TSX cannot tell `<p>Saved</p>` from `className="saved"` or from the `'running'` in
 * `task.status === 'running'`, so it would either miss real text or bury it in noise until someone
 * deleted the test.
 *
 * What counts as user-visible text in a component file:
 * - JSX text containing a letter (an HTML entity such as `&gt;` is not a letter);
 * - a letter-bearing string on any JSX attribute that is not a known non-display attribute — fail
 *   closed, so a new display prop (`actionLabel="Run"`) counts without anyone having to list it. The
 *   non-display list is about DOM attributes, so it applies to intrinsic elements only: a component's
 *   `name` or `value` prop is whatever that component makes of it, and only `key` is exempt there;
 * - a letter-bearing literal a `{…}` expression renders, through `c ? 'a' : 'b'`, `a || 'b'`,
 *   `a ?? 'b'`, `x && 'b'`, `'a' + b` or a template — but not a literal that is only compared
 *   (`status === 'running'`) or passed to a call (`githubState('closed')`);
 * - the message of `new Error(…)` and the text of `confirm(…)`/`alert(…)`, written as literals — and a
 *   plain `Error` built from the catalog (`new Error(messages.…)`), which freezes the wording in the
 *   language of the moment; text MAO words itself is thrown as a `WordedError`;
 * - an object literal's `label` written as a literal (option lists).
 *
 * What it cannot see is text a helper assembles and hands around as a plain value outside those
 * shapes — `setStatus('Saved')` looks exactly like `setView('project')`, and a literal passed to a
 * call (`workflowBadge.failed('Merge')`) looks exactly like a key (`githubState('closed')`). The
 * Korean sweep in `src/i18n/korean-sweep.test.tsx` covers those from the rendered side; anything it
 * does not render stays a review item;
 * the catalogs' own typing (`const ko: typeof en`) still guarantees that every key a component does
 * read exists in every language.
 */

const HERE = (import.meta as unknown as { dirname?: string }).dirname
/** `src/`, anchored to this file rather than to wherever vitest was started (see electron-api.test.ts). */
const SRC = HERE ? join(HERE, '..') : join(process.cwd(), 'src')

/**
 * Attributes whose string values never reach the screen. Everything else is treated as display text,
 * which is the safe direction: a false positive here costs one entry with a reason, a false negative
 * costs an untranslated label nobody notices. `value` is listed because every use in `src/` is an
 * `<option>`/`<select>`/`<input>` value — revisit it before writing `<input type="button" value=…>`.
 */
const NON_DISPLAY_ATTRIBUTES = new Set([
  'className',
  'key',
  'id',
  'htmlFor',
  'type',
  'role',
  'value',
  'name',
  'href',
  'target',
  'rel',
  'style',
  'src',
  'lang',
  'dir',
  'tabIndex',
  'min',
  'max',
  'step',
  'autoComplete',
  'inputMode',
])

/** ARIA *states* and references are machine values; ARIA *labels* and descriptions are text. */
const ARIA_TEXT_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
])

function isDisplayAttribute(name: string, intrinsic: boolean): boolean {
  if (!intrinsic) return name !== 'key'
  if (NON_DISPLAY_ATTRIBUTES.has(name) || name.startsWith('data-')) return false
  if (name.startsWith('aria-')) return ARIA_TEXT_ATTRIBUTES.has(name)
  return true
}

/** `<div>` and `<svg:path>` are DOM; `<Sidebar>` and `<ui.Button>` are components. */
function isIntrinsic(attribute: ts.JsxAttribute): boolean {
  const element = attribute.parent.parent
  const tag = ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? element.tagName : undefined
  return tag !== undefined && ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)
}

/** Whether an expression reads the message catalog: `messages.x.y`, or a call or template built on it. */
function readsCatalog(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'messages') return true
  return ts.forEachChild(node, readsCatalog) ?? false
}

const ENTITY = /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi

function hasLetter(text: string): boolean {
  return /\p{L}/u.test(text.replace(ENTITY, ''))
}

/** The literal text parts a value-producing expression can put on screen. */
function renderedLiterals(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return renderedLiterals(node.expression)
  }
  if (ts.isConditionalExpression(node)) return [...renderedLiterals(node.whenTrue), ...renderedLiterals(node.whenFalse)]
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return renderedLiterals(node.right)
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.PlusToken
    ) {
      return [...renderedLiterals(node.left), ...renderedLiterals(node.right)]
    }
  }
  return []
}

function isDialogCall(node: ts.CallExpression): boolean {
  const callee = node.expression
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
  return name === 'confirm' || name === 'alert'
}

/** Each hardcoded user-visible text in one source file, as `line: text`. */
function findHardcodedText(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []

  function report(node: ts.Node, texts: string[]) {
    const text = texts.filter(hasLetter).join(' … ').replace(/\s+/g, ' ').trim()
    if (!text) return
    // JSX text owns its leading newline and indentation, so point at its first visible character.
    const start = ts.isJsxText(node) ? node.pos + node.text.search(/\S/) : node.getStart(file)
    const line = file.getLineAndCharacterOfPosition(start).line + 1
    found.push(`${line}: ${text}`)
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node)) {
      report(node, [node.text])
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file)
      const value = node.initializer
      if (value && isDisplayAttribute(name, isIntrinsic(node))) {
        if (ts.isStringLiteral(value)) report(node, [value.text])
        else if (ts.isJsxExpression(value) && value.expression) report(node, renderedLiterals(value.expression))
      }
      // A non-display attribute's expression (`className={a ? 'x' : 'y'}`) is skipped as a whole, but
      // an element nested in an attribute is still JSX and still visited below.
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      report(node, renderedLiterals(node.expression))
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Error') {
      const message = node.arguments?.[0]
      if (message && readsCatalog(message)) report(node, ['catalog text in a plain Error — throw a WordedError'])
      else if (message) report(node, renderedLiterals(message))
    } else if (ts.isCallExpression(node) && isDialogCall(node)) {
      const message = node.arguments[0]
      if (message) report(node, renderedLiterals(message))
    } else if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'label') {
      report(node, renderedLiterals(node.initializer))
    }
    ts.forEachChild(node, visit)
  }

  visit(file)
  return found
}

function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'test' && dir === SRC ? [] : componentFiles(path)
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : []
  })
}

describe('findHardcodedText', () => {
  const flagged = (snippet: string) => findHardcodedText('fixture.tsx', snippet)

  it.each([
    ['JSX text', '<p>Saved</p>'],
    ['JSX text in any script', '<p>저장됨</p>'],
    ['a display attribute', '<input placeholder="owner" />'],
    ['an ARIA label', '<button aria-label="Close" />'],
    ['a custom display prop', '<Controls actionLabel="Run next stage" />'],
    ['a ternary in an attribute', "<b title={open ? 'Open' : 'Closed'} />"],
    ['a ternary child', "<p>{busy ? 'Saving…' : label}</p>"],
    ['a fallback child', "<p>{reason || 'Unknown'}</p>"],
    ['a nullish fallback child', "<p>{reason ?? 'Unknown'}</p>"],
    ['a conditional child', "<p>{show && 'Visible'}</p>"],
    ['a template child', '<p>{`${count} active`}</p>'],
    ['a concatenated child', "<p>{'Remove ' + name}</p>"],
    ['an Error message', "throw new Error('Nothing was written')"],
    ['a template Error message', 'throw new Error(`${count} task(s) failed`)'],
    ['a confirm dialog', "window.confirm('Restart anyway?')"],
    ['a bare alert', 'alert(`Failed: ${reason}`)'],
    ['an option label', "const options = [{ value: 'light', label: 'Light' }]"],
    ['a component prop named like a DOM attribute', '<AgentBadge name="Claude" />'],
    ['a value prop on a component', '<Meter value="Almost done" />'],
    ['catalog text frozen into a plain Error', 'throw new Error(messages.app.queueOutcome.restartRequired)'],
    ['catalog text built into a plain Error', 'throw new Error(messages.app.reason(code))'],
  ])('flags %s', (_name, snippet) => {
    expect(flagged(snippet)).toHaveLength(1)
  })

  it.each([
    ['catalog text', '<p>{messages.sidebar.projects}</p>'],
    ['a catalog function', '<p>{messages.common.activeCount(n)}</p>'],
    ['non-display attributes', '<div className="flex items-center" key="a" role="button" id="x" />'],
    ['link plumbing', '<a href="https://github.com" target="_blank" rel="noreferrer" />'],
    ['a class-name ternary', "<div className={active ? 'card card-active' : 'card'} />"],
    ['ARIA states and data attributes', '<input type="checkbox" aria-hidden="true" data-kind="x" />'],
    ['an option value', '<option value="anthropic">{label}</option>'],
    ['a comparison guarding an element', "<p>{task.status === 'running' && <span />}</p>"],
    ['a literal passed to a call', "<p>{messages.common.githubState('closed')}</p>"],
    ['symbols and entities', '<p>{a} -&gt; {b} · → ↗ ▶ # / ( )</p>'],
    ['an explicit space', "<p>{a}{' '}{b}</p>"],
    ['a WordedError, which re-words itself', 'throw new WordedError((m) => m.app.superseded, messages)'],
    ['an Error carrying text that arrived worded', 'throw new Error(outcome.reason)'],
    ['a key on a component', '<Item key="a" />'],
    ['a DOM name and value', '<input name="owner" value="x" />'],
    ['a label read from the catalog', 'const options = [{ value: x, label: messages.globalSettings.light }]'],
  ])('passes %s', (_name, snippet) => {
    expect(flagged(snippet)).toEqual([])
  })

  it('reports the line and the text', () => {
    expect(findHardcodedText('fixture.tsx', 'const a = 1\nconst b = <p>\n  Hello there\n</p>\n')).toEqual([
      '3: Hello there',
    ])
  })
})

describe('renderer components', () => {
  it('take every user-visible string from the message catalogs', () => {
    const files = componentFiles(SRC)
    // A guard that scanned nothing would pass forever: App, main and the component files must be here.
    expect(files.length).toBeGreaterThanOrEqual(10)

    const offenders = files.flatMap((path) =>
      findHardcodedText(path, readFileSync(path, 'utf-8')).map(
        (hit) => `${relative(SRC, path).split(sep).join('/')}:${hit}`,
      ),
    )
    expect(offenders).toEqual([])
  })
})
