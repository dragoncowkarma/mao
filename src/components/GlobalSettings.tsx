import { useEffect, useState } from 'react'
import { electronApi } from '../electron-api'
import type { AgentStage, AiProviderConfig, ModelEffortPreset, ProviderKindId } from '../../core/ai/types'
import { PROVIDER_OPTIONS } from '../../core/ai/provider-options'
import type { ThemePreference } from '../../core/store'
import { LANGUAGE_PREFERENCES, type LanguagePreference } from '../../core/ui-language'
import { LANGUAGE_NAMES, uiLanguageFor, wordIn, type Messages, type Wording } from '../i18n'

const ALL_STAGES: AgentStage[] = ['issue', 'pr', 'review', 'merge']

interface GlobalSettingsProps {
  /** Every string this pane shows, in the language the operator picked. */
  messages: Messages
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
  /** The stored language preference — the same state the sidebar's language menu edits. */
  language: LanguagePreference
  onLanguageChange: (language: LanguagePreference) => void
}

const THEME_OPTIONS: ThemePreference[] = ['light', 'dark', 'system']

function emptyProvider(): AiProviderConfig {
  return { id: crypto.randomUUID(), name: '', kind: 'api', apiFormat: 'anthropic' }
}

function emptyPreset(): ModelEffortPreset {
  return { id: crypto.randomUUID(), model: '' }
}

function validateProviders(providers: AiProviderConfig[], messages: Messages): string[] {
  const text = messages.globalSettings.validation
  const errors: string[] = []
  const seenNames = new Set<string>()

  for (const p of providers) {
    const name = p.name.trim()
    const label = name || text.unnamedProvider

    if (!name) {
      errors.push(text.nameRequired)
    } else {
      const key = name.toLowerCase()
      if (seenNames.has(key)) errors.push(text.duplicateName(name))
      seenNames.add(key)
    }

    if (p.kind === 'api' && !p.apiKey?.trim()) errors.push(text.apiKeyMissing(label))
    if (p.kind === 'cli' && !p.command?.trim()) errors.push(text.commandMissing(label))
  }

  return errors
}

// ─── Preset row ────────────────────────────────────────────────────────────────

interface PresetRowProps {
  messages: Messages
  preset: ModelEffortPreset
  kindId?: ProviderKindId
  isSelected: boolean
  onSelect: () => void
  onChange: (patch: Partial<ModelEffortPreset>) => void
  onRemove: () => void
}

function PresetRow({ messages, preset, kindId, isSelected, onSelect, onChange, onRemove }: PresetRowProps) {
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
        title={messages.globalSettings.setActivePreset}
        className="cursor-pointer"
      />

      {/* Model */}
      {modelOpts.length > 0 ? (
        <select
          className="input flex-1 min-w-[180px]"
          value={preset.model}
          onChange={(e) => onChange({ model: e.target.value, effort: undefined })}
        >
          <option value="">{messages.globalSettings.selectModel}</option>
          {modelOpts.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input flex-1 min-w-[180px]"
          placeholder={messages.globalSettings.modelIdPlaceholder}
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
          <option value="">{messages.globalSettings.effortUnset}</option>
          {effortOpts.map((ef) => (
            <option key={ef.value} value={ef.value}>
              {ef.label}
            </option>
          ))}
        </select>
      )}
      {noEffort && (
        <span className="text-muted text-xs w-[140px] flex-none pl-1">
          {messages.globalSettings.noEffort}
        </span>
      )}

      <button onClick={onRemove} className="btn btn-ghost shrink-0 text-xs">
        {messages.globalSettings.remove}
      </button>
    </div>
  )
}

// ─── Provider card ─────────────────────────────────────────────────────────────

interface ProviderCardProps {
  messages: Messages
  provider: AiProviderConfig
  onUpdate: (patch: Partial<AiProviderConfig>) => void
  onRemove: () => void
}

function ProviderCard({ messages, provider: p, onUpdate, onRemove }: ProviderCardProps) {
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
          placeholder={messages.globalSettings.providerNamePlaceholder}
          value={p.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
        />
        <select
          className="input w-[130px] flex-none"
          value={p.kind}
          onChange={(e) => onUpdate({ kind: e.target.value as 'api' | 'cli' })}
        >
          <option value="api">{messages.globalSettings.kindOptions.api}</option>
          <option value="cli">{messages.globalSettings.kindOptions.cli}</option>
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
              <option value="anthropic">{messages.globalSettings.apiFormatOptions.anthropic}</option>
              <option value="openai">{messages.globalSettings.apiFormatOptions.openai}</option>
            </select>
            <input
              className="input min-w-[140px] flex-1"
              placeholder={messages.globalSettings.apiKeyPlaceholder}
              type="password"
              value={p.apiKey ?? ''}
              onChange={(e) => onUpdate({ apiKey: e.target.value })}
            />
          </>
        ) : (
          <>
            <input
              className="input min-w-[180px] flex-1"
              placeholder={messages.globalSettings.commandPlaceholder}
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
              {(Object.keys(messages.globalSettings.toolOptions) as ProviderKindId[]).map((k) => (
                <option key={k} value={k}>
                  {messages.globalSettings.toolOptions[k]}
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
            <option value="">{messages.globalSettings.modelDefault}</option>
            {kindOpts.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input w-[140px] flex-none"
            placeholder={messages.globalSettings.modelPlaceholder}
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
          <option value="">{messages.globalSettings.effortUnset}</option>
          <option value="low">{messages.globalSettings.effortOptions.low}</option>
          <option value="medium">{messages.globalSettings.effortOptions.medium}</option>
          <option value="high">{messages.globalSettings.effortOptions.high}</option>
          <option value="xhigh">{messages.globalSettings.effortOptions.xhigh}</option>
          <option value="max">{messages.globalSettings.effortOptions.max}</option>
        </select>

        <button onClick={onRemove} className="btn btn-ghost shrink-0">
          {messages.globalSettings.remove}
        </button>
      </div>

      {/* Stage restrictions — leave all unchecked to allow any stage (unrestricted). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted">{messages.globalSettings.allowedStages}</span>
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
              {messages.common.stages[stage]}
            </label>
          )
        })}
        <span className="text-muted italic">
          {!p.allowedStages || p.allowedStages.length === 0
            ? messages.globalSettings.allStagesUnrestricted
            : messages.globalSettings.restrictedTo(p.allowedStages.map((s) => messages.common.stages[s]))}
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
            {messages.globalSettings.presets}
            {presetCount > 0 && (
              <span className="ml-1 rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] text-white">
                {presetCount}
              </span>
            )}
          </button>
          <button onClick={addPreset} className="btn btn-secondary text-xs">
            {messages.globalSettings.addPreset}
          </button>
        </div>

        {presetsExpanded && (
          <div className="flex flex-col gap-2 pl-2">
            {(p.presets ?? []).length === 0 ? (
              <p className="text-muted text-xs">{messages.globalSettings.noPresets}</p>
            ) : (
              (p.presets ?? []).map((pr) => (
                <PresetRow
                  key={pr.id}
                  messages={messages}
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

export default function GlobalSettings({
  messages,
  theme,
  onThemeChange,
  language,
  onLanguageChange,
}: GlobalSettingsProps) {
  const [githubToken, setGithubToken] = useState('')
  const [providers, setProviders] = useState<AiProviderConfig[]>([])
  const [saved, setSaved] = useState(false)
  /**
   * Why Save did not go through. Validation is worded at render — from the providers as they were when
   * Save was clicked — so a language switch re-words it; a refusal from main is its own text.
   */
  const [saveError, setSaveError] = useState<Wording>('')

  useEffect(() => {
    electronApi().ai.list().then(setProviders)
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

    if (validateProviders(providers, messages).length > 0) {
      const attempted = providers
      setSaveError({ word: (m) => validateProviders(attempted, m).join(' ') })
      return
    }

    try {
      await electronApi().ai.save(providers)
      if (githubToken) await electronApi().github.setToken(githubToken)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div>
      <h2>{messages.globalSettings.heading}</h2>
      <p className="text-muted mb-4 text-sm">{messages.globalSettings.description}</p>

      <div className="mb-4">
        <h3 className="!mb-2">{messages.globalSettings.appearance}</h3>
        <div className="tabs">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option}
              className={`tab ${theme === option ? 'active' : ''}`}
              onClick={() => onThemeChange(option)}
            >
              {messages.globalSettings.themeOptions[option]}
            </button>
          ))}
        </div>
        <p className="text-muted -mt-2 text-xs">{messages.globalSettings.themeSystemHint}</p>
      </div>

      <div className="mb-4">
        <h3 className="!mb-2">{messages.language.label}</h3>
        {/* A labelled group, because Appearance above has a "System" button too. */}
        <div className="tabs" role="group" aria-label={messages.language.label}>
          {LANGUAGE_PREFERENCES.map((preference) => (
            <button
              key={preference}
              className={`tab ${language === preference ? 'active' : ''}`}
              aria-pressed={language === preference}
              // The name is in its own language, and says so, so a screen reader voices it correctly.
              lang={preference === 'system' ? undefined : preference}
              onClick={() => onLanguageChange(preference)}
            >
              {preference === 'system' ? messages.language.system : LANGUAGE_NAMES[preference]}
            </button>
          ))}
        </div>
        <p className="text-muted -mt-2 text-xs">{messages.language.hint(LANGUAGE_NAMES[uiLanguageFor('system')])}</p>
      </div>

      <div className="field mb-4 max-w-[420px]">
        <label>{messages.globalSettings.githubToken}</label>
        <input
          className="input"
          placeholder={messages.globalSettings.githubTokenPlaceholder}
          type="password"
          value={githubToken}
          onChange={(e) => setGithubToken(e.target.value)}
        />
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h3 className="!m-0">{messages.globalSettings.aiProviders}</h3>
        <button onClick={addProvider} className="btn btn-secondary">
          {messages.globalSettings.addProvider}
        </button>
      </div>

      <div className="mb-4 flex flex-col gap-3">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            messages={messages}
            provider={p}
            onUpdate={(patch) => updateProvider(p.id, patch)}
            onRemove={() => removeProvider(p.id)}
          />
        ))}
        {providers.length === 0 && <p className="text-muted">{messages.globalSettings.noProviders}</p>}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={saveAll} className="btn btn-primary">
          {messages.globalSettings.saveChanges}
        </button>
        {saved && (
          <span className="text-xs" style={{ color: 'var(--color-accent)' }}>
            {messages.globalSettings.saved}
          </span>
        )}
      </div>
      {saveError && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-accent-700)' }}>
          {wordIn(saveError, messages)}
        </p>
      )}
    </div>
  )
}
