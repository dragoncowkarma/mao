import { useEffect, useState } from 'react'
import type { AiProviderConfig } from '../../electron/ai/types'
import type { RepoRef } from '../../electron/workflow-engine'

interface SettingsPanelProps {
  repos: RepoRef[]
  onReposChange: (repos: RepoRef[]) => void
}

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

function resolveRepos(repoInputs: RepoRef[]): { valid: RepoRef[]; errors: string[] } {
  const errors: string[] = []
  const seen = new Set<string>()
  const valid: RepoRef[] = []

  for (const r of repoInputs) {
    const owner = r.owner.trim()
    const repo = r.repo.trim()
    if (!owner || !repo) continue // a blank row the user hasn't filled in yet — just skip it

    const key = `${owner}/${repo}`.toLowerCase()
    if (seen.has(key)) {
      errors.push(`Duplicate repository: ${owner}/${repo}.`)
      continue
    }
    seen.add(key)
    valid.push({ owner, repo })
  }

  return { valid, errors }
}

export default function SettingsPanel({ repos, onReposChange }: SettingsPanelProps) {
  const [repoInputs, setRepoInputs] = useState<RepoRef[]>(repos)
  const [githubToken, setGithubToken] = useState('')
  const [providers, setProviders] = useState<AiProviderConfig[]>([])
  const [savedMessage, setSavedMessage] = useState('')
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    window.electronAPI.ai.list().then(setProviders)
    window.electronAPI.github.getRepos().then((savedRepos) => {
      setRepoInputs(savedRepos)
      onReposChange(savedRepos)
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

  function updateRepo(index: number, patch: Partial<RepoRef>) {
    setRepoInputs((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function addRepo() {
    setRepoInputs((prev) => [...prev, { owner: '', repo: '' }])
  }

  function removeRepo(index: number) {
    setRepoInputs((prev) => prev.filter((_, i) => i !== index))
  }

  async function saveAll() {
    setSaveError('')

    const { valid: validRepos, errors: repoErrors } = resolveRepos(repoInputs)
    const errors = [...validateProviders(providers), ...repoErrors]
    if (errors.length > 0) {
      setSaveError(errors.join(' '))
      return
    }

    try {
      await window.electronAPI.ai.save(providers)
      if (githubToken) await window.electronAPI.github.setToken(githubToken)
      await window.electronAPI.github.setRepos(validRepos)
      onReposChange(validRepos)
      setSavedMessage('Saved')
      setTimeout(() => setSavedMessage(''), 1500)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4 text-sm">
      <h2 className="mb-3 text-base font-semibold text-slate-100">Settings</h2>

      <input
        className="mb-4 w-full rounded bg-slate-900 px-2 py-1 text-slate-100"
        placeholder="GitHub token"
        type="password"
        value={githubToken}
        onChange={(e) => setGithubToken(e.target.value)}
      />

      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-medium text-slate-300">Repositories</h3>
        <button
          onClick={addRepo}
          className="rounded bg-slate-700 px-2 py-1 text-xs text-slate-100 hover:bg-slate-600"
        >
          + Add repo
        </button>
      </div>

      <div className="mb-4 space-y-2">
        {repoInputs.map((r, i) => (
          <div key={i} className="flex gap-2 rounded bg-slate-900 p-2">
            <input
              className="flex-1 rounded bg-slate-800 px-2 py-1 text-slate-100"
              placeholder="owner"
              value={r.owner}
              onChange={(e) => updateRepo(i, { owner: e.target.value })}
            />
            <input
              className="flex-1 rounded bg-slate-800 px-2 py-1 text-slate-100"
              placeholder="repo"
              value={r.repo}
              onChange={(e) => updateRepo(i, { repo: e.target.value })}
            />
            <button
              onClick={() => removeRepo(i)}
              className="rounded bg-red-900/50 px-2 py-1 text-xs text-red-200 hover:bg-red-900"
            >
              Remove
            </button>
          </div>
        ))}
        {repoInputs.length === 0 && <p className="text-slate-500">No repositories registered yet.</p>}
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
      {saveError && <p className="mt-2 text-xs text-red-400">{saveError}</p>}
    </div>
  )
}
