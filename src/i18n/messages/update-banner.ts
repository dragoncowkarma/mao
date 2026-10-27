import type { UiLanguage } from '../../../core/ui-language'

/**
 * What `src/components/UpdateBanner.tsx` shows. The short SHAs and the `->` between them are not text
 * and stay in the component.
 */
const en = {
  title: 'New version available',
  /**
   * Shown only while workflow stages are in flight (restarting then asks first). Appended straight after
   * the SHAs, so it carries its own leading separator.
   */
  runningTasks: (count: number) => ` - ${count} workflow task(s) running`,
  restart: 'Restart',
  later: 'Later',
}

const ko: typeof en = {
  title: '새 버전을 사용할 수 있습니다',
  runningTasks: (count) => ` - 워크플로 작업 ${count}개 실행 중`,
  restart: '재시작',
  later: '나중에',
}

export const updateBanner: Record<UiLanguage, typeof en> = { en, ko }
