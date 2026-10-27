import type { UiLanguage } from '../../../core/ui-language'

/**
 * What `src/components/KanbanBoard.tsx` shows.
 *
 * Stage names, `Issue #n`/`PR #n`, a GitHub item's state, "urgent", "Prompt", "Retry", the active count
 * and the effort label come from `common`, so the board and the queue cannot word them differently.
 * Everything the board shows from GitHub or the engine — titles, prompts, provider names, model ids,
 * effort levels, error messages — arrives at runtime and is rendered as it comes.
 */
const en = {
  heading: 'Board',
  /** Beside the live dot: when the board last synced. `ago` is one of `timeAgo`'s phrases below. */
  synced: (ago: string) => `synced ${ago}`,
  /** How long ago the last sync was. The board picks the unit and rounds the count; under 5s is `justNow`. */
  timeAgo: {
    justNow: 'just now',
    seconds: (count: number) => `${count}s ago`,
    minutes: (count: number) => `${count}m ago`,
    hours: (count: number) => `${count}h ago`,
  },
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  columns: { issues: 'Issues', pullRequests: 'Pull Requests' },
  noItems: 'No items',
  /** The run button on a paused card, which advances its stage; a failed card's reads `common.retry`. */
  run: 'Run',
  /**
   * The badge naming a card's pipeline state. `stage` is the stage's name from `common.stages`, already
   * in this language.
   */
  workflowBadge: {
    failed: (stage: string) => `${stage} failed`,
    running: (stage: string) => `${stage} running`,
    paused: (stage: string) => `${stage} paused`,
    queued: (stage: string) => `${stage} queued`,
    done: 'workflow done',
  },
  /**
   * Tooltip on a linked issue/PR badge shown as closed: the item is not in the board's open-item snapshot,
   * so the board cannot show its live state.
   */
  noLongerOpen: 'No longer in open items',
}

const ko: typeof en = {
  heading: '보드',
  synced: (ago) => `${ago} 동기화됨`,
  timeAgo: {
    justNow: '방금',
    seconds: (count) => `${count}초 전`,
    minutes: (count) => `${count}분 전`,
    hours: (count) => `${count}시간 전`,
  },
  refresh: '새로고침',
  refreshing: '새로고침 중…',
  columns: { issues: '이슈', pullRequests: '풀 리퀘스트' },
  noItems: '항목 없음',
  run: '실행',
  workflowBadge: {
    failed: (stage) => `${stage} 실패`,
    running: (stage) => `${stage} 실행 중`,
    paused: (stage) => `${stage} 일시 정지`,
    queued: (stage) => `${stage} 대기 중`,
    done: '워크플로 완료',
  },
  noLongerOpen: '더 이상 열린 항목에 없음',
}

export const kanbanBoard: Record<UiLanguage, typeof en> = { en, ko }
