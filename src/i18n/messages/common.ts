import type { AgentStage } from '../../../core/ai/types'
import type { UiLanguage } from '../../../core/ui-language'

/**
 * Words more than one component shows. Kept in one place so the board, the queue and the issue
 * modal cannot call the same thing by two names in the same language.
 */
const en = {
  /**
   * Pipeline stage names — the one copy the board, the queue and Global settings all read. Typed
   * against `AgentStage`, so a stage added to `AGENT_STAGES` without a name here is a `tsc` error, and
   * every other language has to follow because it is typed against this object.
   */
  stages: { issue: 'Issue', pr: 'PR', review: 'Review', merge: 'Merge' } satisfies Record<AgentStage, string>,
  cancel: 'Cancel',
  prompt: 'Prompt',
  retry: 'Retry',
  urgent: 'urgent',
  /** `effort` is a raw level such as `high` — a CLI parameter value, so it is shown untranslated. */
  effortLevel: (effort: string) => `${effort} effort`,
  issueRef: (number: number) => `Issue #${number}`,
  prRef: (number: number) => `PR #${number}`,
  activeCount: (count: number) => `${count} active`,
  /** A GitHub item's state as the API reports it (`open`/`closed`); anything else is shown verbatim. */
  githubState: (state: string) => state,
}

const ko: typeof en = {
  stages: { issue: '이슈', pr: 'PR', review: '리뷰', merge: '머지' },
  cancel: '취소',
  prompt: '프롬프트',
  retry: '재시도',
  urgent: '긴급',
  effortLevel: (effort) => `추론 강도 ${effort}`,
  issueRef: (number) => `이슈 #${number}`,
  prRef: (number) => `PR #${number}`,
  activeCount: (count) => `${count}개 진행 중`,
  githubState: (state) => (state === 'open' ? '열림' : state === 'closed' ? '닫힘' : state),
}

export const common: Record<UiLanguage, typeof en> = { en, ko }
