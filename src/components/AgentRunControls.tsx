import { useState } from 'react'
import type { AiProviderConfig } from '../../core/ai/types'
import type { EffortOption, ModelOption } from '../../core/ai/provider-options'
import { getProviderOptions } from '../../core/ai/provider-options'
import { eligibleAgentsForRun, previewStageAgent } from '../../core/agent-selection'
import type { RunOverride } from '../../core/agent-selection'
import type { QueuedTask } from '../../core/workflow-engine'

interface AgentRunControlsProps {
  task: QueuedTask
  /** Every registered provider, as returned by `window.electronAPI.ai.list()`. */
  providers: AiProviderConfig[]
  /** Text for the action button — 'Run' for a paused stage, 'Retry' for a failed one. */
  actionLabel: string
  busy: boolean
  /** Receives the one-shot override the operator picked, or undefined when they changed nothing. */
  onRun: (runOverride?: RunOverride) => void
}

/**
 * Names the tool behind a provider, since a provider's `name` is operator-chosen and needn't say
 * which CLI it drives. 'custom' adds nothing the name doesn't already say, so it stays off the label.
 */
function toolLabel(provider: AiProviderConfig): string {
  return provider.providerKindId && provider.providerKindId !== 'custom'
    ? `${provider.name} · ${provider.providerKindId}`
    : provider.name
}

/** Appends values that are in play but absent from the tool's catalog, so a hand-entered preset model
 * (or an API provider, whose kind has no catalog at all) is still offered — and so the
 * currently-resolved value always has a matching <option> to render. */
function withConfigured<T extends { value: string }>(catalog: T[], configured: (string | undefined)[], make: (v: string) => T): T[] {
  const seen = new Set(catalog.map((o) => o.value))
  const extras: T[] = []
  for (const value of configured) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    extras.push(make(value))
  }
  return extras.length > 0 ? [...catalog, ...extras] : catalog
}

/**
 * `resolved` is what the engine would actually use right now, and it has sources the provider config
 * doesn't — the task's durable `ProviderOverride`, set by an issue body's `[Model: …]` tag or by
 * `enqueue --model`. Passing it in keeps the select from falling back to its placeholder on exactly
 * the tasks that *do* carry an explicit assignment.
 */
function modelOptionsFor(provider: AiProviderConfig | undefined, resolved: string | undefined): ModelOption[] {
  if (!provider) return []
  return withConfigured(
    getProviderOptions(provider.providerKindId).models,
    [provider.model, ...(provider.presets ?? []).map((p) => p.model), resolved],
    (value) => ({ value, label: value }),
  )
}

/** Empty when the chosen model takes no reasoning-effort flag — the same rule GlobalSettings applies. */
function effortOptionsFor(
  provider: AiProviderConfig | undefined,
  model: string | undefined,
  resolved: string | undefined,
): EffortOption[] {
  if (!provider) return []
  const options = getProviderOptions(provider.providerKindId)
  if (takesNoEffort(provider, model)) return []
  return withConfigured(
    options.efforts,
    [provider.effort, ...(provider.presets ?? []).map((p) => p.effort), resolved],
    (value) => ({ value: value as EffortOption['value'], label: value }),
  )
}

/** True for a catalog model flagged as taking no reasoning-effort argument. */
function takesNoEffort(provider: AiProviderConfig | undefined, model: string | undefined): boolean {
  return getProviderOptions(provider?.providerKindId).models.find((m) => m.value === model)?.noEffort ?? false
}

/**
 * The Tool / Model / Effort dropdowns plus the Run/Retry button on a board or queue card (issue #42).
 *
 * Whatever the operator picks is a **one-shot** override: it rides along on this single
 * `retry()`/`advance()` call, applies to exactly one stage execution, and touches neither the saved
 * provider config nor the task's durable `providerOverride` pin.
 *
 * Local state holds only the fields actually changed, while each `<select>` *displays*
 * `previewStageAgent()` — the engine's own resolution of the current picks. So an untouched card
 * shows who is really lined up to run next (including one that has never run, which used to show
 * nothing at all) and still sends no override, while a touched one shows exactly what will happen.
 * The tool list comes from `eligibleAgentsForRun()`, the same rule the engine enforces, so a choice
 * maker-checker forbids is never offered in the first place — and if a stale render slips one
 * through, the engine rejects the call with a clear message rather than silently running someone else.
 */
export default function AgentRunControls({ task, providers, actionLabel, busy, onRun }: AgentRunControlsProps) {
  const [pick, setPick] = useState<RunOverride>({})

  const previous = task.history[task.history.length - 1]
  const preview = previewStageAgent(providers, {
    stage: task.stage,
    previous,
    override: task.providerOverride,
    oneShot: pick,
  })

  const agentOptions = eligibleAgentsForRun(providers, task.stage, previous)
  const provider = providers.find((p) => p.id === preview?.id)
  const modelOptions = modelOptionsFor(provider, preview?.model)
  const effortOptions = effortOptionsFor(provider, preview?.model, preview?.effort)

  const runButton = (
    <button
      type="button"
      onClick={() => onRun(pick.providerId || pick.model || pick.effort ? pick : undefined)}
      disabled={busy}
      className="btn btn-primary ml-auto shrink-0 px-2.5 py-1 text-xs"
    >
      {busy ? 'Running…' : actionLabel}
    </button>
  )

  // Nothing to choose between until the provider list has loaded (or while none are configured) —
  // fall back to the plain button so the card never loses its Run/Retry action.
  if (agentOptions.length === 0) return <div className="flex items-center gap-1.5">{runButton}</div>

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        className="input input-sm w-auto flex-none"
        title="AI tool for this run"
        value={preview?.id ?? ''}
        // A different tool has its own models and efforts, so any pick made for the old one is stale.
        onChange={(e) => setPick({ providerId: e.target.value || undefined })}
      >
        {agentOptions.map((p) => (
          <option key={p.id} value={p.id}>
            {toolLabel(p)}
          </option>
        ))}
      </select>

      <select
        className="input input-sm w-auto flex-none"
        title="Model for this run"
        value={preview?.model ?? ''}
        onChange={(e) => {
          const model = e.target.value || undefined
          // Switching to a model that takes no effort flag hides the effort select, so drop any
          // effort already picked rather than sending a value the card has stopped showing.
          setPick((prev) => ({ ...prev, model, effort: takesNoEffort(provider, model) ? undefined : prev.effort }))
        }}
      >
        <option value="">— model —</option>
        {modelOptions.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>

      {effortOptions.length > 0 && (
        <select
          className="input input-sm w-auto flex-none"
          title="Reasoning effort for this run"
          value={preview?.effort ?? ''}
          onChange={(e) => setPick((prev) => ({ ...prev, effort: (e.target.value || undefined) as RunOverride['effort'] }))}
        >
          <option value="">— effort —</option>
          {effortOptions.map((ef) => (
            <option key={ef.value} value={ef.value}>
              {ef.label}
            </option>
          ))}
        </select>
      )}

      {runButton}
    </div>
  )
}
