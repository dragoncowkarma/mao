import type { AgentStage, AiEffort, AiProviderConfig } from './ai/types.ts'

/**
 * Pure agent-selection rules, deliberately kept free of Node built-ins and of any workflow-engine
 * import so the Electron renderer can call the exact same functions the engine runs (same precedent
 * as core/ai/provider-options.ts, which src/components/GlobalSettings.tsx already imports at
 * runtime). Board/queue cards need to show *which* agent a stage will use — and to offer only the
 * agents it may legally use — before the stage runs; re-deriving that in the renderer would leave
 * two copies of the maker-checker rule free to drift apart.
 *
 * core/workflow-engine.ts re-exports the types below so existing importers keep working.
 */

/** Which lifecycle "role" (à la swarm_orchestrator.py's Worker/Reviewer/Maintainer tags) owns each stage. */
export type WorkflowRole = 'worker' | 'reviewer' | 'maintainer'

export const STAGE_ROLE: Record<AgentStage, WorkflowRole> = {
  issue: 'worker',
  pr: 'worker',
  review: 'reviewer',
  merge: 'maintainer',
}

/**
 * Per-role explicit provider assignment, e.g. parsed from a GitHub issue/PR body via
 * `parseAssignmentTags()` (see core/assignment.ts) — `[Worker: agent-cli]`, `[Reviewer: agent-cli2]`,
 * `[Maintainer: agent-cli2]` — or set directly via CLI flags. `worker` covers both the `issue` and
 * `pr` stages (drafting the issue and implementing the PR that resolves it — both the "making" side
 * of the work); `reviewer` covers `review`; `maintainer` covers `merge`.
 */
export interface WorkflowRoleAssignment {
  worker?: string
  reviewer?: string
  maintainer?: string
}

export interface ProviderOverride {
  /**
   * Preferred provider id for this task's stages. Only ever influences *which* provider is picked —
   * maker-checker still wins: a preferred provider that handled the immediately preceding stage is
   * skipped in favor of another registered provider, same as with no preference at all.
   */
  providerId?: string
  /** Applied to whichever provider ends up selected, without mutating that provider's saved config. */
  model?: string
  /** Applied to whichever provider ends up selected, without mutating that provider's saved config. */
  effort?: AiEffort
  /**
   * Per-role provider pins that take priority over `providerId` for the stage(s) they name. A Worker
   * pin is exempt from the maker-checker guard when it re-selects itself across the `issue -> pr`
   * boundary (same role, not a check on its own work) — that is the *only* exemption. A Reviewer or
   * Maintainer pin that would hand a stage back to the agent that ran the immediately preceding stage
   * is guarded exactly like a plain `providerId` override: passed over for another registered
   * provider, or the stage fails clearly if none exists — never silently weakened.
   */
  roles?: WorkflowRoleAssignment
}

/**
 * A one-shot tool/model/effort choice that applies to exactly *one* stage execution and is then
 * discarded — what the Run/Retry dropdowns on a board or queue card send. Deliberately distinct from
 * `ProviderOverride`: that one is a durable, task-level pin covering every future stage, whereas this
 * is "run this stage, right now, like so" and must never survive into the next stage or into the
 * provider's saved configuration.
 *
 * Because it is an explicit instruction naming one agent rather than a standing preference, a
 * `providerId` here is never silently redirected to a different provider the way a stored pin is —
 * see `resolveStageAgent()`.
 */
export interface RunOverride {
  providerId?: string
  model?: string
  effort?: AiEffort
}

/** The last stage this task actually ran, and who ran it — the input maker-checker is guarding on. */
export interface PreviousStep {
  stage: AgentStage
  agentId: string
}

export interface StageAgentParams {
  stage: AgentStage
  /** Normally the final entry of `QueuedTask.history`; omit for a task that has not run a stage yet. */
  previous?: PreviousStep
  /** The task's durable provider/model/effort pin, if any. */
  override?: ProviderOverride
  /** A one-shot choice for this single execution. Takes priority over `override` on every field it sets. */
  oneShot?: RunOverride
}

/** True when `provider`'s `allowedStages` permits `stage` (absent or empty means "any stage"). */
export function isStageEligible(provider: AiProviderConfig, stage: AgentStage): boolean {
  return !provider.allowedStages || provider.allowedStages.length === 0 || provider.allowedStages.includes(stage)
}

/**
 * The providers a one-shot `RunOverride` may legally name for `stage` — i.e. exactly the set the
 * card's tool dropdown should offer. Mirrors the rules `resolveStageAgent()` enforces for a one-shot
 * pick, so the dropdown can never present a choice the engine would reject:
 * stage-eligible, minus whoever ran the previous stage, except that a same-role continuation
 * (Worker carrying on from `issue` to `pr`) keeps its own agent, and a setup with nobody else left
 * keeps its only option rather than offering none at all.
 */
export function eligibleAgentsForRun(
  providers: AiProviderConfig[],
  stage: AgentStage,
  previous?: PreviousStep,
): AiProviderConfig[] {
  const stageEligible = providers.filter((p) => isStageEligible(p, stage))
  if (!previous) return stageEligible
  if (STAGE_ROLE[previous.stage] === STAGE_ROLE[stage]) return stageEligible
  const others = stageEligible.filter((p) => p.id !== previous.agentId)
  return others.length > 0 ? others : stageEligible
}

/**
 * Resolves a one-shot pick. Unlike a stored preference — which is a standing hint the engine may
 * quietly route around — this is a direct "use this agent for this run" instruction, so a pick
 * maker-checker forbids fails loudly instead of silently running someone else: the operator watching
 * the card would otherwise see an agent they did not choose.
 */
function resolveOneShotProvider(
  providerId: string,
  stage: AgentStage,
  allProviders: AiProviderConfig[],
  stageEligible: AiProviderConfig[],
  previous: PreviousStep | undefined,
): AiProviderConfig {
  if (!allProviders.some((p) => p.id === providerId)) {
    throw new Error(`Run override references unknown provider: ${providerId}`)
  }
  const picked = stageEligible.find((p) => p.id === providerId)
  if (!picked) {
    throw new Error(
      `Run override "${providerId}" is not configured to handle the "${stage}" stage — ` +
        `update its allowed-stages setting or choose a different agent.`,
    )
  }
  if (!previous || picked.id !== previous.agentId) return picked
  // Same role carrying on (Worker going from 'issue' to 'pr') is not a check on its own work.
  if (STAGE_ROLE[previous.stage] === STAGE_ROLE[stage]) return picked
  // Relax only when there is genuinely nobody else — the same fallback the no-preference path takes
  // in a single-provider (or heavily stage-restricted) setup.
  const alternative = stageEligible.find((p) => p.id !== previous.agentId)
  if (!alternative) return picked
  throw new Error(
    `"${picked.name}" already ran the "${previous.stage}" stage — maker-checker requires a different ` +
      `agent for the "${stage}" stage. Choose another agent for this run.`,
  )
}

/**
 * Prevents the AI that handled the previous stage from being assigned the next one (Maker-Checker).
 * A task-level provider preference (`override.providerId`, or a per-role pin in `override.roles` —
 * the role pin wins when both apply to the current stage) may steer which provider gets picked, but
 * never at the expense of that guarantee: if the preferred provider is the one that just ran, it is
 * passed over for another registered provider exactly as if no preference had been set. The one
 * deliberate exception is a Worker role pin re-selecting itself across the `issue -> pr` boundary —
 * both stages are the same "making" role, not a check on its own work, so that specific case is not
 * a maker-checker violation. It is only an error if honoring maker-checker would require a distinct
 * provider that doesn't exist. `model`/`effort` overrides are applied on top of whichever provider is
 * selected, on a copy — the caller's stored provider config is never mutated.
 *
 * A one-shot `oneShot.providerId` outranks both forms of stored preference and follows the stricter
 * rules in `resolveOneShotProvider()`; `oneShot.model`/`oneShot.effort` likewise take priority over
 * the stored `override` values for this single run.
 *
 * Per-provider `allowedStages` restrictions narrow the candidate pool before maker-checker runs.
 * A provider whose `allowedStages` is absent or empty is eligible for every stage. When no
 * stage-eligible provider exists at all, a clear error is thrown so the task lands in `error`
 * (retryable after the operator adds or reconfigures a provider).
 */
export function resolveStageAgent(providers: AiProviderConfig[], params: StageAgentParams): AiProviderConfig {
  if (providers.length === 0) throw new Error('No AI providers registered')
  const { stage, previous, override, oneShot } = params
  const previousAgentId = previous?.agentId

  // Filter to providers whose allowedStages permit the current stage.
  const stageEligible = providers.filter((p) => isStageEligible(p, stage))
  if (stageEligible.length === 0) {
    throw new Error(
      `No AI provider is configured to handle the "${stage}" stage — ` +
        `add a provider without stage restrictions, or enable this stage for an existing provider.`,
    )
  }

  const role = STAGE_ROLE[stage]
  const rolePreferredId = override?.roles?.[role]
  const preferredId = rolePreferredId ?? override?.providerId
  // A Worker pin doing both 'issue' and 'pr' is the same role reusing itself, not maker-checker at
  // all — only guard when the preference came from `roles` AND the previous stage shares that role.
  const skipGuard = rolePreferredId !== undefined && previous !== undefined && STAGE_ROLE[previous.stage] === role

  let base: AiProviderConfig
  if (oneShot?.providerId) {
    base = resolveOneShotProvider(oneShot.providerId, stage, providers, stageEligible, previous)
  } else if (preferredId) {
    const allRegistered = providers.find((p) => p.id === preferredId)
    if (!allRegistered) throw new Error(`Provider override references unknown provider: ${preferredId}`)

    const preferred = stageEligible.find((p) => p.id === preferredId)
    if (!preferred) {
      throw new Error(
        `Provider override "${preferredId}" is not configured to handle the "${stage}" ` +
          `stage — update its allowed-stages setting or choose a different provider.`,
      )
    }

    if (skipGuard || preferred.id !== previousAgentId) {
      base = preferred
    } else {
      const alternative = stageEligible.find((p) => p.id !== previousAgentId)
      if (!alternative) {
        if (rolePreferredId !== undefined) {
          throw new Error(
            `Provider override "${preferredId}" handled the immediately preceding stage and no other ` +
              `provider is registered to check its own work — maker-checker requires a distinct provider here.`,
          )
        }
        // No other stage-eligible provider is available — relax maker-checker and use the only
        // eligible provider. Consistent with the no-override path's `candidates[0] ?? stageEligible[0]`
        // fallback: when stage restrictions (or a single-provider setup) leave only one option,
        // stage eligibility takes priority over the consecutive-agent constraint.
        base = preferred
      } else {
        base = alternative
      }
    }
  } else {
    // Prefer a provider that didn't just run (maker-checker), from the stage-eligible pool.
    const candidates = stageEligible.filter((p) => p.id !== previousAgentId)
    // Fall back to the first stage-eligible provider when only one is available — preserves the
    // existing single-provider behaviour where maker-checker relaxes rather than hard-errors.
    base = candidates[0] ?? stageEligible[0]
  }

  const activePreset = base.presets?.find((p) => p.id === base.selectedPresetId) ?? base.presets?.[0]
  const preferredModel = oneShot?.model ?? override?.model
  const preferredEffort = oneShot?.effort ?? override?.effort
  const effectiveModel = preferredModel !== undefined ? preferredModel : (base.model || activePreset?.model)
  const effectiveEffort = preferredEffort !== undefined ? preferredEffort : (base.effort || activePreset?.effort)

  return {
    ...base,
    model: effectiveModel,
    effort: effectiveEffort,
  }
}

/**
 * Non-throwing `resolveStageAgent()` for display: answers "who is lined up to run this stage, with
 * which model and effort" so a card can show its assignment *before* the stage has ever run. Returns
 * undefined for exactly the configurations `resolveStageAgent()` rejects (no providers registered,
 * none eligible for the stage, a pin that can't be honored) — the card simply shows nothing rather
 * than surfacing an error for a run the operator hasn't asked for yet.
 */
export function previewStageAgent(
  providers: AiProviderConfig[],
  params: StageAgentParams,
): AiProviderConfig | undefined {
  try {
    return resolveStageAgent(providers, params)
  } catch {
    return undefined
  }
}
