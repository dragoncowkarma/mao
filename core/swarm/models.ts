import { stripQuotedText } from '../assignment.ts'
import {
  AGY_EFFORT_SUFFIX,
  AGY_FALLBACK_STEM,
  REASONING_LADDER,
  UNIDENTIFIED_EFFORT_CEILING,
  agyStemEfforts,
  buildModelEffortArgs,
  findCatalogModel,
  isEligibleAgyStem,
  modelEfforts,
  resolveReasoning,
  type ModelCatalogSnapshot,
} from '../ai/provider-options.ts'

export type SwarmAi = 'codex' | 'antigravity' | 'claude'
export type LifecycleRole = 'worker' | 'worker_revise' | 'reviewer' | 'maintainer'
export interface RoleAssignment { ai: string; model: string; reasoning: string; customModel?: boolean }

/** Defaults used only for autonomous Swarm tags; saved workflow provider configs remain operator-owned. */
export const DEFAULT_AI_CONFIG: Record<SwarmAi, RoleAssignment> = {
  codex: { ai: 'codex', model: 'gpt-6.1-terra', reasoning: 'high' },
  antigravity: { ai: 'antigravity', model: 'gemini-3.8-flash', reasoning: 'high' },
  claude: { ai: 'claude', model: 'claude-sonnet-5-5', reasoning: 'high' },
}

export const DEFAULT_ROTATION: Record<SwarmAi, { reviewer: SwarmAi; maintainer: SwarmAi }> = {
  codex: { reviewer: 'antigravity', maintainer: 'claude' },
  antigravity: { reviewer: 'claude', maintainer: 'codex' },
  claude: { reviewer: 'codex', maintainer: 'antigravity' },
}

/** Reuse the workflow parser's quotation boundary and last-amendment-wins semantics. */
export function parseRole(body: string | null | undefined, role: string): RoleAssignment | undefined {
  if (!['worker', 'reviewer', 'maintainer'].includes(role.toLowerCase())) return undefined
  const pattern = new RegExp(`\\[${role}:\\s*(\\w+)\\s*\\|\\s*Model:\\s*([^|]+?)\\s*\\|\\s*Reasoning:\\s*([^\\]]+?)\\]`, 'gi')
  let assignment: RoleAssignment | undefined
  for (const match of stripQuotedText(body ?? '').matchAll(pattern)) {
    assignment = { ai: match[1].toLowerCase(), model: match[2].trim(), reasoning: match[3].trim() }
  }
  return assignment
}

export function validateDistinctRoles(
  worker?: RoleAssignment, reviewer?: RoleAssignment, maintainer?: RoleAssignment,
): void {
  const seen = new Set<string>()
  for (const assignment of [worker, reviewer, maintainer]) {
    if (!assignment) continue
    const ai = assignment.ai.toLowerCase()
    if (!Object.hasOwn(DEFAULT_AI_CONFIG, ai)) throw new Error('Unknown Swarm AI provider')
    if (seen.has(ai)) throw new Error('Swarm Worker, Reviewer and Maintainer must use distinct AI providers')
    seen.add(ai)
  }
}

/** Lower-cased, whitespace collapsed: `Opus  5.5` and `opus 5.5` are one tag. */
const aliasKey = (model: string) => model.trim().toLowerCase().replace(/\s+/g, ' ')

const CODEX_ALIASES: Record<string, string> = {}
const codexAlias = (target: string, ...aliases: string[]) => {
  for (const alias of [target, ...aliases]) CODEX_ALIASES[alias] = target
}
codexAlias('gpt-6.2-sol', '6.2 sol', '6.2 (sol)', 'sol', '6.2', 'gpt-6.2')
codexAlias('gpt-6.2-astra', '6.2 astra', '6.2 (astra)', 'astra')
codexAlias('gpt-6.1-terra', '6.1 terra', '6.1 (terra)', 'terra', '6.1', 'gpt-6.1')
codexAlias('gpt-6.1-sol', '6.1 sol', '6.1 (sol)')
codexAlias('gpt-6-astra', '6 astra', '6 (astra)')
codexAlias('gpt-6-sol', '6 sol', '6 (sol)', '6', 'gpt-6')
codexAlias('gpt-6-luna', '6 luna', '6 (luna)', 'luna')
for (const variant of ['sol', 'terra', 'luna']) codexAlias(`gpt-5.6-${variant}`, `5.6 ${variant}`, `5.6 (${variant})`)
for (const alias of ['5.6', 'gpt-5.6', '5.6 (sol, terra, luna)']) CODEX_ALIASES[alias] = 'gpt-5.6-terra'
// Retired generations follow the current default's family, as they followed 5.6 while it was current.
for (const old of ['5.5', '5.4', '5.3', '5.2', '5.1']) {
  for (const alias of [old, `gpt-${old}`, `gpt-${old}-codex`]) CODEX_ALIASES[alias] = 'gpt-6.1-terra'
}
for (const alias of ['5.4 mini', 'gpt-5.4-mini', '5.6 spark', 'gpt-5.6-spark']) CODEX_ALIASES[alias] = 'gpt-6-luna'
CODEX_ALIASES['gpt-5.1-codex-max'] = 'gpt-6.1-terra'
CODEX_ALIASES['gpt-5-1-codex'] = 'gpt-6.1-terra'

const CLAUDE_ALIASES: Record<string, string> = {}
for (const [family, version, id] of [
  ['opus', '5.5', 'claude-opus-5-5'], ['sonnet', '5.5', 'claude-sonnet-5-5'],
  ['fable', '5.2', 'claude-fable-5-2'], ['haiku', '5.5', 'claude-haiku-5-5'],
] as const) {
  for (const alias of [id, family, `${family} ${version}`, `claude ${family} ${version}`, `claude-${family}-${version}`]) {
    CLAUDE_ALIASES[alias] = id
  }
}
// Earlier generations resolve to the newest model of their family. `custom:<id>` still pins one exactly.
const claudeLegacy = (target: string, ...aliases: string[]) => {
  for (const alias of aliases) CLAUDE_ALIASES[alias] = target
}
claudeLegacy('claude-opus-5-5', 'opus 5', 'claude opus 5', 'claude-opus-5')
for (const version of ['4.8', '4.7', '4.6', '4.5', '4.1', '4']) {
  claudeLegacy('claude-opus-5-5', `opus ${version}`, `claude-opus-${version.replace('.', '-')}`)
}
claudeLegacy('claude-sonnet-5-5', 'sonnet 5', 'claude sonnet 5', 'claude-sonnet-5')
for (const version of ['4.6', '4.5', '4', '3.7', '3.5']) {
  const hyphenated = version.replace('.', '-')
  claudeLegacy('claude-sonnet-5-5', `sonnet ${version}`, `claude ${version} sonnet`, `claude-${version}-sonnet`,
    `claude-${hyphenated}-sonnet`, `claude-sonnet-${hyphenated}`)
}
claudeLegacy('claude-fable-5-2', 'fable 5', 'claude fable 5', 'claude-fable-5', 'fable 5.1', 'claude-fable-5-1')
claudeLegacy('claude-haiku-5-5', 'haiku 4.5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  'haiku 3.5', 'claude 3.5 haiku', 'claude-3-5-haiku', 'claude-3.5-haiku')

const AGY_ALIASES: Record<string, string> = {
  'gemini-4-neon': 'gemini-4-neon', neon: 'gemini-4-neon',
  'gemini-4-hydrogen': 'gemini-4-hydrogen', hydrogen: 'gemini-4-hydrogen',
  'gemini-4-argon': 'gemini-4-argon', argon: 'gemini-4-argon',
  'gemini-3.1-pro': 'gemini-4-argon', 'gemini-3-pro': 'gemini-4-argon', 'gemini-pro': 'gemini-4-argon',
  'gemini-3.8-flash': 'gemini-3.8-flash', 'gemini-3.6-flash': 'gemini-3.8-flash',
  'gemini-3.7-flash': 'gemini-3.8-flash', 'gemini-flash': 'gemini-3.8-flash',
  // Foreign families agy also serves, recognized so they redirect to Gemini rather than read as typos.
  'claude-opus-5.5': 'claude-opus-5-5', 'claude-sonnet-5.5': 'claude-sonnet-5-5',
  'gpt-oss-120b': 'gpt-oss-120b', 'claude-opus-5-5': 'claude-opus-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-5-5',
}

const FOREIGN_AGY = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b'])
const ownValue = (table: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined
/** An agy tag as slug text: lower-cased, with spaces, underscores and parentheses turned into hyphens. */
const agyKey = (model: string) =>
  model.trim().toLowerCase().replace(/[\s_()]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
/** Gemini only, never an orchestrator, never a foreign family: the Antigravity half of maker-checker. */
const eligibleAgy = (stem: string) => isEligibleAgyStem(stem) && !FOREIGN_AGY.has(stem)

/** The stem an agy tag names, through the alias table, then a refreshed `agy models` list. */
function agyStem(model: string, catalog?: ModelCatalogSnapshot): string | undefined {
  const key = agyKey(model)
  const bare = key.replace(AGY_EFFORT_SUFFIX, '')
  const alias = ownValue(AGY_ALIASES, key) ?? ownValue(AGY_ALIASES, bare)
  if (alias) return alias
  return [key, bare].find((candidate) => eligibleAgy(candidate) && findCatalogModel(catalog, 'antigravity', candidate))
}

/**
 * A foreign model cannot evade maker-checker by being served through agy, and neither can an orchestrator
 * that would forward the prompt to one: both fall back to Gemini Flash. The level clamps to what agy
 * lists for the stem — Neon and Hydrogen reach `xhigh`, Argon and Flash `high`, an unknown custom Gemini
 * `high` — and travels as the slug's suffix, never as an `--effort` flag.
 *
 * A custom Gemini id names its own stem: it is never re-aliased (`custom:gemini-3-pro` stays Gemini 3 Pro,
 * where the prose tag means Argon), only re-suffixed with the role's level.
 */
export function resolveAgyModel(
  model: string, reasoning: string, allowCustom = false, catalog?: ModelCatalogSnapshot,
): string {
  let stem = allowCustom && /^gemini[- ]/i.test(model.trim())
    ? agyKey(model).replace(AGY_EFFORT_SUFFIX, '')
    : agyStem(model, catalog)
  if (!stem || !eligibleAgy(stem)) stem = AGY_FALLBACK_STEM
  return `${stem}-${resolveReasoning(reasoning, agyStemEfforts(stem, catalog) ?? REASONING_LADDER.slice(0, 3))}`
}

function customModel(ai: string, model: string): string | undefined {
  const prefixed = /^(?:custom|unlisted):\s*(.+)$/i.exec(model)?.[1]?.trim()
  if (prefixed) return prefixed
  if (ai === 'codex' && ['gpt-reserve', 'codex-auto-review'].includes(model.toLowerCase())) return model
  const allowed = (process.env.SWARM_ALLOWED_CUSTOM_MODELS ?? '').split(',').map((entry) => entry.trim().toLowerCase())
  return allowed.includes(model.toLowerCase()) ? model : undefined
}

/**
 * Unknown tags fall back once before dispatch, instead of spending every retry on invalid arguments.
 * Known means the alias table, or — when `catalog` is given — what the CLI itself reported at the last
 * refresh (`core/model-catalog.ts`), so a model released after this build dispatches without a rebuild.
 */
export function validateModelAvailability(assignment: RoleAssignment, catalog?: ModelCatalogSnapshot): RoleAssignment {
  const ai = assignment.ai.toLowerCase()
  if (!Object.hasOwn(DEFAULT_AI_CONFIG, ai)) throw new Error('Unknown Swarm AI provider')
  const model = assignment.model.trim()
  const custom = assignment.customModel ? model : customModel(ai, model)
  if (ai === 'antigravity') {
    const stem = agyStem(model, catalog)
    // Custom agy names still must be Gemini, otherwise they bypass the distinct-family invariant.
    const customGemini = custom !== undefined && /^gemini[- ]/i.test(custom)
      && eligibleAgy(agyKey(custom).replace(AGY_EFFORT_SUFFIX, ''))
    if ((stem && eligibleAgy(stem)) || customGemini) {
      return { ...assignment, ai, model: custom ?? model, ...(custom ? { customModel: true } : {}) }
    }
  } else {
    const kind = ai as 'claude' | 'codex'
    const known = ownValue(kind === 'claude' ? CLAUDE_ALIASES : CODEX_ALIASES, aliasKey(model))
      ?? findCatalogModel(catalog, kind, model)?.id
    if (known || custom) {
      return { ...assignment, ai, model: custom ?? model, ...(custom ? { customModel: true } : {}) }
    }
  }
  console.warn(`[swarm] Unavailable model for ${ai}; using the default preset`)
  return { ...DEFAULT_AI_CONFIG[ai as SwarmAi] }
}

/** Implementation gets the requested effort; checking and revision roles have bounded costs. */
export function resolveRoleAssignment(
  assignment: RoleAssignment, role: LifecycleRole, catalog?: ModelCatalogSnapshot,
): RoleAssignment {
  const resolved = validateModelAvailability(assignment, catalog)
  if (role === 'maintainer') resolved.reasoning = 'low'
  else if (role === 'reviewer' || role === 'worker_revise') resolved.reasoning = 'medium'
  return resolved
}

/**
 * Shell-free command-inclusive argv. Claude/Codex read prompts from stdin. Keep agy on its
 * established --print argument contract until its stdin protocol is verified; it therefore retains
 * argv size and process-list visibility limits. Only Worker executions receive write-capable flags.
 *
 * The effort clamps to the model's own ceiling: the refreshed catalog's levels first, then the built-in
 * table's (Codex Sol, Terra and Astra reach `ultra`, Luna `max`; Claude `max`). A model neither knows —
 * a `custom:` id — stops at `max`, which every current model accepts.
 */
export function buildAiArgv(
  assignment: RoleAssignment, prompt: string, allowToolUse: boolean, cwd?: string, catalog?: ModelCatalogSnapshot,
): string[] {
  const { ai, model, reasoning, customModel: custom } = validateModelAvailability(assignment, catalog)
  if (ai === 'antigravity') {
    return ['agy', ...(allowToolUse ? [] : ['--sandbox']), '--dangerously-skip-permissions',
      '--model', resolveAgyModel(model, reasoning, custom, catalog), '--print-timeout', '45m',
      '--print', prompt]
  }
  const kind = ai as 'claude' | 'codex'
  // A custom model is the operator pinning an exact id, so it is never re-aliased: `custom:claude-opus-5`
  // must run Opus 5 even though the prose tag `opus 5` now means the newest Opus.
  const resolvedModel = custom ? model
    : ownValue(kind === 'codex' ? CODEX_ALIASES : CLAUDE_ALIASES, aliasKey(model)) ?? findCatalogModel(catalog, kind, model)?.id ?? model
  const supported = modelEfforts(kind, resolvedModel, catalog) ?? UNIDENTIFIED_EFFORT_CEILING
  const effort = supported.length > 0 ? resolveReasoning(reasoning, supported) : undefined
  if (kind === 'codex') {
    return ['codex', 'exec', ...buildModelEffortArgs('codex', resolvedModel, effort),
      ...(cwd ? ['-C', cwd] : []), '-s', allowToolUse ? 'workspace-write' : 'read-only',
      ...(allowToolUse ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      '-']
  }
  return ['claude', '-p', ...buildModelEffortArgs('claude', resolvedModel, effort),
    ...(allowToolUse ? ['--dangerously-skip-permissions'] : ['--allowed-tools', 'Bash(gh *),Bash(git *),Read'])]
}
