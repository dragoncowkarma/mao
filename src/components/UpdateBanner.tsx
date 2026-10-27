import type { AppUpdateCheck } from '../electron'
import type { Messages } from '../i18n'

interface UpdateBannerProps {
  /** Every string the banner shows, in the language the operator picked. */
  messages: Messages
  update: AppUpdateCheck
  onRestart: () => void
  onDismiss: () => void
}

function shortSha(sha: string) {
  return sha.slice(0, 7)
}

export default function UpdateBanner({ messages, update, onRestart, onDismiss }: UpdateBannerProps) {
  return (
    <div className="update-banner" role="status">
      <div className="min-w-0">
        <div className="update-banner-title">{messages.updateBanner.title}</div>
        <div className="update-banner-meta">
          {shortSha(update.currentSha)} -&gt; {shortSha(update.latestSha)}
          {update.runningTaskCount > 0 && messages.updateBanner.runningTasks(update.runningTaskCount)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={onRestart}>
          {messages.updateBanner.restart}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDismiss}>
          {messages.updateBanner.later}
        </button>
      </div>
    </div>
  )
}
