import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The agent documents as a budgeted, linked system rather than a pile of prose (issue #104).
 *
 * `AGENTS.md` is loaded into every session of every tool, and a tool that caps a rule file truncates
 * whatever is past the cap without saying so. It reached 105 KB against Antigravity's 24 KB cap, so
 * three quarters of the rules were silently absent from the sessions they were written for. Nothing
 * noticed, because a document cannot fail. These assertions are what can:
 *
 * - **Budgets** keep Tier 1 and Tier 2 small enough to load whole. The caps sit above the working
 *   targets (12 KB and 8 KB), so a routine edit does not fail while a slide back into a dump does.
 * - **No re-inlining** keeps Tier 2 on demand. One `@SKILL.md` undoes the whole split at no visible cost.
 * - **Reference integrity** covers links, `@` imports, backticked repository paths and the document
 *   paths the Swarm orchestrator's prompts name. The orchestrator told every Reviewer to read two files
 *   this repository never had, and only a person reading the prompt could have seen it.
 * - **Rule numbers are frozen**, because code comments cite the eight architecture rules by number.
 *
 * Text checks, for the same reason `core/shell-queue-gate.test.ts` gives: a hand-maintained coupling
 * with no type to enforce it is better pinned imprecisely than not at all. The scanners are themselves
 * tested against fixtures below, since a scanner that matches nothing passes every assertion here.
 */
const REPO_ROOT = path.join(
  (import.meta as unknown as { dirname?: string }).dirname ?? path.join(process.cwd(), 'core'),
  '..',
)

const SKILL = '.agents/skills/mao-development/SKILL.md'
/**
 * Codex and Antigravity discover `.agents/skills/`; Claude Code looks only in `.claude/skills/`. A pointer
 * rather than a symlink, because a Windows checkout without symlink support turns a link into a text file.
 */
const CLAUDE_SKILL = '.claude/skills/mao-development/SKILL.md'
const REFERENCE_DIR = '.agents/skills/mao-development/references'
const REFERENCES = [
  'store-and-recovery.md',
  'workflow-and-routing.md',
  'repo-preflight-and-swarm.md',
  'ipc-and-renderer-testing.md',
  'shipping-and-git.md',
]
const SWARM_ORCHESTRATOR = '.agents/workflows/swarm_orchestrator.py'
const SWARM_REFERENCE = `${REFERENCE_DIR}/repo-preflight-and-swarm.md`
/** Files the orchestrator creates at runtime. They are gitignored, so they exist only after a real run. */
const SWARM_RUNTIME_PATHS = new Set(['.agents/logs/', '.agents/.prompts/', '.agents/.process_registry.json'])
const SWARM_GENERATED_PROMPT = /^dry-run-[\w-]+\.md$/

/** Issue #104's hard caps. The working targets in `AGENTS.md`'s header are lower on purpose. */
const BYTE_CAPS: Record<string, number> = {
  'AGENTS.md': 16_000,
  [SKILL]: 12_000,
  ...Object.fromEntries(REFERENCES.map((name) => [`${REFERENCE_DIR}/${name}`, 32_000])),
}

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf-8')
}

function exists(relative: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, relative))
}

function byteSize(relative: string): number {
  return fs.statSync(path.join(REPO_ROOT, relative)).size
}

/**
 * Every Markdown file under `directory`. Dot-entries and `logs` are skipped because they are runtime
 * state, not documents: the Swarm writes prompt files to `.agents/.prompts/`, and a volume without
 * native metadata support scatters `._*` AppleDouble files next to anything written to it.
 */
function markdownFilesUnder(directory: string): string[] {
  if (!exists(directory)) return []
  return fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'logs') return []
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) return markdownFilesUnder(relative)
    return entry.name.endsWith('.md') ? [relative] : []
  })
}

/** A skill's frontmatter fields, which are what a tool reads to list and choose the skill. */
function frontmatter(document: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(read(document))?.[1] ?? ''
  const fields = [...block.matchAll(/^([\w-]+):[ \t]*(.*)$/gm)]
  return Object.fromEntries(fields.map((match) => [match[1], match[2]]))
}

function agentDocuments(): string[] {
  const roots = [
    'AGENTS.md',
    'CLAUDE.md',
    'codex.md',
    'SKILL.md',
    CLAUDE_SKILL,
    '.github/pull_request_template.md',
  ]
  return [...roots.filter(exists), ...markdownFilesUnder('.agents')]
}

/** Fenced blocks, inline code and HTML comments are examples, and an import inside them never expands. */
function withoutCode(markdown: string): string {
  return withoutFences(markdown).replace(/`[^`\n]*`/g, '')
}

function withoutFences(markdown: string): string {
  return markdown
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

/** Relative link targets, inline and reference-style. A URL or a same-page anchor names no file. */
function relativeLinks(markdown: string): string[] {
  const prose = withoutCode(markdown)
  const targets = [
    ...[...prose.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g)].map(
      (match) => match[1],
    ),
    ...[...prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)].map((match) => match[1]),
  ]
  return targets
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
    .map((target) => target.replace(/[#?].*$/, ''))
}

/**
 * `@path` imports. A scoped npm package (`@octokit/app`) looks the same, so a token counts only if it
 * has a file extension or an explicit relative prefix.
 */
function atImports(markdown: string): string[] {
  return [...withoutCode(markdown).matchAll(/(?:^|\s)@([^\s`]+)/gm)]
    .map((match) => match[1].replace(/[.,;:)]+$/, ''))
    .filter((token) => /^\.{0,2}\//.test(token) || /\.[A-Za-z0-9]+$/.test(token))
}

/**
 * Whole backticked tokens that name a repository path. Placeholders and globs are not paths. A prefix
 * list rather than "anything with a slash", because prose also backticks `owner/repo` and `git push`.
 */
function backtickedRepoPaths(markdown: string): string[] {
  const rooted = /^(?:\.agents|\.claude|\.codex|\.github|cli|core|electron|scripts|src)\/[\w./-]*$/
  const rootFiles = new Set([
    'AGENTS.md',
    'CLAUDE.md',
    'SKILL.md',
    'codex.md',
    'package.json',
    'vite.config.ts',
    'vitest.config.ts',
  ])
  return [...withoutFences(markdown).matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1].replace(/:\d+$/, ''))
    .filter((token) => rooted.test(token) || rootFiles.has(token))
}

/**
 * Every document-like path a non-Markdown source names, wherever in the file it appears. Deliberately
 * not limited to the text of a prompt: a prompt is assembled from constants and f-strings, so "the
 * prompt" is not something a text scan can isolate, and a path that does not exist is wrong in a
 * comment too.
 */
function documentPathsIn(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/\.agents\/[\w./-]*|[\w./-]+\.md\b/g)) {
    found.add(match[0].replace(/\.+$/, ''))
  }
  return [...found]
}

function resolvesInsideRepo(fromDocument: string, target: string): string | null {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromDocument), target))
  return resolved.startsWith('../') || path.posix.isAbsolute(resolved) ? null : resolved
}

function brokenReferences(document: string): string[] {
  const markdown = read(document)
  const broken: string[] = []
  for (const target of [...relativeLinks(markdown), ...atImports(markdown)]) {
    const resolved = resolvesInsideRepo(document, target)
    if (resolved === null || !exists(resolved)) broken.push(`${document} -> ${target}`)
  }
  for (const repoPath of backtickedRepoPaths(markdown)) {
    if (exists(repoPath) || SWARM_RUNTIME_PATHS.has(repoPath)) continue
    broken.push(`${document} -> \`${repoPath}\``)
  }
  return broken
}

describe('the reference scanners', () => {
  it('finds relative links in both syntaxes and ignores URLs, anchors and examples', () => {
    const markdown = [
      '[inline](./a.md) ![image](img/b.png) [titled](c.md "Title") [anchored](d.md#section)',
      '[external](https://example.com/e.md) [mail](mailto:x@example.com) [same page](#f)',
      '`[code span](g.md)`',
      '<!-- [comment](h.md) -->',
      '```',
      '[fenced](i.md)',
      '```',
      '[definition]: j.md',
    ].join('\n')
    expect(relativeLinks(markdown)).toEqual(['./a.md', 'img/b.png', 'c.md', 'd.md', 'j.md'])
  })

  it('finds @ imports without mistaking a scoped package or an address for one', () => {
    const markdown = [
      '@AGENTS.md',
      'then @../../SKILL.md, and @./notes/x.md.',
      '@octokit/app and @types/node are packages; so is `@AGENTS.md` an example.',
      'mail kmg@example.md is not an import.',
    ].join('\n')
    expect(atImports(markdown)).toEqual(['AGENTS.md', '../../SKILL.md', './notes/x.md'])
  })

  it('finds backticked repository paths and skips placeholders, globs and prose', () => {
    const markdown =
      '`core/app.ts` `core/app.ts:41` `.agents/rules/` `.claude/skills/` `AGENTS.md` ' +
      '`src/components/<Name>.test.tsx` `core/**/*.test.ts` `owner/repo` `git push` `config.json` ' +
      '`dist-cli/index.cjs`'
    expect(backtickedRepoPaths(markdown)).toEqual([
      'core/app.ts',
      'core/app.ts',
      '.agents/rules/',
      '.claude/skills/',
      'AGENTS.md',
    ])
  })

  it('finds the document paths the orchestrator used to name, including a bare directory', () => {
    const source = [
      'f"Read AGENTS.md and .agents/rules/review_checklist.md for review rules.\\n"',
      'f"Read AGENTS.md and .agents/rules/ for all project rules.\\n"',
      'PROMPT_DIR / "dry-run-worker.md"',
    ].join('\n')
    expect(documentPathsIn(source).sort()).toEqual(
      ['.agents/rules/', '.agents/rules/review_checklist.md', 'AGENTS.md', 'dry-run-worker.md'].sort(),
    )
  })

  it('refuses a link that climbs out of the repository', () => {
    expect(resolvesInsideRepo('.agents/rules/x.md', '../../AGENTS.md')).toBe('AGENTS.md')
    expect(resolvesInsideRepo('AGENTS.md', '../outside.md')).toBeNull()
  })
})

describe('the context budgets', () => {
  it.each(Object.entries(BYTE_CAPS))('%s stays within its byte cap', (document, cap) => {
    expect(byteSize(document)).toBeLessThanOrEqual(cap)
  })

  it('keeps the tool entry points as pointers', () => {
    for (const entry of ['CLAUDE.md', 'codex.md', 'SKILL.md', CLAUDE_SKILL]) {
      expect(read(entry).trimEnd().split('\n').length, entry).toBeLessThanOrEqual(10)
    }
  })
})

describe('re-inlining', () => {
  it('leaves AGENTS.md as the only document an entry point inlines', () => {
    expect(atImports(read('CLAUDE.md'))).toEqual(['AGENTS.md'])
    expect(atImports(read('codex.md'))).toEqual([])
    expect(atImports(read('SKILL.md'))).toEqual([])
    expect(atImports(read(SKILL))).toEqual([])
    expect(atImports(read(CLAUDE_SKILL))).toEqual([])
  })

  it('never re-inlines a root document from anywhere under .agents', () => {
    const offenders = markdownFilesUnder('.agents').flatMap((document) =>
      atImports(read(document))
        .map((target) => resolvesInsideRepo(document, target))
        .filter((resolved) => resolved === 'AGENTS.md' || resolved === 'SKILL.md')
        .map((resolved) => `${document} -> ${resolved}`),
    )
    expect(offenders).toEqual([])
  })

  it('does not require the on-demand playbook up front in the Codex configuration', () => {
    const config = read('.codex/config.toml')
    expect(config).toContain('AGENTS.md')
    expect(config).not.toMatch(/AGENTS\.md and SKILL\.md/)
    expect(documentPathsIn(config).filter((target) => !exists(target))).toEqual([])
  })

  it('keeps the retired always-loaded rule files retired', () => {
    expect(exists('.agents/rules/pointers.md')).toBe(false)
    expect(exists('.agents/rules/git-conventions.md')).toBe(false)
  })
})

describe('reference integrity', () => {
  it('resolves every link, import and repository path in every agent document', () => {
    expect(agentDocuments().flatMap(brokenReferences)).toEqual([])
  })

  it('scans the documents this suite claims to, so the assertion above cannot pass empty', () => {
    expect(agentDocuments()).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'CLAUDE.md',
        'codex.md',
        '.github/pull_request_template.md',
        SKILL,
        CLAUDE_SKILL,
        ...REFERENCES.map((name) => `${REFERENCE_DIR}/${name}`),
      ]),
    )
    expect(relativeLinks(read('AGENTS.md')).length).toBeGreaterThanOrEqual(REFERENCES.length)
    expect(backtickedRepoPaths(read('AGENTS.md')).length).toBeGreaterThan(10)
  })

  it('names only documents that exist, in the Swarm orchestrator', () => {
    const named = documentPathsIn(read(SWARM_ORCHESTRATOR))
    expect(named).toEqual(expect.arrayContaining(['AGENTS.md', SWARM_REFERENCE]))
    const missing = named.filter(
      (target) => !exists(target) && !SWARM_RUNTIME_PATHS.has(target) && !SWARM_GENERATED_PROMPT.test(target),
    )
    expect(missing).toEqual([])
  })

  it('holds the two sections the Reviewer prompt sends agents to', () => {
    const headings = read(SWARM_REFERENCE)
      .split('\n')
      .filter((line) => line.startsWith('## '))
    expect(headings).toEqual(expect.arrayContaining(['## Role assignment', '## Review checklist']))
  })

  it('routes to every reference from both tiers above it, leaving no orphan', () => {
    const present = markdownFilesUnder(REFERENCE_DIR).map((document) => path.posix.basename(document))
    expect(present).toEqual(expect.arrayContaining(REFERENCES))
    const skillLinks = relativeLinks(read(SKILL)).map((target) => path.posix.normalize(target))
    const agentsLinks = relativeLinks(read('AGENTS.md')).map((target) => path.posix.normalize(target))
    for (const name of present) {
      expect(skillLinks, `${SKILL} -> ${name}`).toContain(`references/${name}`)
      expect(agentsLinks, `AGENTS.md -> ${name}`).toContain(`${REFERENCE_DIR}/${name}`)
    }
    expect(agentsLinks).toContain(SKILL)
  })

  it.each([SKILL, CLAUDE_SKILL])('keeps %s loadable as the mao-development skill', (document) => {
    expect(frontmatter(document).name).toBe('mao-development')
    expect(frontmatter(document).description).toMatch(/^\S/)
  })

  it('gives Claude Code a pointer to the playbook rather than a second copy of it', () => {
    // The tools choose a skill by its description, so a drifted copy would route Claude differently.
    expect(frontmatter(CLAUDE_SKILL).description).toBe(frontmatter(SKILL).description)
    const links = relativeLinks(read(CLAUDE_SKILL))
    expect(links.map((target) => resolvesInsideRepo(CLAUDE_SKILL, target))).toContain(SKILL)
  })
})

describe('the architecture rules', () => {
  /**
   * Comments across `core/`, `cli/`, `electron/`, `src/` and `vitest.config.ts` cite these by number
   * ("architecture rule 3"), so renumbering one silently repoints every citation. Pinned by subject,
   * because a number that survives on a different rule is the failure this exists to catch.
   */
  const SUBJECTS: Array<[number, RegExp]> = [
    [1, /stays Electron-free/],
    [2, /Business logic lives in `core\/`/],
    [3, /`createMaoApp\(\)`.*is the only boot path/],
    [4, /`resume` flag is deliberately required/],
    [5, /Never start the auto-trigger poller inside `createMaoApp\(\)`/],
    [6, /Renderer isolation/],
    [7, /Electron security posture/],
    [8, /`core\/` tests must stay runnable under plain Node/],
  ]
  /** Only this section's list: `AGENTS.md` numbers other lists too, so `1.` alone proves nothing. */
  function architectureRules(): string[] {
    const [, section = ''] = read('AGENTS.md').split('## Non-negotiable architecture rules\n')
    const [rules = ''] = section.split(/^## /m)
    return rules.split('\n').filter((line) => /^\d+\. /.test(line))
  }

  it.each(SUBJECTS)('keeps rule %i on its subject', (number, subject) => {
    expect(architectureRules().find((line) => line.startsWith(`${number}. `))).toMatch(subject)
  })

  it('has exactly the eight rules the code cites', () => {
    expect(architectureRules().map((line) => Number.parseInt(line, 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('the pull request template', () => {
  it('lists the lockstep files the rules actually require', () => {
    const template = read('.github/pull_request_template.md')
    for (const required of [
      'src/test/electron-api-stub.ts',
      'core/ai/types.ts',
      'AGENT_STAGES',
      'src/components/GlobalSettings.tsx',
      'STORED_SHAPE_RULES',
    ]) {
      expect(template, required).toContain(required)
    }
    expect(template).not.toContain('STAGE_ORDER')
  })
})
