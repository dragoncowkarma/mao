import type { UiLanguage } from '../../../core/ui-language'

/**
 * What `src/components/AgentRunControls.tsx` shows.
 *
 * The action button's own text is not here: it arrives as the `actionLabel` prop, already in this
 * language. Neither are the pickers' options — tool names come from core's `providerToolLabel()`, and
 * model and effort names from `PROVIDER_OPTIONS` or are the values in play themselves — which are shown
 * as they come.
 */
const en = {
  /**
   * The three pickers' tooltips, which are also their accessible names (no visible label sits beside
   * them). "This run" carries the meaning: a pick is a one-shot override for the next stage execution
   * only, never a change to the saved provider config — a translation keeps that.
   */
  toolForRun: 'AI tool for this run',
  modelForRun: 'Model for this run',
  effortForRun: 'Reasoning effort for this run',
  /** The model and effort pickers' empty choice. */
  modelPlaceholder: '— model —',
  effortPlaceholder: '— effort —',
  /** Replaces `actionLabel` on the button while the call is in flight. */
  running: 'Running…',
}

const ko: typeof en = {
  toolForRun: '이번 실행에 사용할 AI 도구',
  modelForRun: '이번 실행에 사용할 모델',
  effortForRun: '이번 실행에 사용할 추론 강도',
  modelPlaceholder: '— 모델 —',
  effortPlaceholder: '— 추론 강도 —',
  running: '실행 중…',
}

export const agentRunControls: Record<UiLanguage, typeof en> = { en, ko }
