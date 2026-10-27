import type { UiLanguage } from '../../../core/ui-language'

/**
 * What `src/components/ProjectSettings.tsx` shows. "Cancel" comes from `common`; the project's
 * `owner`/`repo` are shown as they are stored.
 */
const en = {
  heading: 'Project settings',
  /**
   * The line under the heading, in two parts around the project's `owner/repo`, which the component
   * shows in bold between them. A language that names the project first leaves `before` empty.
   */
  scopedTo: { before: 'Settings scoped to ', after: ' only.' },
  autoTrigger: 'Auto-trigger new issues',
  autoTriggerHint:
    'When enabled, newly opened issues on this repo are automatically enqueued into the workflow.',
  pollInterval: 'Poll interval (seconds)',
  removeTitle: 'Remove project',
  /** What removing does and what it leaves alone — a translation keeps both halves. */
  removeHint: 'Stops polling and unregisters this repo. Existing GitHub issues/PRs are unaffected.',
  /** Opens the confirmation step: nothing is removed until `confirmRemove` is clicked. */
  removeRepo: (owner: string, repo: string) => `Remove ${owner}/${repo}`,
  confirmRemove: 'Confirm remove',
}

const ko: typeof en = {
  heading: '프로젝트 설정',
  scopedTo: { before: '', after: '에만 적용되는 설정입니다.' },
  autoTrigger: '새 이슈 자동 트리거',
  autoTriggerHint: '켜져 있으면 이 저장소에 새로 열린 이슈가 워크플로 큐에 자동으로 추가됩니다.',
  pollInterval: '폴링 간격 (초)',
  removeTitle: '프로젝트 제거',
  removeHint: '이 저장소의 폴링을 중지하고 등록을 해제합니다. GitHub의 기존 이슈/PR은 영향을 받지 않습니다.',
  removeRepo: (owner, repo) => `${owner}/${repo} 제거`,
  confirmRemove: '제거 확인',
}

export const projectSettings: Record<UiLanguage, typeof en> = { en, ko }
