import { useEffect, useState } from 'react'
import type { AiProviderConfig } from '../../electron/ai/types'

interface SettingsPanelProps {
  owner: string
  repo: string
  onRepoChange: (owner: string, repo: string) => void
}

function emptyProvider(): AiProviderConfig {
  return { id: crypto.randomUUID(), name: '', kind: 'api', apiFormat: 'anthropic' }
}

export default function SettingsPanel({ owner, repo, onRepoChange }: SettingsPanelProps) {
  const [ownerInput, setOwnerInput] = useState(owner)
  const [repoInput, setRepoInput] = useState(repo)
  const [githubToken, setGithubToken] = useState('')
  const [providers, setProviders] = useState<AiProviderConfig[]>([])
  const [savedMessage, setSavedMessage] = useState('')

  useEffect(() => {
    window.electronAPI.ai.list().then(setProviders)
    window.electronAPI.github.getConfig().then(({ owner: savedOwner, repo: savedRepo }) => {
      setOwnerInput(savedOwner)
      setRepoInput(savedRepo)
      onRepoChange(savedOwner, savedRepo)
    })
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
    await window.electronAPI.ai.save(providers)
    if (githubToken) await window.electronAPI.github.setToken(githubToken)
    await window.electronAPI.github.setRepo(ownerInput, repoInput)
    onRepoChange(ownerInput, repoInput)
    setSavedMessage('Saved')
    setTimeout(() => setSavedMessage(''), 1500)
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4 text-sm">
      <h2 className="mb-3 text-base font-semibold text-slate-100">Settings</h2>

      <div className="mb-4 grid grid-cols-3 gap-2">
        <input
          className="rounded bg-slate-900 px-2 py-1 text-slate-100"
          placeholder="GitHub owner"
          value={ownerInput}
          onChange={(e) => setOwnerInput(e.target.value)}
        />
        <input
          className="rounded bg-slate-900 px-2 py-1 text-slate-100"
          placeholder="GitHub repo"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
        />
        <input
          className="rounded bg-slate-900 px-2 py-1 text-slate-100"
          placeholder="GitHub token"
          type="password"
          value={githubToken}
          onChange={(e) => setGithubToken(e.target.value)}
        />
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-medium text-slate-300">AI Providers</h3>
        <button
          onClick={addProvider}
          className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-600"
        >
          + Add provider
        </button>
      </div>

      <div className="space-y-2">
        {providers.map((p) => (
          <div key={p.id} className="grid grid-cols-6 gap-2 rounded bg-slate-900 p-2">
            <input
              className="col-span-2 rounded bg-slate-800 px-2 py-1 text-slate-100"
              placeholder="Name"
              value={p.name}
              onChange={(e) => updateProvider(p.id, { name: e.target.value })}
            />
            <select
              className="rounded bg-slate-800 px-2 py-1 text-slate-100"
              value={p.kind}
              onChange={(e) => updateProvider(p.id, { kind: e.target.value as 'api' | 'cli' })}
            >
              <option value="api">API (BYOK)</option>
              <option value="cli">CLI</option>
            </select>

            {p.kind === 'api' ? (
              <>
                <select
                  className="rounded bg-slate-800 px-2 py-1 text-slate-100"
                  value={p.apiFormat ?? 'anthropic'}
                  onChange={(e) => updateProvider(p.id, { apiFormat: e.target.value as 'anthropic' | 'openai' })}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI-compatible</option>
                </select>
                <input
                  className="col-span-2 rounded bg-slate-800 px-2 py-1 text-slate-100"
                  placeholder="API key"
                  type="password"
                  value={p.apiKey ?? ''}
                  onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
                />
              </>
            ) : (
              <input
                className="col-span-3 rounded bg-slate-800 px-2 py-1 text-slate-100"
                placeholder="Command (e.g. claude)"
                value={p.command ?? ''}
                onChange={(e) => updateProvider(p.id, { command: e.target.value })}
              />
            )}

            <button
              onClick={() => removeProvider(p.id)}
              className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-200 hover:bg-red-900"
            >
              Remove
            </button>
          </div>
        ))}
        {providers.length === 0 && <p className="text-slate-500">No AI providers registered yet.</p>}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={saveAll}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Save
        </button>
        {savedMessage && <span className="text-xs text-emerald-400">{savedMessage}</span>}
      </div>
    </div>
  )
}
