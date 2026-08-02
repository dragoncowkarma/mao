import { useState } from 'react'
import type { RepoRef } from '../../electron/workflow-engine'

interface ProjectSettingsProps {
  repo: RepoRef
  onChange: (patch: Partial<RepoRef>) => void
  onRemove: () => void
}

export default function ProjectSettings({ repo, onChange, onRemove }: ProjectSettingsProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const pollSeconds = Math.round((repo.pollIntervalMs ?? 30_000) / 1000)

  return (
    <div className="max-w-[420px]">
      <h3>Project settings</h3>
      <p className="text-muted mb-4 text-sm">
        Settings scoped to <strong>{repo.owner}/{repo.repo}</strong> only.
      </p>

      <div className="card mb-4 gap-3">
        <label className="flex items-center justify-between gap-2">
          <span>Auto-trigger new issues</span>
          <input
            type="checkbox"
            checked={repo.autoTrigger !== false}
            onChange={(e) => onChange({ autoTrigger: e.target.checked })}
          />
        </label>
        <p className="text-muted text-xs">
          When enabled, newly opened issues on this repo are automatically enqueued into the workflow.
        </p>

        <div className="field">
          <label>Poll interval (seconds)</label>
          <input
            className="input"
            type="number"
            min={5}
            value={pollSeconds}
            onChange={(e) => {
              const seconds = Math.max(5, Number(e.target.value) || 30)
              onChange({ pollIntervalMs: seconds * 1000 })
            }}
          />
        </div>
      </div>

      <div className="card gap-2">
        <p className="card-title text-[15px]">Remove project</p>
        <p className="text-muted text-xs">
          Stops polling and unregisters this repo. Existing GitHub issues/PRs are unaffected.
        </p>
        {confirmingRemove ? (
          <div className="flex gap-2">
            <button onClick={onRemove} className="btn btn-primary">
              Confirm remove
            </button>
            <button onClick={() => setConfirmingRemove(false)} className="btn btn-secondary">
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmingRemove(true)} className="btn btn-secondary self-start">
            Remove {repo.owner}/{repo.repo}
          </button>
        )}
      </div>
    </div>
  )
}
