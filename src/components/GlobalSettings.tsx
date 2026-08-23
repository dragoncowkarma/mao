import { useEffect, useState } from 'react'
import type { AgentStage, AiProviderConfig, ModelEffortPreset, ProviderKindId } from '../../core/ai/types'
import { PROVIDER_OPTIONS } from '../../core/ai/provider-options'
import type { ThemePreference } from '../../core/store'

const ALL_STAGES: AgentStage[] = ['issue', 'pr', 'review', 'merge']
const STAGE_LABELS: Record<AgentStage, string> = { issue: 'Issue', pr: 'PR', review: 'Review', merge: 'Merge' }

interface GlobalSettingsProps {
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

function emptyProvider(): AiProviderConfig {
  return { id: crypto.randomUUID(), name: '', kind: 'api', apiFormat: 'anthropic' }
}

function emptyPreset(): ModelEffortPreset {
  return { id: crypto.randomUUID(), model: '' }
}

function validateProviders(providers: AiProviderConfig[]): string[] {
  const errors: string[] = []
  const seenNames = new Set<string>()

  for (const p of providers) {
    const name = p.name.trim()
    const label = name || 'Unnamed provider'

    if (!name) {
      errors.push('Every AI provider needs a name.')
    } else {
      const key = name.toLowerCase()
      if (seenNames.has(key)) errors.push(`Duplicate provider name: "${name}".`)
      seenNames.add(key)
    }

    if (p.kind === 'api' && !p.apiKey?.trim()) errors.push(`"${label}" is an API provider but has no API key.`)
    if (p.kind === 'cli' && !p.command?.trim()) errors.push(`"${label}" is a CLI provider but has no command.`)
  }

  return errors
}

const PROVIDER_KIND_LABELS: Record<ProviderKindId, string> = {
  antigravity: 'Antigravity (agy)',
  claude: 'Claude',
  codex: 'Codex',
  custom: 'Custom',
}

// ─── Preset row ────────────────────────────────────────────────────────────────

interface PresetRowProps {
  preset: ModelEffortPreset
  kindId?: ProviderKindId
  isSelected: boolean
  onSelect: () => void
  onChange: (patch: Partial<ModelEffortPreset>) => void
  onRemove: () => void
}

function PresetRow({ preset, kindId, isSelected, onSelect, onChange, onRemove }: PresetRowProps) {
  const opts = kindId ? PROVIDER_OPTIONS[kindId] : null
  const modelOpts = opts?.models ?? []
  const effortOpts = opts?.efforts ?? []

  const selectedModelOpt = modelOpts.find((m) => m.value === preset.model)
  const noEffort = selectedModelOpt?.noEffort ?? false
  const showEffort = effortOpts.length > 0 && !noEffort

  return (
    <div className={`flex items-center gap-2 rounded border px-3 py-2 ${isSelected ? 'border-[var(--color-accent)] bg-[var(--color-bg)]' : 'border-[var(--color-border)] bg-[var(--color-bg-subtle)]'}`}>
      <input
        type="radio"
        checked={isSelected}
        onChange={onSelect}
        title="Set as active preset"
        className="cursor-pointer"
      />

      {/* Model */}
      {modelOpts.length > 0 ? (
        <select
          className="input flex-1 min-w-[180px]"
          value={preset.model}
          onChange={(e) => onChange({ model: e.target.value, effort: undefined })}
        >
          <option value="">— select model —</option>
          {modelOpts.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input flex-1 min-w-[180px]"
          placeholder="Model ID (e.g. gpt-4o)"
          value={preset.model}
          onChange={(e) => onChange({ model: e.target.value })}
        />
      )}

      {/* Effort */}
      {showEffort && (
        <select
          className="input w-[140px] flex-none"
          value={preset.effort ?? ''}
          onChange={(e) =>
            onChange({ effort: (e.target.value || undefined) as ModelEffortPreset['effort'] })
          }
        >
          <option value="">Effort: —</option>
          {effortOpts.map((ef) => (
            <option key={ef.value} value={ef.value}>
              {ef.label}
            </option>
          ))}
        </select>
      )}
      {noEffort && (
        <span className="text-muted text-xs w-[140px] flex-none pl-1">No effort</span>
      )}

      <button onClick={onRemove} className="btn btn-ghost shrink-0 text-xs">
        Remove
      </button>
    </div>
  )
}

// ─── Provider card ─────────────────────────────────────────────────────────────

interface ProviderCardProps {
  provider: AiProviderConfig
  onUpdate: (patch: Partial<AiProviderConfig>) => void
  onRemove: () => void
}

function ProviderCard({ provider: p, onUpdate, onRemove }: ProviderCardProps) {
  const [presetsExpanded, setPresetsExpanded] = useState(false)

  function updatePreset(presetId: string, patch: Partial<ModelEffortPreset>) {
    const updatedPresets = (p.presets ?? []).map((pr) => (pr.id === presetId ? { ...pr, ...patch } : pr))
    const patchObj: Partial<AiProviderConfig> = { presets: updatedPresets }
    
    // If updating the active preset, sync default model and effort
    if (p.selectedPresetId === presetId) {
      const activePr = updatedPresets.find((pr) => pr.id === presetId)
      if (activePr) {
        patchObj.model = activePr.model
        patchObj.effort = activePr.effort
      }
    }
    onUpdate(patchObj)
  }

  function addPreset() {
    const newPreset = emptyPreset()
    const nextPresets = [...(p.presets ?? []), newPreset]
    const patchObj: Partial<AiProviderConfig> = { presets: nextPresets }
    if (!p.selectedPresetId) {
      patchObj.selectedPresetId = newPreset.id
    }
    onUpdate(patchObj)
    setPresetsExpanded(true)
  }

  function removePreset(presetId: string) {
    const nextPresets = (p.presets ?? []).filter((pr) => pr.id !== presetId)
    const patchObj: Partial<AiProviderConfig> = { presets: nextPresets }
    if (p.selectedPresetId === presetId) {
      const nextActive = nextPresets[0]
      patchObj.selectedPresetId = nextActive?.id
      patchObj.model = nextActive?.model ?? ''
      patchObj.effort = nextActive?.effort
    }
    onUpdate(patchObj)
  }

  function selectPreset(presetId: string) {
    const selected = (p.presets ?? []).find((pr) => pr.id === presetId)
    onUpdate({
      selectedPresetId: presetId,
      model: selected?.model ?? p.model,
      effort: selected?.effort ?? p.effort,
    })
  }

  const presetCount = p.presets?.length ?? 0
  const kindOpts = p.providerKindId ? PROVIDER_OPTIONS[p.providerKindId] : PROVIDER_OPTIONS.custom

  return (
    <div className="card flex flex-col gap-3">
      {/* ── Top row: basic fields ── */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-[140px] flex-1"
          placeholder="Name"
          value={p.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
        />
        <select
          className="input w-[130px] flex-none"
          value={p.kind}
          onChange={(e) => onUpdate({ kind: e.target.value as 'api' | 'cli' })}
        >
          <option value="api">API (BYOK)</option>
          <option value="cli">CLI</option>
        </select>

        {p.kind === 'api' ? (
          <>
            <select
              className="input w-[150px] flex-none"
              value={p.apiFormat ?? 'anthropic'}
              onChange={(e) =>
                onUpdate({ apiFormat: e.target.value as 'anthropic' | 'openai' })
              }
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
            <input
              className="input min-w-[140px] flex-1"
              placeholder="API key"
              type="password"
              value={p.apiKey ?? ''}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
            />
          </>
        ) : (
          <>
            <input
              className="input min-w-[180px] flex-1"
              placeholder="Command (e.g. claude)"
              value={p.command ?? ''}
              onChange={(e) => onUpdate({ command: e.target.value })}
            />
            <select
              className="input w-[170px] flex-none"
              value={p.providerKindId ?? 'custom'}
              onChange={(e) =>
                onUpdate({ providerKindId: e.target.value as ProviderKindId, presets: [], selectedPresetId: undefined })
              }
            >
              {(Object.keys(PROVIDER_KIND_LABELS) as ProviderKindId[]).map((k) => (
                <option key={k} value={k}>
                  {PROVIDER_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </>
        )}

        {/* Default Model & Effort inline fields (Restored for review point 2) */}
        {kindOpts.models.length > 0 ? (
          <select
            className="input w-[160px] flex-none"
            value={p.model ?? ''}
            onChange={(e) => onUpdate({ model: e.target.value })}
          >
            <option value="">Model: default</option>
            {kindOpts.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input w-[140px] flex-none"
            placeholder="Model (optional)"
            value={p.model ?? ''}
            onChange={(e) => onUpdate({ model: e.target.value })}
          />
        )}

        <select
          className="input w-[120px] flex-none"
          value={p.effort ?? ''}
          onChange={(e) =>
            onUpdate({ effort: (e.target.value || undefined) as AiProviderConfig['effort'] })
          }
        >
          <option value="">Effort: —</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="xhigh">X-High</option>
          <option value="max">Max</option>
        </select>

        <button onClick={onRemove} className="btn btn-ghost shrink-0">
          Remove
        </button>
      </div>

      {/* Stage restrictions — leave all unchecked to allow any stage (unrestricted). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted">Allowed stages:</span>
        {ALL_STAGES.map((stage) => {
          const isRestricted = !!(p.allowedStages && p.allowedStages.length > 0)
          return (
            <label key={stage} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={isRestricted ? p.allowedStages!.includes(stage) : false}
                onChange={(e) => {
                  const current = p.allowedStages && p.allowedStages.length > 0 ? p.allowedStages : []
                  const next = e.target.checked
                    ? [...current, stage]
                    : current.filter((s) => s !== stage)
                  // An empty selection means unrestricted — store as undefined to keep configs clean.
                  onUpdate({ allowedStages: next.length > 0 ? next : undefined })
                }}
              />
              {STAGE_LABELS[stage]}
            </label>
          )
        })}
        <span className="text-muted italic">
          {!p.allowedStages || p.allowedStages.length === 0
            ? '(all stages — unrestricted)'
            : `restricted to: ${p.allowedStages.map((s) => STAGE_LABELS[s]).join(', ')}`}
        </span>
      </div>

      {/* ── Presets section (CLI & API) ── */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <button
            className="flex items-center gap-1 text-xs text-muted hover:text-[var(--color-text)] transition-colors"
            onClick={() => setPresetsExpanded((v) => !v)}
          >
            <span style={{ display: 'inline-block', transform: presetsExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
            Model / Effort presets
            {presetCount > 0 && (
              <span className="ml-1 rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] text-white">
                {presetCount}
              </span>
            )}
          </button>
          <button onClick={addPreset} className="btn btn-secondary text-xs">
            + Add preset
          </button>
        </div>

        {presetsExpanded && (
          <div className="flex flex-col gap-2 pl-2">
            {(p.presets ?? []).length === 0 ? (
              <p className="text-muted text-xs">No presets yet. Click "+ Add preset" to add one.</p>
            ) : (
              (p.presets ?? []).map((pr) => (
                <PresetRow
                  key={pr.id}
                  preset={pr}
                  kindId={p.providerKindId}
                  isSelected={p.selectedPresetId === pr.id}
                  onSelect={() => selectPreset(pr.id)}
                  onChange={(patch) => updatePreset(pr.id, patch)}
                  onRemove={() => removePreset(pr.id)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── GlobalSettings ────────────────────────────────────────────────────────────

export default function GlobalSettings({ theme, onThemeChange }: GlobalSettingsProps) {
  const [githubToken, setGithubToken] = useState('')
  const [providers, setProviders] = useState<AiProviderConfig[]>([])
  const [savedMessage, setSavedMessage] = useState('')
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    window.electronAPI.ai.list().then(setProviders)
  }, [])

  function updateProvider(id: string, patch: Partial<AiProviderConfig>) {
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  function addProvider() {
    setProviders((prev) => [...prev, emptyProvider()])
  }

  function removeProvider(id: string) {
    setProviders((prev) => prev.filter((p) => p.id !== id))
  }

  async function saveAll() {
    setSaveError('')

    const errors = validateProviders(providers)
    if (errors.length > 0) {
      setSaveError(errors.join(' '))
      return
    }

    try {
      await window.electronAPI.ai.save(providers)
      if (githubToken) await window.electronAPI.github.setToken(githubToken)
      setSavedMessage('Saved')
      setTimeout(() => setSavedMessage(''), 1500)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div>
      <h2>Global settings</h2>
      <p className="text-muted mb-4 text-sm">Applies across every registered project.</p>

      <div className="mb-4">
        <h3 className="!mb-2">Appearance</h3>
        <div className="tabs">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`tab ${theme === opt.value ? 'active' : ''}`}
              onClick={() => onThemeChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-muted -mt-2 text-xs">
          "System" follows your OS light/dark setting and updates automatically if it changes.
        </p>
      </div>

      <div className="field mb-4 max-w-[420px]">
        <label>GitHub token</label>
        <input
          className="input"
          placeholder="ghp_..."
          type="password"
          value={githubToken}
          onChange={(e) => setGithubToken(e.target.value)}
        />
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h3 className="!m-0">AI Providers</h3>
        <button onClick={addProvider} className="btn btn-secondary">
          + Add provider
        </button>
      </div>

      <div className="mb-4 flex flex-col gap-3">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            onUpdate={(patch) => updateProvider(p.id, patch)}
            onRemove={() => removeProvider(p.id)}
          />
        ))}
        {providers.length === 0 && <p className="text-muted">No AI providers registered yet.</p>}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={saveAll} className="btn btn-primary">
          Save changes
        </button>
        {savedMessage && (
          <span className="text-xs" style={{ color: 'var(--color-accent)' }}>
            {savedMessage}
          </span>
        )}
      </div>
      {saveError && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-accent-700)' }}>
          {saveError}
        </p>
      )}
    </div>
  )
}
