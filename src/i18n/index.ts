import { resolveUiLanguage, tagLanguage, type UiLanguage } from '../../core/ui-language'
import { agentRunControls } from './messages/agent-run-controls'
import { app } from './messages/app'
import { common } from './messages/common'
import { globalSettings } from './messages/global-settings'
import { kanbanBoard } from './messages/kanban-board'
import { language } from './messages/language'
import { projectSettings } from './messages/project-settings'
import { sidebar } from './messages/sidebar'
import { taskDetailModal } from './messages/task-detail-modal'
import { updateBanner } from './messages/update-banner'
import { workflowQueue } from './messages/workflow-queue'

/**
 * Everything the renderer shows, in one language.
 *
 * One module per component under `messages/`, each typing its translations against its own English
 * catalog (`const ko: typeof en`), so a key missing from any language — or a message function whose
 * parameters drifted — is a `tsc` error rather than an `undefined` on screen. Components receive the
 * result as their `messages` prop: props-down like every other value in `src/` (AGENTS.md — no
 * context), which is also what lets a test mount a component in a chosen language by passing it.
 *
 * Text that *core* writes — store reports, preflight refusals, queue-recovery reasons, task errors —
 * arrives already worded and is shown as it comes. It is shared with the CLI and bound by core's
 * value-free reporting rules, so it is not translated here.
 */
function catalog(locale: UiLanguage) {
  return {
    /** The language this catalog is written in — for `<html lang>`. */
    locale,
    /**
     * What every `toLocaleString()` formats dates with. Just the language here; `messagesFor()` puts the
     * OS's own regional tags for that language in front of it. A component handed `MESSAGES.en` directly
     * — as a test does — formats with the bare language.
     */
    dateLocales: [locale] as readonly string[],
    common: common[locale],
    language: language[locale],
    app: app[locale],
    sidebar: sidebar[locale],
    globalSettings: globalSettings[locale],
    kanbanBoard: kanbanBoard[locale],
    workflowQueue: workflowQueue[locale],
    taskDetailModal: taskDetailModal[locale],
    agentRunControls: agentRunControls[locale],
    projectSettings: projectSettings[locale],
    updateBanner: updateBanner[locale],
  }
}

export type Messages = ReturnType<typeof catalog>

export const MESSAGES: Record<UiLanguage, Messages> = {
  en: catalog('en'),
  ko: catalog('ko'),
}

/**
 * Each language's name for itself, identical in every UI language. A picker that translated these
 * would strand an operator who switched to a language they cannot read: the way back would be
 * written in it too.
 */
export const LANGUAGE_NAMES: Record<UiLanguage, string> = {
  en: 'English',
  ko: '한국어',
}

/** The OS's preferred languages, most preferred first — what `'system'` resolves against. */
export function systemLanguages(): readonly string[] {
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

/** The language a stored preference renders in on this machine. */
export function uiLanguageFor(preference: unknown): UiLanguage {
  return resolveUiLanguage(preference, systemLanguages())
}

/** Whether `Intl` accepts a tag; an OS can report one it does not (`ko_KR`), and formatting would throw. */
function isFormattingTag(tag: string): boolean {
  try {
    Intl.getCanonicalLocales(tag)
    return true
  } catch {
    return false
  }
}

/**
 * The catalog for a language, with dates formatted the way the OS formats them in that language.
 *
 * An argument-less `toLocaleString()` used to follow the OS, so an English UI on a UK machine showed
 * day-first dates; formatting with a bare `'en'` would quietly switch that operator to US month-first
 * order, where `3/4` reads as the wrong day. So the OS's own tags for the rendered language go first
 * and the language itself last: a UK machine keeps `en-GB` dates, while a Korean UI on an English OS —
 * which has no Korean tag to offer — still formats them the Korean way.
 */
export function messagesFor(language: UiLanguage, preferred: readonly string[] = systemLanguages()): Messages {
  const regional = preferred.filter((tag) => tagLanguage(tag) === language && isFormattingTag(tag))
  return regional.length === 0 ? MESSAGES[language] : { ...MESSAGES[language], dateLocales: [...regional, language] }
}

/**
 * Text a component keeps in state and words when it renders, so switching the language re-words it.
 *
 * A plain string is text that arrived already worded — from core, GitHub or an IPC rejection — and is
 * shown as it came. Text MAO words itself is a `word` function over the catalog instead: kept as a
 * finished string, a message on screen would stay in the language of the click after everything
 * around it had switched. An object rather than a bare function on purpose: React treats a function
 * handed to a state setter as an updater, and would call it.
 */
export type Wording = string | { readonly word: (messages: Messages) => string }

/** What a `Wording` reads as in the current catalog. */
export function wordIn(wording: Wording, messages: Messages): string {
  return typeof wording === 'string' ? wording : wording.word(messages)
}

/**
 * An error MAO worded itself, which can still word itself in another language. `message` holds the
 * wording current when it was thrown, so anything that only reads `message` keeps working.
 */
export class WordedError extends Error {
  readonly wording: Wording

  constructor(word: (messages: Messages) => string, messages: Messages) {
    super(word(messages))
    this.wording = { word }
  }
}
