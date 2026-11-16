import { stripQuotedText } from '../assignment.ts'
import { buildModelEffortArgs, REASONING_LADDER, resolveReasoning } from '../ai/provider-options.ts'

export type SwarmAi = 'codex' | 'antigravity' | 'claude'
export type LifecycleRole = 'worker' | 'worker_revise' | 'reviewer' | 'maintainer'
export interface RoleAssignment { ai: string; model: string; reasoning: string; customModel?: boolean }

/** Defaults used only for autonomous Swarm tags; saved workflow provider configs remain operator-owned. */
export const DEFAULT_AI_CONFIG: Record<SwarmAi, RoleAssignment> = {
  codex: { ai: 'codex', model: 'gpt-5.6-terra', reasoning: 'high' },
  antigravity: { ai: 'antigravity', model: 'gemini-3.8-flash', reasoning: 'high' },
  claude: { ai: 'claude', model: 'claude-sonnet-5', reasoning: 'high' },
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

const CODEX_ALIASES: Record<string, string> = {
  '5.6': 'gpt-5.6-terra', 'gpt-5.6': 'gpt-5.6-terra',
  '5.6 (sol, terra, luna)': 'gpt-5.6-terra',
}
for (const variant of ['sol', 'terra', 'luna']) {
  for (const alias of [variant, `5.6 ${variant}`, `5.6 (${variant})`, `gpt-5.6-${variant}`]) {
    CODEX_ALIASES[alias] = `gpt-5.6-${variant}`
  }
}
for (const old of ['5.5', '5.4', '5.3', '5.2', '5.1']) {
  for (const alias of [old, `gpt-${old}`, `gpt-${old}-codex`]) CODEX_ALIASES[alias] = 'gpt-5.6-terra'
}
for (const alias of ['5.4 mini', 'gpt-5.4-mini', '5.6 spark', 'gpt-5.6-spark']) {
  CODEX_ALIASES[alias] = 'gpt-5.6-luna'
}
CODEX_ALIASES['gpt-5.1-codex-max'] = 'gpt-5.6-terra'
CODEX_ALIASES['gpt-5-1-codex'] = 'gpt-5.6-terra'

const CLAUDE_ALIASES: Record<string, string> = {}
for (const family of ['opus', 'sonnet', 'fable']) {
  for (const alias of [family, `${family} 5`, `claude-${family}-5`]) CLAUDE_ALIASES[alias] = `claude-${family}-5`
}
for (const version of ['4.8', '4.7', '4.6', '4.5', '4.1', '4']) CLAUDE_ALIASES[`opus ${version}`] = 'claude-opus-5'
for (const version of ['4.6', '4.5', '4', '3.7', '3.5']) {
  for (const alias of [`sonnet ${version}`, `claude ${version} sonnet`, `claude-${version}-sonnet`, `claude-${version.replace('.', '-')}-sonnet`]) {
    CLAUDE_ALIASES[alias] = 'claude-sonnet-5'
  }
}
for (const alias of ['haiku', 'haiku 4.5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  'haiku 3.5', 'claude 3.5 haiku', 'claude-3-5-haiku', 'claude-3.5-haiku']) {
  CLAUDE_ALIASES[alias] = 'claude-haiku-4-5'
}

const AGY_ALIASES: Record<string, string> = {
  'gemini-4-argon': 'gemini-4-argon', argon: 'gemini-4-argon',
  'gemini-3.1-pro': 'gemini-4-argon', 'gemini-3-pro': 'gemini-4-argon', 'gemini-pro': 'gemini-4-argon',
  'gemini-3.8-flash': 'gemini-3.8-flash', 'gemini-3.6-flash': 'gemini-3.8-flash',
  'gemini-3.7-flash': 'gemini-3.8-flash', 'gemini-flash': 'gemini-3.8-flash',
  'claude-opus-5.5': 'claude-opus-5-5', 'claude-sonnet-5.5': 'claude-sonnet-5-5',
  'gpt-oss-120b': 'gpt-oss-120b', 'claude-opus-5-5': 'claude-opus-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-5-5',
}

const FOREIGN_AGY = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b'])
const ownValue = (table: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined
function agyStem(model: string): string | undefined {
  const key = model.trim().toLowerCase().replace(/[\s_()]+/g, '-').replace(/^-+|-+$/g, '')
  return ownValue(AGY_ALIASES, key) ?? ownValue(AGY_ALIASES, key.replace(/-(low|medium|high)$/, ''))
}

/** A foreign model cannot evade maker-checker by being served through agy. */
export function resolveAgyModel(model: string, reasoning: string, allowCustom = false): string {
  let stem = agyStem(model)
  if (!stem && allowCustom && /^gemini[- ]/i.test(model)) {
    stem = model.replace(/-(low|medium|high)$/, '')
  }
  if (!stem || FOREIGN_AGY.has(stem)) stem = 'gemini-3.8-flash'
  return `${stem}-${resolveReasoning(reasoning, REASONING_LADDER.slice(0, 3))}`
}

function customModel(ai: string, model: string): string | undefined {
  const prefixed = /^(?:custom|unlisted):\s*(.+)$/i.exec(model)?.[1]?.trim()
  if (prefixed) return prefixed
  if (ai === 'codex' && ['gpt-reserve', 'codex-auto-review'].includes(model.toLowerCase())) return model
  const allowed = (process.env.SWARM_ALLOWED_CUSTOM_MODELS ?? '').split(',').map((entry) => entry.trim().toLowerCase())
  return allowed.includes(model.toLowerCase()) ? model : undefined
}

/** Unknown tags fall back once before dispatch, instead of spending every retry on invalid arguments. */
export function validateModelAvailability(assignment: RoleAssignment): RoleAssignment {
  const ai = assignment.ai.toLowerCase()
  if (!Object.hasOwn(DEFAULT_AI_CONFIG, ai)) throw new Error('Unknown Swarm AI provider')
  const model = assignment.model.trim()
  const aliases = ai === 'claude' ? CLAUDE_ALIASES : CODEX_ALIASES
  if (ai === 'antigravity') {
    const stem = agyStem(model)
    // Custom agy names still must be Gemini, otherwise they bypass the distinct-family invariant.
    const custom = assignment.customModel ? model : customModel(ai, model)
    if ((stem && !FOREIGN_AGY.has(stem)) || (custom && /^gemini[- ]/i.test(custom))) {
      return { ...assignment, ai, model: custom ?? model, ...(custom ? { customModel: true } : {}) }
    }
  } else {
    const custom = assignment.customModel ? model : customModel(ai, model)
    if (ownValue(aliases, model.toLowerCase()) || custom) {
      return { ...assignment, ai, model: custom ?? model, ...(custom ? { customModel: true } : {}) }
    }
  }
  console.warn(`[swarm] Unavailable model for ${ai}; using the default preset`)
  return { ...DEFAULT_AI_CONFIG[ai as SwarmAi] }
}

/** Implementation gets the requested effort; checking and revision roles have bounded costs. */
export function resolveRoleAssignment(assignment: RoleAssignment, role: LifecycleRole): RoleAssignment {
  const resolved = validateModelAvailability(assignment)
  if (role === 'maintainer') resolved.reasoning = 'low'
  else if (role === 'reviewer' || role === 'worker_revise') resolved.reasoning = 'medium'
  return resolved
}

/**
 * Shell-free command-inclusive argv. Claude/Codex read prompts from stdin. Keep agy on its
 * established --print argument contract until its stdin protocol is verified; it therefore retains
 * argv size and process-list visibility limits. Only Worker executions receive write-capable flags.
 */
export function buildAiArgv(
  assignment: RoleAssignment, prompt: string, allowToolUse: boolean, cwd?: string,
): string[] {
  const { ai, model, reasoning, customModel: custom } = validateModelAvailability(assignment)
  if (ai === 'antigravity') {
    return ['agy', ...(allowToolUse ? [] : ['--sandbox']), '--dangerously-skip-permissions',
      '--model', resolveAgyModel(model, reasoning, custom), '--print-timeout', '45m',
      '--print', prompt]
  }
  const resolvedModel = ownValue(ai === 'codex' ? CODEX_ALIASES : CLAUDE_ALIASES, model.toLowerCase()) ?? model
  if (ai === 'codex') {
    const effort = resolveReasoning(reasoning,
      resolvedModel === 'gpt-5.6-sol' || resolvedModel === 'gpt-5.6-terra'
        ? REASONING_LADDER : REASONING_LADDER.slice(0, 5))
    return ['codex', 'exec', ...buildModelEffortArgs('codex', resolvedModel, effort),
      ...(cwd ? ['-C', cwd] : []), '-s', allowToolUse ? 'workspace-write' : 'read-only',
      ...(allowToolUse ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
      '-']
  }
  const effort = resolveReasoning(reasoning, REASONING_LADDER.slice(0, 5))
  return ['claude', '-p', ...buildModelEffortArgs('claude', resolvedModel, effort),
    ...(allowToolUse ? ['--dangerously-skip-permissions'] : ['--allowed-tools', 'Bash(gh *),Bash(git *),Read'])]
}
