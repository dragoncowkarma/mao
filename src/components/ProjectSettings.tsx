import { useState } from 'react'
import type { RepoRef } from '../../core/workflow-engine'
import type { Messages } from '../i18n'

interface ProjectSettingsProps {
  /** Every string this pane shows, in the language the operator picked. */
  messages: Messages
  repo: RepoRef
  onChange: (patch: Partial<RepoRef>) => void
  onRemove: () => void
}

export default function ProjectSettings({ messages, repo, onChange, onRemove }: ProjectSettingsProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const pollSeconds = Math.round((repo.pollIntervalMs ?? 30_000) / 1000)

  return (
    <div className="max-w-[420px]">
      <h3>{messages.projectSettings.heading}</h3>
      <p className="text-muted mb-4 text-sm">
        {messages.projectSettings.scopedTo.before}
        <strong>{repo.owner}/{repo.repo}</strong>
        {messages.projectSettings.scopedTo.after}
      </p>

      <div className="card mb-4 gap-3">
        <label className="flex items-center justify-between gap-2">
          <span>{messages.projectSettings.autoTrigger}</span>
          <input
            type="checkbox"
            checked={repo.autoTrigger !== false}
            onChange={(e) => onChange({ autoTrigger: e.target.checked })}
          />
        </label>
        <p className="text-muted text-xs">
          {messages.projectSettings.autoTriggerHint}
        </p>

        <div className="field">
          <label>{messages.projectSettings.pollInterval}</label>
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
        <p className="card-title text-[15px]">{messages.projectSettings.removeTitle}</p>
        <p className="text-muted text-xs">
          {messages.projectSettings.removeHint}
        </p>
        {confirmingRemove ? (
          <div className="flex gap-2">
            <button onClick={onRemove} className="btn btn-primary">
              {messages.projectSettings.confirmRemove}
            </button>
            <button onClick={() => setConfirmingRemove(false)} className="btn btn-secondary">
              {messages.common.cancel}
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmingRemove(true)} className="btn btn-secondary self-start">
            {messages.projectSettings.removeRepo(repo.owner, repo.repo)}
          </button>
        )}
      </div>
    </div>
  )
}
