import type { AiEffort, ProviderKindId } from './types.ts'

export interface ModelOption {
  value: string
  label: string
  /** If true, effort selection is not applicable for this model */
  noEffort?: boolean
  /**
   * The reasoning levels this model accepts, lowest first, when that is narrower than its provider's
   * `efforts` list — Codex Luna stops at `max` while Sol, Terra and Astra reach `ultra`. Absent means
   * every level the provider offers. A refreshed catalog (`core/model-catalog.ts`) fills it from what the
   * CLI itself reports, which is how a model MAO has never heard of still gets the right ceiling.
   */
  efforts?: readonly ReasoningLevel[]
}

export interface EffortOption {
  value: AiEffort
  label: string
}

export interface ProviderOptions {
  models: ModelOption[]
  efforts: EffortOption[]
}

/** Lowest-to-highest Swarm effort ladder. Saved provider values are passed through separately. */
export const REASONING_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningLevel = (typeof REASONING_LADDER)[number]

/**
 * The ceiling for a model nothing describes — a `custom:` id, or a refreshed entry whose source named no
 * levels. Every current model accepts `max`; only some accept `ultra`, and a CLI answers an unsupported
 * level with an error rather than a clamp.
 */
export const UNIDENTIFIED_EFFORT_CEILING: readonly ReasoningLevel[] = REASONING_LADDER.slice(0, 5)

const REASONING_ALIASES: Record<string, ReasoningLevel> = {
  low: 'low', 낮음: 'low', light: 'low', medium: 'medium', 중간: 'medium',
  high: 'high', 높음: 'high', thinking: 'high', xhigh: 'xhigh',
  '매우 높음': 'xhigh', 매우높음: 'xhigh', 엑스트라: 'xhigh', 'extra high': 'xhigh',
  max: 'max', 최대: 'max', ultracode: 'max', ultra: 'ultra', 울트라: 'ultra',
}

/** Unknown labels resolve to medium; excessive requests clamp to the model's supported ceiling. */
export function resolveReasoning(reasoning: string, supported: readonly string[] = REASONING_LADDER): ReasoningLevel {
  const key = reasoning.toLowerCase().replace(/[\s ]+/g, ' ').trim().replace(/^[.!?,;:()\[\]]+|[.!?,;:()\[\]]+$/g, '').trim()
  const wanted = Object.hasOwn(REASONING_ALIASES, key) ? REASONING_ALIASES[key] : 'medium'
  const allowed = REASONING_LADDER.filter((level) => supported.includes(level))
  const ceiling = REASONING_LADDER.indexOf(wanted)
  return [...allowed].reverse().find((level) => REASONING_LADDER.indexOf(level) <= ceiling) ?? allowed[0] ?? wanted
}

/**
 * Encode the operator's resolved configuration without interpreting model or effort names.
 * Swarm normalizes its prose tags before calling this helper; ordinary providers (including
 * custom wrappers named after a built-in CLI) retain their saved values verbatim. Codex's
 * config-key syntax is the only command-specific effort encoding here.
 */
export function buildModelEffortArgs(command: string, model?: string, effort?: string, args: readonly string[] = []): string[] {
  const result: string[] = []
  if (model && !args.includes('--model') && !args.includes('-m')) result.push('--model', model)
  const kind = command === 'agy' ? 'antigravity' : command === 'claude' ? 'claude' : undefined
  const noEffort = kind && PROVIDER_OPTIONS[kind].models.find((entry) => entry.value === model)?.noEffort
  if (effort && !noEffort && !args.includes('--effort')) {
    if (command === 'codex') {
      const hasConfig = args.some((arg) => /^model_reasoning_effort\s*=/.test(arg))
      if (!hasConfig) result.push('-c', `model_reasoning_effort=${effort}`)
    } else {
      result.push('--effort', effort)
    }
  }
  return result
}

const efforts = (levels: readonly AiEffort[]): EffortOption[] => levels.map((value) => ({ value, label: value }))

/**
 * The AI CLIs whose model lists MAO refreshes at runtime (`core/model-catalog.ts`). `custom` is not one:
 * a custom provider is whatever the operator says it is, so there is nothing to ask.
 */
export const DISCOVERABLE_PROVIDER_KINDS = ['antigravity', 'claude', 'codex'] as const
export type DiscoverableProviderKind = (typeof DISCOVERABLE_PROVIDER_KINDS)[number]

/**
 * A provider name as an operator types it — any case, and `agy` for Antigravity, the name its CLI goes by —
 * or `undefined` when it names none of them.
 */
export function parseDiscoverableKind(name: string): DiscoverableProviderKind | undefined {
  const key = name.trim().toLowerCase()
  const kind = key === 'agy' ? 'antigravity' : key
  return (DISCOVERABLE_PROVIDER_KINDS as readonly string[]).includes(kind) ? kind as DiscoverableProviderKind : undefined
}

/**
 * The levels each CLI's own effort encoding can carry, which bounds any catalog's claim: `claude --effort`
 * stops at `max`, Codex's `model_reasoning_effort` reaches `ultra`, and agy has no effort flag at all — it
 * takes the level as a model-slug suffix, of which it lists none above `xhigh` today.
 */
export const PROVIDER_EFFORT_LADDERS: Readonly<Record<DiscoverableProviderKind, readonly ReasoningLevel[]>> = {
  antigravity: REASONING_LADDER.slice(0, 5),
  claude: REASONING_LADDER.slice(0, 5),
  codex: REASONING_LADDER,
}

/**
 * agy's `-<effort>` slug suffix. `ultra` is deliberately not one: it is a plausible model *name*, and
 * reading it as a level would split such a model into a stem nobody can address.
 */
export const AGY_EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/

export interface AgyModelStem {
  /** The slug without its effort suffix, e.g. `gemini-4-neon`. */
  stem: string
  /** The suffixes agy accepts for it, lowest first. */
  efforts: readonly ReasoningLevel[]
}

/**
 * Antigravity models MAO knows without asking `agy models`, newest first. Neon and Hydrogen take `xhigh`;
 * Argon and Flash stop at `high` (verified against `agy models` 1.5.14 on 2026-11-22).
 */
export const AGY_STATIC_STEMS: readonly AgyModelStem[] = [
  { stem: 'gemini-4-neon', efforts: REASONING_LADDER.slice(0, 4) },
  { stem: 'gemini-4-hydrogen', efforts: REASONING_LADDER.slice(0, 4) },
  { stem: 'gemini-4-argon', efforts: REASONING_LADDER.slice(0, 3) },
  { stem: 'gemini-3.8-flash', efforts: REASONING_LADDER.slice(0, 3) },
]

/** The Flash stem every unusable Antigravity request falls back to — never a foreign family's model. */
export const AGY_FALLBACK_STEM = 'gemini-3.8-flash'

/**
 * Whether an agy model stem may fill an Antigravity role or appear in its pickers: Gemini only, and never
 * an internal orchestrator (`gemini-pro-orchestrator-*`). agy also serves Claude and GPT models, and one
 * of those behind agy would let a vendor check its own work, breaking maker-checker; an orchestrator routes
 * the prompt on to models MAO cannot see, so it cannot be held to that rule either. An allowlist, not a list
 * of known foreigners, so a family agy adds tomorrow stays out until someone decides otherwise.
 */
export function isEligibleAgyStem(stem: string): boolean {
  const key = stem.trim().toLowerCase()
  return /^gemini-[a-z0-9]/.test(key) && !/(^|-)orchestrator(-|$)/.test(key)
}

const agyModelOptions = (stems: readonly AgyModelStem[]): ModelOption[] =>
  stems.flatMap(({ stem, efforts: levels }) =>
    levels.map((effort) => ({ value: `${stem}-${effort}`, label: `${stem} (${effort})`, noEffort: true })))

/** The current generation, verified against Claude Code 2.1.330 and the Models API on 2026-11-22. */
const CLAUDE_CURRENT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-haiku-5-5']

/** `codex debug models` (codex-cli 0.169.0) `visibility: list` entries, in its own priority order. */
const CODEX_CURRENT_MODELS = [
  'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
]

export const PROVIDER_OPTIONS: Record<ProviderKindId, ProviderOptions> = {
  antigravity: {
    models: agyModelOptions(AGY_STATIC_STEMS),
    efforts: [], // agy encodes effort in its model slug
  },
  claude: {
    models: [
      ...CLAUDE_CURRENT_MODELS.map((value) => ({ value, label: value })),
      // Family aliases the Claude CLI resolves to the newest model of that family on its own.
      ...['opus', 'sonnet', 'fable'].map((value) => ({ value, label: `${value} (latest)` })),
      // Keep no-effort metadata for stored legacy ids. Removing an old catalog entry must not turn a
      // formerly suppressed effort into an unsupported flag. `haiku` stays here too: configurations saved
      // with it have always run without an effort, and a Claude CLI older than Haiku 5.5 still resolves the
      // alias to Haiku 4.5, which rejects `--effort`. Name `claude-haiku-5-5` to set one. (Swarm's prose tag
      // `haiku` already resolves to that id itself, so it does pass an effort.)
      ...['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-3-5-haiku', 'claude-3.5-haiku', 'haiku']
        .map((value) => ({ value, label: value, noEffort: true })),
    ],
    efforts: efforts(REASONING_LADDER.slice(0, 5)),
  },
  codex: {
    models: CODEX_CURRENT_MODELS.map((value) => ({
      value,
      label: value,
      // Luna answers `ultra` with an error; every other current family accepts it.
      ...(value.endsWith('-luna') ? { efforts: REASONING_LADDER.slice(0, 5) } : {}),
    })),
    efforts: efforts(REASONING_LADDER),
  },
  custom: { models: [], efforts: efforts(REASONING_LADDER) },
}

// ─── Refreshed catalogs ────────────────────────────────────────────────────────
//
// The data types live here, beside the static tables, because the renderer may import values from this
// module and from no other Node-side one (AGENTS.md rule 6). Fetching and caching live in
// `core/ai/model-discovery.ts` and `core/model-catalog.ts`, which the renderer never imports.

/** Where a refreshed list came from. Fixed identifiers, never command or API output. */
export type ModelCatalogSource = 'agy-models' | 'codex-debug-models' | 'anthropic-models-api' | 'claude-local-settings'

/** One model a provider's own CLI or API reported. */
export interface CatalogModel {
  /** The id the CLI takes. For Antigravity this is the stem, without its `-<effort>` suffix. */
  id: string
  /** The display name the source reported, if any. */
  label?: string
  /** The levels the source says the model accepts, lowest first; `[]` means none, absent means it did not say. */
  efforts?: ReasoningLevel[]
}

export interface ProviderModelCatalog {
  /** When this list was fetched (ISO 8601). */
  updatedAt: string
  source: ModelCatalogSource
  models: CatalogModel[]
}

/**
 * Why a refresh did not produce a list. A closed set on purpose: discovery errors can quote a command line,
 * a URL or an API response, so only these categories ever leave `core/ai/model-discovery.ts` — into logs,
 * the cache file, the CLI and the renderer alike.
 */
export const MODEL_CATALOG_FAILURES = [
  'command-not-found', 'command-failed', 'command-timeout', 'output-too-large', 'parse-failed', 'no-models',
  'unauthorized', 'http-error', 'network-error', 'request-timeout', 'no-source', 'kept-api-list', 'aborted',
  'unexpected-error',
] as const
export type ModelCatalogFailure = (typeof MODEL_CATALOG_FAILURES)[number]

/** Operator-facing wording for each failure, shared by `mao providers refresh-models` and Global settings. */
export const MODEL_CATALOG_FAILURE_TEXT: Readonly<Record<ModelCatalogFailure, string>> = {
  'command-not-found': 'the CLI is not installed or not on PATH',
  'command-failed': 'the CLI exited with an error',
  'command-timeout': 'the CLI did not answer in time',
  'output-too-large': 'the CLI printed more than MAO reads',
  'parse-failed': 'the answer was not in a format MAO recognizes',
  'no-models': 'no usable model was listed',
  unauthorized: 'the Anthropic API key was rejected',
  'http-error': 'the Anthropic API answered with an error',
  'network-error': 'the Anthropic API could not be reached',
  'request-timeout': 'the Anthropic API did not answer in time',
  'no-source': 'no Anthropic API key or Claude model setting was found, so the built-in list stays in use',
  'kept-api-list': 'only Claude Code\'s model settings are available here, so the Anthropic API listing stays in use',
  aborted: 'the refresh was interrupted',
  'unexpected-error': 'an unexpected error occurred',
}

/** The last refresh attempt for one provider, for display: scheduling never trusts another host's attempt. */
export interface ModelCatalogAttempt {
  /** When the attempt finished (ISO 8601). */
  at: string
  /** `updated`: a list was fetched. `static`: no source exists here, so the built-in list applies. `failed`: see `reason`. */
  outcome: 'updated' | 'static' | 'failed'
  reason?: ModelCatalogFailure
}

/** The cached catalog as hosts read it: the IPC answer, `mao providers models`, and Swarm dispatch's input. */
export interface ModelCatalogView {
  providers: Partial<Record<DiscoverableProviderKind, ProviderModelCatalog>>
  attempts: Partial<Record<DiscoverableProviderKind, ModelCatalogAttempt>>
  /** The automatic refresh period, or `null` when automatic refresh is off (`MAO_MODEL_CATALOG_TTL_HOURS=0`). */
  ttlMs: number | null
}

/** Only `providers` matters for merging, so a caller holding a partial answer can still merge it. */
export type ModelCatalogSnapshot = Pick<ModelCatalogView, 'providers'>

const withinLadder = (levels: readonly string[] | undefined, ladder: readonly ReasoningLevel[]) =>
  levels === undefined ? undefined : ladder.filter((level) => levels.includes(level))

/** A refreshed list as picker options. Antigravity stems expand to one no-effort slug per level. */
function discoveredOptions(kind: DiscoverableProviderKind, catalog: ProviderModelCatalog | undefined): ModelOption[] {
  if (!catalog || !Array.isArray(catalog.models)) return []
  const ladder = PROVIDER_EFFORT_LADDERS[kind]
  const options: ModelOption[] = []
  for (const model of catalog.models) {
    if (!model || typeof model.id !== 'string' || !model.id) continue
    if (kind === 'antigravity') {
      if (!isEligibleAgyStem(model.id)) continue
      const levels = withinLadder(model.efforts, ladder) ?? REASONING_LADDER.slice(0, 3)
      options.push(...agyModelOptions([{ stem: model.id, efforts: levels }]))
      continue
    }
    const levels = withinLadder(model.efforts, ladder)
    options.push({
      value: model.id,
      label: model.id,
      ...(levels === undefined ? {} : levels.length > 0 ? { efforts: levels } : { noEffort: true }),
    })
  }
  return options
}

/**
 * Refreshed models first, in the order their source listed them, then every built-in entry the refresh
 * did not mention — so a stored legacy id keeps its metadata, and an outage that empties a list on the
 * other side never empties a picker here.
 *
 * Built-in no-effort metadata wins over whatever a source says: a refresh must never turn an effort MAO
 * used to drop into a flag the CLI rejects. A source that names a model without saying which levels it
 * takes inherits the built-in ceiling rather than the provider's widest one.
 */
function mergeModelOptions(discovered: ModelOption[], builtIn: readonly ModelOption[]): ModelOption[] {
  const known = new Map(builtIn.map((option) => [option.value, option]))
  const seen = new Set<string>()
  const merged: ModelOption[] = []
  for (const option of discovered) {
    if (seen.has(option.value)) continue
    seen.add(option.value)
    const builtInOption = known.get(option.value)
    if (builtInOption?.noEffort) merged.push({ value: option.value, label: option.label, noEffort: true })
    else if (!option.noEffort && option.efforts === undefined) {
      // Named without its levels: the built-in ceiling when MAO knows the model, else the unidentified one —
      // never the provider's widest, which for Codex is `ultra`, a level Luna-class models reject.
      if (!builtInOption) merged.push({ ...option, efforts: UNIDENTIFIED_EFFORT_CEILING })
      else merged.push(builtInOption.efforts ? { ...option, efforts: builtInOption.efforts } : option)
    } else merged.push(option)
  }
  for (const option of builtIn) {
    if (!seen.has(option.value)) {
      seen.add(option.value)
      merged.push(option)
    }
  }
  return merged
}

/**
 * The built-in provider options with every refreshed list merged in: what Global settings offers and what
 * Swarm accepts, from one rule. Pure, so the renderer can call it on the IPC answer (AGENTS.md rule 6).
 */
export function providerOptionsWithCatalog(catalog?: ModelCatalogSnapshot): Record<ProviderKindId, ProviderOptions> {
  if (!catalog?.providers) return PROVIDER_OPTIONS
  const merged: Record<ProviderKindId, ProviderOptions> = { ...PROVIDER_OPTIONS }
  for (const kind of DISCOVERABLE_PROVIDER_KINDS) {
    const discovered = discoveredOptions(kind, catalog.providers[kind])
    if (discovered.length > 0) {
      merged[kind] = { ...PROVIDER_OPTIONS[kind], models: mergeModelOptions(discovered, PROVIDER_OPTIONS[kind].models) }
    }
  }
  return merged
}

/** The refreshed entry for `id`, compared case-insensitively, as model ids are by their CLIs. */
export function findCatalogModel(
  catalog: ModelCatalogSnapshot | undefined, kind: DiscoverableProviderKind, id: string,
): CatalogModel | undefined {
  const key = id.trim().toLowerCase()
  const models = catalog?.providers?.[kind]?.models
  if (!key || !Array.isArray(models)) return undefined
  return models.find((model) => typeof model?.id === 'string' && model.id.toLowerCase() === key)
}

/**
 * The levels `model` accepts, from the refreshed list first and the built-in one second: `[]` for a model
 * that takes no effort, `undefined` when neither list knows the model — the caller decides what an
 * unidentified model may ask for (Swarm caps it at `max`).
 */
export function modelEfforts(
  kind: 'claude' | 'codex', model: string, catalog?: ModelCatalogSnapshot,
): readonly ReasoningLevel[] | undefined {
  const key = model.trim().toLowerCase()
  const options = providerOptionsWithCatalog(catalog)[kind]
  const option = options.models.find((entry) => entry.value.toLowerCase() === key)
  if (!option) return undefined
  if (option.noEffort) return []
  const ladder = PROVIDER_EFFORT_LADDERS[kind]
  return withinLadder(option.efforts ?? options.efforts.map((entry) => entry.value), ladder)
}

/**
 * The suffixes agy accepts for `stem`: the refreshed list's first, then the built-in table's. `undefined`
 * when neither knows the stem, or when it is not an eligible Antigravity model at all.
 */
export function agyStemEfforts(stem: string, catalog?: ModelCatalogSnapshot): readonly ReasoningLevel[] | undefined {
  const key = stem.trim().toLowerCase()
  if (!isEligibleAgyStem(key)) return undefined
  const discovered = findCatalogModel(catalog, 'antigravity', key)
  if (discovered) {
    const levels = withinLadder(discovered.efforts, PROVIDER_EFFORT_LADDERS.antigravity)
    if (levels === undefined || levels.length > 0) return levels ?? REASONING_LADDER.slice(0, 3)
  }
  return AGY_STATIC_STEMS.find((entry) => entry.stem === key)?.efforts
}

/** Whether `stem` names an Antigravity model the refreshed or built-in list knows. */
export function isKnownAgyStem(stem: string, catalog?: ModelCatalogSnapshot): boolean {
  return agyStemEfforts(stem, catalog) !== undefined
}

/** One model as `mao providers models` prints it and Global settings lists it. */
export interface CatalogModelRow {
  /** The id a tag or a provider names; for Antigravity, the stem its level suffix attaches to. */
  id: string
  /** The levels it accepts, lowest first; `[]` when it takes no effort flag at all. */
  efforts: readonly ReasoningLevel[]
}

/**
 * Every model one provider offers once refreshed lists are merged in, with its levels — one rule for the
 * CLI's listing and the GUI's, so the two cannot disagree (AGENTS.md rule 2). Antigravity rows are stems:
 * agy's slugs are a stem plus a level, and listing each slug would repeat every model four times.
 */
export function catalogModelRows(kind: DiscoverableProviderKind, catalog?: ModelCatalogSnapshot): CatalogModelRow[] {
  if (kind === 'antigravity') {
    const refreshed = (catalog?.providers?.antigravity?.models ?? [])
      .flatMap((model) => typeof model?.id === 'string' ? [model.id.toLowerCase()] : [])
    return [...new Set([...refreshed, ...AGY_STATIC_STEMS.map((entry) => entry.stem)])].flatMap((id) => {
      const efforts = agyStemEfforts(id, catalog)
      return efforts && efforts.length > 0 ? [{ id, efforts }] : []
    })
  }
  const options = providerOptionsWithCatalog(catalog)[kind]
  const ladder = PROVIDER_EFFORT_LADDERS[kind]
  return options.models.map((option) => ({
    id: option.value,
    efforts: option.noEffort ? [] : withinLadder(option.efforts ?? options.efforts.map((entry) => entry.value), ladder) ?? [],
  }))
}

/**
 * The effort choices a picker offers once `model` is chosen: none for a no-effort model, the model's own
 * narrower list when its catalog entry has one, else every level the provider offers.
 */
export function effortOptionsForModel(options: ProviderOptions, model: string | undefined): EffortOption[] {
  const entry = model ? options.models.find((candidate) => candidate.value === model) : undefined
  if (entry?.noEffort) return []
  if (!entry?.efforts) return options.efforts
  return options.efforts.filter((option) => entry.efforts!.includes(option.value as ReasoningLevel))
}

/**
 * The tool identity worth showing next to a provider's name. A provider's `name` is operator-chosen
 * and needn't say which CLI it drives ("Primary Reviewer" tells you nothing about Codex), so cards
 * pair the two — but 'custom' (and an unset kind) adds nothing the name doesn't already say.
 */
export function providerToolKind(provider: { providerKindId?: ProviderKindId }): ProviderKindId | undefined {
  return provider.providerKindId && provider.providerKindId !== 'custom' ? provider.providerKindId : undefined
}

/** A provider's name paired with its tool, for single-string display. See `providerToolKind()`. */
export function providerToolLabel(provider: { name: string; providerKindId?: ProviderKindId }): string {
  const kind = providerToolKind(provider)
  return kind ? `${provider.name} · ${kind}` : provider.name
}

/** Returns model options for a given provider kind. Falls back to custom if unknown. */
export function getProviderOptions(kindId?: ProviderKindId): ProviderOptions {
  return kindId ? (PROVIDER_OPTIONS[kindId] ?? PROVIDER_OPTIONS.custom) : PROVIDER_OPTIONS.custom
}
