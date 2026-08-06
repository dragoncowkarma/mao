import { useEffect, useState } from 'react'
import type { AiProviderConfig } from '../../core/ai/types'
import type { ThemePreference } from '../../core/store'

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

      <div className="mb-4 flex flex-col gap-2">
        {providers.map((p) => (
          <div key={p.id} className="card flex-row flex-wrap items-center gap-2">
            <input
              className="input min-w-[140px] flex-1"
              placeholder="Name"
              value={p.name}
              onChange={(e) => updateProvider(p.id, { name: e.target.value })}
            />
            <select
              className="input w-[130px] flex-none"
              value={p.kind}
              onChange={(e) => updateProvider(p.id, { kind: e.target.value as 'api' | 'cli' })}
            >
              <option value="api">API (BYOK)</option>
              <option value="cli">CLI</option>
            </select>

            {p.kind === 'api' ? (
              <>
                <select
                  className="input w-[150px] flex-none"
                  value={p.apiFormat ?? 'anthropic'}
                  onChange={(e) => updateProvider(p.id, { apiFormat: e.target.value as 'anthropic' | 'openai' })}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI-compatible</option>
                </select>
                <input
                  className="input min-w-[140px] flex-1"
                  placeholder="API key"
                  type="password"
                  value={p.apiKey ?? ''}
                  onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                />
              </>
            ) : (
              <input
                className="input min-w-[180px] flex-1"
                placeholder="Command (e.g. claude)"
                value={p.command ?? ''}
                onChange={(e) => updateProvider(p.id, { command: e.target.value })}
              />
            )}

            <input
              className="input w-[130px] flex-none"
              placeholder="Model (optional)"
              value={p.model ?? ''}
              onChange={(e) => updateProvider(p.id, { model: e.target.value })}
            />
            <select
              className="input w-[110px] flex-none"
              value={p.effort ?? ''}
              onChange={(e) =>
                updateProvider(p.id, { effort: (e.target.value || undefined) as AiProviderConfig['effort'] })
              }
            >
              <option value="">Effort: —</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>

            <button onClick={() => removeProvider(p.id)} className="btn btn-ghost shrink-0">
              Remove
            </button>
          </div>
        ))}
        {providers.length === 0 && <p className="text-muted">No AI providers registered yet.</p>}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={saveAll} className="btn btn-primary">
          Save changes
        </button>
        {savedMessage && <span className="text-xs" style={{ color: 'var(--color-accent)' }}>{savedMessage}</span>}
      </div>
      {saveError && (
        <p className="mt-2 text-xs" style={{ color: 'var(--color-accent-700)' }}>
          {saveError}
        </p>
      )}
    </div>
  )
}
