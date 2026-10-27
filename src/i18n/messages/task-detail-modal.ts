import type { UiLanguage } from '../../../core/ui-language'

/**
 * What `src/components/TaskDetailModal.tsx` shows.
 *
 * A GitHub item's state, "urgent" and `PR #n` come from `common`, so the modal words them as the board
 * does. Everything fetched from GitHub — title, body, labels, author, comments — and the errors a fetch
 * or an enqueue reports arrive at runtime and are rendered as they come.
 */
const en = {
  /** Above the title: which kind of GitHub item this is. The component appends ` #number`. */
  kicker: { issue: 'Issue', pullRequest: 'Pull Request' },
  /** The close button's text, and its accessible name. */
  close: 'Close',
  /**
   * The linked-item row: for a PR, the issues its closing keywords (`Closes #N`) name; for an issue, the
   * open PRs that name it. Each badge is followed by that item's state (`common.githubState`).
   */
  linked: {
    closesHeading: 'Closes:',
    prsHeading: 'Linked PRs:',
    closesIssue: (number: number) => `Closes Issue #${number}`,
    /** Tooltip on a badge for an item missing from the board's open-item snapshot: it links out to GitHub. */
    noLongerOpen: 'No longer in open items — view on GitHub',
  },
  loading: 'Loading…',
  /**
   * `author` is the GitHub login, shown as it comes. `date` is the item's last update (not when it was
   * opened), already formatted for this language.
   */
  openedBy: (author: string, date: string) => `Opened by ${author} · ${date}`,
  noDescription: 'No description provided.',
  commentCount: (count: number) => (count === 1 ? '1 comment' : `${count} comments`),
  /**
   * Labels the checkbox above "Add to workflow". Checked, the issue runs every remaining stage — merge
   * included — with no operator step in between, so a translation must keep "unattended". The stages are
   * written out because English names them by their lowercase ids rather than by `common.stages`; other
   * languages use the names `common.stages` gives them.
   */
  autoAdvance: 'Auto-advance through pr → review → merge unattended',
  addToWorkflow: 'Add to workflow',
  adding: 'Adding…',
  /** The ↗ after it stays in the component. */
  viewOnGithub: 'View on GitHub',
  /** The enqueue error when a newly queued task failed its first stage without the engine recording why. */
  failedToStart: 'Task failed to start',
}

const ko: typeof en = {
  kicker: { issue: '이슈', pullRequest: '풀 리퀘스트' },
  close: '닫기',
  linked: {
    closesHeading: '닫을 이슈:',
    prsHeading: '연결된 PR:',
    closesIssue: (number) => `닫을 이슈 #${number}`,
    noLongerOpen: '더 이상 열린 항목에 없음 — GitHub에서 보기',
  },
  loading: '불러오는 중…',
  openedBy: (author, date) => `작성자 ${author} · ${date}`,
  noDescription: '설명이 없습니다.',
  commentCount: (count) => `댓글 ${count}개`,
  autoAdvance: 'PR → 리뷰 → 머지 단계를 무인으로 자동 진행',
  addToWorkflow: '워크플로에 추가',
  adding: '추가 중…',
  viewOnGithub: 'GitHub에서 보기',
  failedToStart: '작업을 시작하지 못했습니다',
}

export const taskDetailModal: Record<UiLanguage, typeof en> = { en, ko }
