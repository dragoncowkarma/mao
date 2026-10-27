import type { UiLanguage } from '../../../core/ui-language'
import type { WorkflowTaskStatus } from '../../../core/workflow-engine'

/**
 * What `src/components/WorkflowQueue.tsx` shows.
 *
 * Stage names, `Issue #n`/`PR #n`, the active count, "Prompt", "Retry" and the effort suffix come from
 * `common`, so the queue and the board cannot word them differently. Everything a card shows from the
 * engine — task titles, provider names, tool kinds, model ids, effort levels, prompts, outputs and error
 * messages — arrives at runtime and is rendered as it comes.
 */
const en = {
  heading: 'Workflow Queue',
  /**
   * Removes every finished task, failed ones included: the engine clears both `done` and `error` tasks,
   * and `count` counts both. "Completed" means finished here, not succeeded.
   */
  clearCompleted: (count: number) => `Clear completed (${count})`,
  newTaskTitle: 'New task title',
  /** The new-task form's checkbox: run every stage unattended, or pause the task after each one. */
  autoAdvance: 'Auto-advance',
  start: 'Start',
  noTasks: 'No workflow tasks yet.',
  /** Tooltip on a card's live dot while its stage is running. */
  currentlyWorking: 'Currently working',
  /** The status tag in each card's header. */
  statusTag: {
    /** A finished task's tag. The stage is left off: the whole pipeline is over. */
    done: 'Done',
    /**
     * Every other task's tag. `stage` is the stage's name from `common.stages` and `status` is one of
     * `statuses` below, both already in this language.
     */
    inStage: (stage: string, status: string) => `${stage} · ${status}`,
  },
  /**
   * The engine's task status as `statusTag.inStage` words it. English shows the raw status word — what
   * the tag has always shown (`PR · error`) — and other languages translate it. Typed against
   * `WorkflowTaskStatus`, so a status added to `WORKFLOW_TASK_STATUSES` without a word here is a `tsc`
   * error. `done` is the one status left out: a done task's tag is `statusTag.done`, with no stage.
   */
  statuses: {
    pending: 'pending',
    running: 'running',
    error: 'error',
    paused: 'paused',
  } satisfies Record<Exclude<WorkflowTaskStatus, 'done'>, string>,
  /** Beside the agent lined up to run a queued task's next stage, before that stage starts. */
  upNext: 'up next',
  /** Beside the agent running the task's current stage. */
  runningNow: 'running now',
  /** Heads a finished step's stored output; its prompt is headed by `common.prompt`. */
  output: 'Output',
  /** Toggles a finished step's stored prompt and output. */
  showPromptOutput: 'Show prompt/output',
  hideDetails: 'Hide details',
  /** A paused task's note. `stage` is the stage's name from `common.stages`, already in this language. */
  waitingForAdvance: (stage: string) => `Waiting for manual advance before starting the ${stage} stage.`,
  /** The paused card's run button, which starts the stage `waitingForAdvance` names. */
  runNextStage: 'Run next stage',
  /** Each unfinished card's checkbox: whether finishing a stage starts the next one or pauses the task. */
  autoAdvanceThroughStages: 'Auto-advance through stages',
}

const ko: typeof en = {
  heading: '워크플로 큐',
  clearCompleted: (count) => `끝난 작업 지우기 (${count})`,
  newTaskTitle: '새 작업 제목',
  autoAdvance: '자동 진행',
  start: '시작',
  noTasks: '아직 워크플로 작업이 없습니다.',
  currentlyWorking: '현재 작업 중',
  statusTag: {
    done: '완료',
    inStage: (stage, status) => `${stage} · ${status}`,
  },
  statuses: {
    pending: '대기 중',
    running: '실행 중',
    error: '실패',
    paused: '일시 정지',
  },
  upNext: '다음 차례',
  runningNow: '지금 실행 중',
  output: '출력',
  showPromptOutput: '프롬프트/출력 보기',
  hideDetails: '세부 정보 숨기기',
  waitingForAdvance: (stage) => `${stage} 단계를 시작하기 전에 수동 진행을 기다리고 있습니다.`,
  runNextStage: '다음 단계 실행',
  autoAdvanceThroughStages: '단계 자동 진행',
}

export const workflowQueue: Record<UiLanguage, typeof en> = { en, ko }
