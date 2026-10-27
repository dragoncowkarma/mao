import type { UiLanguage } from '../../../core/ui-language'

/** What `src/App.tsx` shows. */
const en = {
  welcomeTitle: 'Welcome to MAO',
  welcomeHint: 'Add a repository from the sidebar to see its issues and pull requests here.',
  /** The project view's tabs, keyed like App's `ProjectTab`. */
  tabs: { board: 'Board', queue: 'Queue', settings: 'Settings' },
  /** Asked before restarting into an update while workflow stages are still in flight. */
  confirmRestartWithRunningTasks: (count: number) =>
    `${count} workflow task(s) are still running. Restart anyway?`,
  /**
   * Asked when the restart itself was refused. `reason` is the error main reported — core's own wording
   * (e.g. a running-task count that changed since the update check), so it is shown untranslated.
   */
  confirmRestartAfterError: (reason: string) => `${reason}. Restart anyway?`,
  /**
   * Why a stored-queue action did not succeed: the outcomes the renderer words itself, thrown so
   * Sidebar's catch puts them on screen. `'unverified'` is absent on purpose — it carries core's own
   * `reason`, shown as it comes. Safety-critical: each states exactly what was established ("nothing was
   * written", "what reached the config file is unknown", "automation stays halted") and the steps the
   * operator must take, in order. A translation keeps every one of them.
   */
  queueOutcome: {
    /**
     * `'restart-required'` — identical for both actions. "Write the repaired settings" means writing this
     * process's startup snapshot *over* them, as the CLI words it: any write would destroy the repair.
     */
    restartRequired:
      'This MAO process observed a whole-file read failure, so it cannot safely write the repaired ' +
      'settings. Nothing was written; repair the file if needed, then restart MAO.',
    /** "Recover readable tasks" (`confirmQueueRecovery()`), offered while automation is halted. */
    recover: {
      superseded:
        'The stored queue changed while confirming, so nothing was written. Something else is writing ' +
        'the config file — re-check it and try again.',
      writeFailed:
        'The replacement write failed, so what reached the config file is unknown and automation stays ' +
        'halted. MAO recorded a persistence marker; reconcile the stored queue with GitHub, clear ' +
        'that marker through the recovery card, then restart MAO.',
      invalidReplacement:
        'MAO rejected the replacement queue before writing because it contains an invalid task. Nothing ' +
        'was written and automation stays halted. Inspect the retained tasks, then try again.',
      alreadyReadable: 'The stored queue reads normally again — nothing was written. Restart MAO to load it.',
    },
    /** "Save this session’s queue now" (`resaveQueue()`), for a queue broken after a clean start. */
    resave: {
      alreadyReadable: 'The stored queue reads normally again — nothing was written.',
      superseded:
        'The stored queue changed while saving, so nothing was written. Something else is writing the ' +
        'config file — re-check it and try again.',
      writeFailed:
        'The save failed, so what reached the config file is unknown. MAO recorded a persistence ' +
        'marker; reconcile the stored queue with GitHub, clear that marker through the recovery ' +
        'card, then restart MAO.',
      invalidReplacement:
        'MAO rejected this session\'s queue before writing because it contains an invalid task. Nothing ' +
        'was written. Inspect the in-memory queue, then try again.',
    },
  },
}

const ko: typeof en = {
  welcomeTitle: 'MAO에 오신 것을 환영합니다',
  welcomeHint: '사이드바에서 저장소를 추가하면 그 저장소의 이슈와 풀 리퀘스트가 여기에 표시됩니다.',
  tabs: { board: '보드', queue: '큐', settings: '설정' },
  confirmRestartWithRunningTasks: (count) =>
    `워크플로 작업 ${count}개가 아직 실행 중입니다. 그래도 재시작하시겠습니까?`,
  confirmRestartAfterError: (reason) => `${reason}. 그래도 재시작하시겠습니까?`,
  queueOutcome: {
    restartRequired:
      '이 MAO 프로세스가 파일 전체 읽기 실패를 감지했으므로 고쳐진 설정을 안전하게 덮어쓸 수 없습니다. ' +
      '아무것도 기록되지 않았습니다. 필요하면 파일을 고친 다음 MAO를 재시작하십시오.',
    recover: {
      superseded:
        '복구를 확인하는 동안 저장된 큐가 바뀌었으므로 아무것도 기록되지 않았습니다. 다른 곳에서 ' +
        '설정 파일에 쓰고 있으니 파일을 재확인한 뒤 다시 시도하십시오.',
      writeFailed:
        '대체 큐 쓰기에 실패했으므로 설정 파일에 무엇이 기록되었는지 알 수 없으며, 자동화는 계속 중단된 ' +
        '상태입니다. MAO가 영속성 마커를 남겼습니다. 저장된 큐를 GitHub와 대조해 맞추고, 복구 카드에서 ' +
        '그 마커를 지운 다음, MAO를 재시작하십시오.',
      invalidReplacement:
        '대체 큐에 유효하지 않은 작업이 있어 MAO가 기록하기 전에 거부했습니다. 아무것도 기록되지 ' +
        '않았으며 자동화는 계속 중단된 상태입니다. 유지된 작업을 점검한 뒤 다시 시도하십시오.',
      alreadyReadable:
        '저장된 큐를 다시 정상적으로 읽을 수 있습니다. 아무것도 기록되지 않았습니다. 그 큐를 불러오려면 ' +
        'MAO를 재시작하십시오.',
    },
    resave: {
      alreadyReadable: '저장된 큐를 다시 정상적으로 읽을 수 있습니다. 아무것도 기록되지 않았습니다.',
      superseded:
        '저장하는 동안 저장된 큐가 바뀌었으므로 아무것도 기록되지 않았습니다. 다른 곳에서 설정 파일에 ' +
        '쓰고 있으니 파일을 재확인한 뒤 다시 시도하십시오.',
      writeFailed:
        '저장에 실패했으므로 설정 파일에 무엇이 기록되었는지 알 수 없습니다. MAO가 영속성 마커를 ' +
        '남겼습니다. 저장된 큐를 GitHub와 대조해 맞추고, 복구 카드에서 그 마커를 지운 다음, MAO를 ' +
        '재시작하십시오.',
      invalidReplacement:
        '이 세션의 큐에 유효하지 않은 작업이 있어 MAO가 기록하기 전에 거부했습니다. 아무것도 기록되지 ' +
        '않았습니다. 메모리에 있는 큐를 점검한 뒤 다시 시도하십시오.',
    },
  },
}

export const app: Record<UiLanguage, typeof en> = { en, ko }
