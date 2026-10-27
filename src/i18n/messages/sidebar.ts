import type { UiLanguage } from '../../../core/ui-language'

/**
 * What `src/components/Sidebar.tsx` shows.
 *
 * Every `source` parameter is the config file's path as core reports it, interpolated as it comes. The
 * store reports and halt reasons the sidebar prints beside these sentences are core's own text and are
 * not here (see `src/i18n/index.ts`).
 *
 * Most of the queue and marker text is a safety instruction the operator acts on: a translation keeps
 * every condition, consequence and ordering ("only after", "before", "permanently deletes", "restart").
 */
const en = {
  /** The product name: the same in every language, listed so this catalog holds all of the sidebar's text. */
  brand: 'MAO',
  projects: 'Projects',
  /** The tag beside a project whose auto-trigger polling is turned off. */
  autoTriggerOff: 'off',
  noProjects: 'No projects yet — add a repository to get started.',
  globalSettings: 'Global settings',
  addRepo: {
    /** Opens and closes the add form. */
    toggle: '+ Add',
    ownerPlaceholder: 'owner',
    repoPlaceholder: 'repo',
    submit: 'Add',
    /** While the main process preflights write access — nothing is stored until it passes. */
    checking: 'Checking access…',
    /**
     * After an add whose preflight could not prove every pipeline grant. A passing preflight is not proof
     * of write access, so this caveat must not be softened. `repos` is the comma-separated `owner/repo`
     * list; Issues, Contents and Pull requests are GitHub's own permission names.
     */
    addedUnverified: (repos: string) =>
      `Added, but write access is unverified for ${repos}: GitHub cannot confirm this credential's ` +
      'Issues, Contents and Pull requests grants without a write, so a workflow stage can still fail ' +
      'with a permission error.',
  },
  /** The queue card. Which paragraph shows is decided by the queue state, never by parsing a report. */
  queue: {
    haltedTitle: 'Workflow automation is halted',
    /** A problem found after a clean start, which does not halt the session. */
    unreadableTitle: 'The stored workflow queue is unreadable',
    /**
     * Halted after this process saw the whole file fail to load. Only a restart is safe, so no write is
     * offered. While the file is still unloadable, core's report is printed in front of it.
     */
    restartOnly:
      'This process observed a whole-file read failure, so workflow automation remains halted even if ' +
      'the file is readable now. Its startup snapshot cannot safely write over a repair. Repair the file ' +
      'if needed, then restart MAO to load the complete stored state.',
    restartFollowUp:
      'If a workflow was already running, verify its queue and GitHub state after restart. If MAO ' +
      'reports an unresolved persistence outcome, use the marker recovery shown here only after that ' +
      'check.',
    /** Found after a clean start, in a file that did not load at all: every write is refused. */
    lateWholeFile: (source: string) =>
      `MAO could not read ${source} at all, so it established neither the stored workflow queue nor ` +
      'any other setting. Repository polling and new queue mutations are paused, every write is ' +
      'refused, and any running workflow will stop when it next tries to persist. The file still ' +
      'holds everything it held. Repair the file, then restart MAO.',
    /**
     * Found after a clean start, as a wrong-shaped field in a file that loaded: this session's next queue
     * write heals it. It must not claim a halt, an empty queue or refused writes — none of them holds here.
     */
    lateFieldOnly: (source: string) =>
      `MAO cannot read the stored workflow queue in ${source}. This session is not halted — it is ` +
      'still holding the queue it loaded at startup, and its next queue write will rewrite the file ' +
      'from that. Restarting before that happens will refuse to start unattended work until the value ' +
      'is replaced.',
    saving: 'Saving…',
    saveSessionQueue: 'Save this session’s queue now',
    recoverReadableTasks: 'Recover readable tasks',
    /** Recovery's confirmation step: the deletion is permanent, and retained tasks may run afterwards. */
    recoveryConsequences:
      'Recovery permanently deletes invalid queue entries and retains every readable task. Tasks ' +
      'stored as running are restored as pending. After automation is released, later queue activity ' +
      '— including an auto-trigger poll that enqueues work — may execute those retained tasks.',
    recoveryCheckFirst:
      'Before continuing, check the target repositories for workflow-active issues and half-finished ' +
      'branches or pull requests so recovery does not repeat GitHub work.',
    recovering: 'Recovering…',
    confirmRecovery: 'Confirm recovery',
    /** Halted, but something outside this window already repaired the file: restart, never recover. */
    repairedElsewhere:
      'The stored queue reads normally again. Restart MAO to load it — this session is still halted ' +
      'because its in-memory queue may be incomplete.',
  },
  /**
   * The persistence-broken marker: a queue write's outcome is unknown, so nothing may run until the
   * operator has compared the stored queue with GitHub. Clearing it never releases this process.
   */
  marker: {
    /** Each of these two is followed by `storedDataIndependent`; the component puts a space between. */
    alsoUnreadableFile: (source: string) =>
      `MAO also cannot read ${source} at all, so every stored setting is affected.`,
    alsoUnusableQueue: (source: string) => `MAO also cannot use the stored workflow queue in ${source}.`,
    storedDataIndependent:
      'This is independent of the persistence marker. Repair and inspect the stored data as part of ' +
      'reconciliation before clearing the marker; queue recovery writes remain unavailable while the ' +
      'durable result is uncertain.',
    unavailable:
      'Queue recovery and live-session Save are unavailable while the durable result is uncertain. ' +
      'Check the stored queue and target repositories before clearing the marker.',
    clearAfterVerification: 'Clear marker after verification',
    /**
     * The gate before `confirmClear`. Korean names that button ("마커 지우기 확인") because its verb for
     * "confirm" also means "check" — keep the quoted label in step with `confirmClear`.
     */
    clearConfirmation:
      'Confirm only after comparing the stored queue with the target repositories and resolving any ' +
      'half-finished issue, branch or pull request. Wait for any active stage in this process to stop. ' +
      'Clearing the marker does not change this running process; restart is required before ' +
      'automation can resume.',
    clearing: 'Clearing…',
    confirmClear: 'Confirm marker clear',
    cleared: 'The marker is cleared. This process remains halted; restart MAO to load the verified queue.',
  },
  /** The card reporting a finished queue action — kept apart from the queue card so it outlives it. */
  queueResult: {
    title: 'Workflow queue',
    dismiss: 'Dismiss',
  },
  storedProblems: {
    title: 'Stored settings could not be read',
    /** Writes an empty `githubRepos` and nothing else, so it is offered only under that field's report. */
    resetList: 'Reset stored list',
    confirmReset: 'Confirm reset',
    resetting: 'Resetting…',
  },
}

const ko: typeof en = {
  brand: 'MAO',
  projects: '프로젝트',
  autoTriggerOff: '꺼짐',
  noProjects: '아직 프로젝트가 없습니다. 시작하려면 저장소를 추가하십시오.',
  globalSettings: '전역 설정',
  addRepo: {
    toggle: '+ 추가',
    ownerPlaceholder: '소유자',
    repoPlaceholder: '저장소',
    submit: '추가',
    checking: '접근 권한 확인 중…',
    addedUnverified: (repos) =>
      `추가했지만 ${repos}의 쓰기 권한은 확인되지 않았습니다. GitHub는 실제로 쓰기 전에는 ` +
      '이 자격 증명의 Issues, Contents, Pull requests 권한을 확인할 수 없으므로, 워크플로 단계가 ' +
      '여전히 권한 오류로 실패할 수 있습니다.',
  },
  queue: {
    haltedTitle: '워크플로 자동화가 중단되었습니다',
    unreadableTitle: '저장된 워크플로 큐를 읽을 수 없습니다',
    restartOnly:
      '이 프로세스가 파일 전체 읽기 실패를 감지했으므로, 지금은 파일을 읽을 수 있더라도 워크플로 ' +
      '자동화는 중단된 상태로 유지됩니다. 시작할 때 읽은 스냅숏으로는 고쳐진 내용을 안전하게 덮어쓸 수 ' +
      '없습니다. 필요하면 파일을 고친 다음 MAO를 재시작하여 저장된 전체 상태를 불러오십시오.',
    restartFollowUp:
      '워크플로가 이미 실행 중이었다면 재시작 후 그 큐와 GitHub 상태를 검증하십시오. MAO가 해결되지 ' +
      '않은 저장 결과를 보고하면, 그 검증을 마친 뒤에만 여기에 표시되는 마커 복구를 사용하십시오.',
    lateWholeFile: (source) =>
      `MAO가 ${source} 파일을 전혀 읽지 못했으므로 저장된 워크플로 큐도, 다른 어떤 설정도 ` +
      '불러오지 못했습니다. 저장소 폴링과 새 큐 변경은 일시 정지되었고, 모든 쓰기는 거부되며, 실행 ' +
      '중인 워크플로는 다음에 저장을 시도할 때 멈춥니다. 파일에는 원래 있던 내용이 모두 그대로 남아 ' +
      '있습니다. 파일을 고친 다음 MAO를 재시작하십시오.',
    lateFieldOnly: (source) =>
      `MAO가 ${source}에 저장된 워크플로 큐를 읽을 수 없습니다. 이 세션은 중단되지 않았습니다. ` +
      '시작할 때 불러온 큐를 여전히 가지고 있으며, 다음 큐 쓰기 때 그 큐로 파일을 다시 씁니다. 그 ' +
      '전에 재시작하면 값이 교체될 때까지 무인 작업 시작이 거부됩니다.',
    saving: '저장 중…',
    saveSessionQueue: '이 세션의 큐를 지금 저장',
    recoverReadableTasks: '읽을 수 있는 작업 복구',
    recoveryConsequences:
      '복구하면 유효하지 않은 큐 항목은 영구적으로 삭제되고, 읽을 수 있는 작업은 모두 유지됩니다. ' +
      '실행 중으로 저장된 작업은 대기 중으로 복원됩니다. 자동화 중단이 해제된 뒤에는 이후의 큐 ' +
      '활동(작업을 큐에 넣는 자동 트리거 폴링 포함)이 유지된 작업을 실행할 수 있습니다.',
    recoveryCheckFirst:
      '계속하기 전에, 복구가 GitHub 작업을 반복하지 않도록 대상 저장소에서 workflow-active 이슈와 ' +
      '도중에 멈춘 브랜치 또는 풀 리퀘스트를 확인하십시오.',
    recovering: '복구 중…',
    confirmRecovery: '복구 확인',
    repairedElsewhere:
      '저장된 큐를 다시 정상적으로 읽을 수 있습니다. 이를 불러오려면 MAO를 재시작하십시오. 이 세션은 ' +
      '메모리에 있는 큐가 불완전할 수 있으므로 여전히 중단된 상태입니다.',
  },
  marker: {
    alsoUnreadableFile: (source) =>
      `MAO는 또한 ${source} 파일을 전혀 읽을 수 없으므로 저장된 모든 설정이 영향을 받습니다.`,
    alsoUnusableQueue: (source) => `MAO는 또한 ${source}에 저장된 워크플로 큐를 사용할 수 없습니다.`,
    storedDataIndependent:
      '이 문제는 영속성 마커와 별개입니다. 마커를 지우기 전에, 저장된 큐를 GitHub와 대조해 맞추는 과정에서 ' +
      '저장된 데이터도 함께 고치고 점검하십시오. 저장 결과가 불확실한 동안에는 큐 복구 쓰기를 계속 사용할 ' +
      '수 없습니다.',
    unavailable:
      '저장 결과가 불확실한 동안에는 큐 복구와 현재 세션 저장을 사용할 수 없습니다. 마커를 지우기 ' +
      '전에 저장된 큐와 대상 저장소를 확인하십시오.',
    clearAfterVerification: '검증 후 마커 지우기',
    clearConfirmation:
      '저장된 큐를 대상 저장소와 비교하고 도중에 멈춘 이슈, 브랜치 또는 풀 리퀘스트를 모두 해결한 ' +
      '뒤에만 "마커 지우기 확인"을 누르십시오. 이 프로세스에서 진행 중인 단계가 있으면 멈출 때까지 ' +
      '기다리십시오. 마커를 지워도 실행 중인 이 프로세스는 달라지지 않으며, 자동화를 재개하려면 먼저 ' +
      '재시작해야 합니다.',
    clearing: '지우는 중…',
    confirmClear: '마커 지우기 확인',
    cleared: '마커를 지웠습니다. 이 프로세스는 계속 중단된 상태이므로, 검증한 큐를 불러오려면 MAO를 재시작하십시오.',
  },
  queueResult: {
    title: '워크플로 큐',
    dismiss: '닫기',
  },
  storedProblems: {
    title: '저장된 설정을 읽지 못했습니다',
    resetList: '저장된 목록 초기화',
    confirmReset: '초기화 확인',
    resetting: '초기화 중…',
  },
}

export const sidebar: Record<UiLanguage, typeof en> = { en, ko }
