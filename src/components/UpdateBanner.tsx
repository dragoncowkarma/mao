import type { AppUpdateCheck } from '../electron'

interface UpdateBannerProps {
  update: AppUpdateCheck
  onRestart: () => void
  onDismiss: () => void
}

function shortSha(sha: string) {
  return sha.slice(0, 7)
}

export default function UpdateBanner({ update, onRestart, onDismiss }: UpdateBannerProps) {
  return (
    <div className="update-banner" role="status">
      <div className="min-w-0">
        <div className="update-banner-title">New version available</div>
        <div className="update-banner-meta">
          {shortSha(update.currentSha)} -&gt; {shortSha(update.latestSha)}
          {update.runningTaskCount > 0 && ` - ${update.runningTaskCount} workflow task(s) running`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={onRestart}>
          Restart
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDismiss}>
          Later
        </button>
      </div>
    </div>
  )
}
