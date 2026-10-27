import { StrictMode } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import { createElectronApiStub } from '../test/electron-api-stub'
import { KOREAN_CATALOG_LATIN, latinWords } from '../test/korean-latin'
import { LANGUAGE_NAMES, MESSAGES } from '.'
import { PROVIDER_OPTIONS } from '../../core/ai/provider-options'
import type { AiProviderConfig } from '../../core/ai/types'
import type { GithubTask, GithubTaskDetail } from '../../core/github-service'
import type { QueuedTask, RepoRef } from '../../core/workflow-engine'

/**
 * The Korean UI, rendered whole, shows no English of its own.
 *
 * `no-hardcoded-text.test.ts` reads source, so it cannot see text a helper returns, a record holds or a
 * setter receives — the shapes a fifth of this change's strings came in. This reads the other end: it
 * mounts App in Korean across the views an operator reaches, collects every visible word and every
 * display attribute, and fails on any Latin-script word that is not data, a product or tool name, or
 * Latin the Korean catalog keeps on purpose (`KOREAN_CATALOG_LATIN`: `PR`, `API (BYOK)`, …).
 *
 * The fixtures use deliberately odd words — `Quokka`, `zorkmid`, `Kestrel` — so that a fixture can never
 * excuse a leaked UI word that happens to be spelled the same, and enum values (`open`, `error`,
 * `review`) are never in the allowed set: those are exactly what must be translated before display.
 */

const repo: RepoRef = { owner: 'zork', repo: 'grue' }

const providers: AiProviderConfig[] = [
  { id: 'p1', name: 'Claude', kind: 'cli', command: 'claude', providerKindId: 'claude', model: 'opus', effort: 'high' },
  { id: 'p2', name: 'Codex', kind: 'cli', command: 'codex', providerKindId: 'codex', model: 'gpt-4o', effort: 'medium' },
]

const now = Date.now()
const githubTask = (number: number, title: string, extra: Partial<GithubTask> = {}): GithubTask => ({
  id: number,
  number,
  title,
  type: 'issue',
  state: 'open',
  url: `https://github.com/zork/grue/issues/${number}`,
  updatedAt: new Date(now - number * 60_000).toISOString(),
  urgent: false,
  labels: [],
  body: '',
  ...extra,
})

const tasks: GithubTask[] = [
  githubTask(12, 'Quokka migration', { urgent: true, labels: ['quokka-label'] }),
  githubTask(14, 'Wombat cleanup'),
  githubTask(15, 'Bandicoot idea'),
  githubTask(13, 'Numbat refactor', { type: 'pull_request', linkedIssueNumbers: [12, 11] }),
]

const step = (stage: QueuedTask['stage'], id: 'p1' | 'p2') => ({
  stage,
  agentId: id,
  agentName: id === 'p1' ? 'Claude' : 'Codex',
  providerKindId: id === 'p1' ? ('claude' as const) : ('codex' as const),
  model: id === 'p1' ? 'opus' : 'gpt-4o',
  effort: id === 'p1' ? ('high' as const) : ('medium' as const),
  prompt: 'Lorem prompt',
  output: 'Ipsum output',
})

/** One task in every status the queue and the board word differently. */
const queue: QueuedTask[] = [
  { id: 't1', title: 'Quokka migration', repo, stage: 'review', status: 'paused', autoAdvance: false, github: { issueNumber: 12, prNumber: 13 }, history: [step('pr', 'p1')] },
  { id: 't2', title: 'Wombat cleanup', repo, stage: 'pr', status: 'error', error: '[core] Kestrel refused the run', autoAdvance: true, github: { issueNumber: 14 }, history: [] },
  { id: 't3', title: 'Dingo task', repo, stage: 'merge', status: 'done', autoAdvance: true, github: { issueNumber: 9, prNumber: 10 }, history: [step('pr', 'p1'), step('review', 'p2'), step('merge', 'p1')] },
  { id: 't4', title: 'Bilby task', repo, stage: 'pr', status: 'running', autoAdvance: true, github: { issueNumber: 8 }, history: [], active: step('pr', 'p2') },
  { id: 't5', title: 'Potoroo task', repo, stage: 'issue', status: 'pending', autoAdvance: true, github: {}, history: [] },
]

const detail = (number: number): GithubTaskDetail => ({
  ...(tasks.find((task) => task.number === number) ?? githubTask(number, 'Bandicoot idea')),
  body: 'Frotz body text',
  author: 'zorkmid',
  comments: [{ id: 1, author: 'grueling', body: 'Xyzzy comment', createdAt: new Date(now).toISOString(), url: 'https://github.com/zork/grue/issues/15#1' }],
})

/** Free text the fixtures put on screen, and nothing an enum supplies. */
const DATA = [
  repo.owner,
  repo.repo,
  ...tasks.flatMap((task) => [task.title, ...task.labels]),
  ...queue.flatMap((task) => [task.title, task.error ?? '']),
  'Lorem prompt',
  'Ipsum output',
  'Frotz body text',
  'zorkmid',
  'grueling',
  'Xyzzy comment',
  ...providers.flatMap((provider) => [provider.name, provider.command ?? '', provider.model ?? '', provider.effort ?? '']),
  ...providers.map((provider) => provider.providerKindId ?? ''),
  'a1b2c3d',
  'f6e5d4c',
]

const ALLOWED = new Set<string>([
  ...DATA.flatMap(latinWords),
  // Latin the Korean catalog keeps on purpose — the explicit list, not whatever the catalog happens to
  // hold, or an English value left in it would excuse itself.
  ...KOREAN_CATALOG_LATIN,
  // Each language names itself.
  ...Object.values(LANGUAGE_NAMES).flatMap(latinWords),
  // Model and effort names come from core's catalog and are shown as they are.
  ...Object.values(PROVIDER_OPTIONS).flatMap((options) =>
    [...options.models, ...options.efforts].flatMap((option) => latinWords(`${option.value} ${option.label}`)),
  ),
])

/** The Latin words on screen right now that nothing above excuses. */
function strayEnglish(): string[] {
  // Text node by text node: `textContent` glues neighbours together with no separator, so two options
  // (`Low`, `Medium`) or a title and a date would read as one word nobody wrote.
  const texts: string[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node.textContent ?? '')
  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      const value = element.getAttribute(attribute)
      if (value) texts.push(value)
    }
  }
  return [...new Set(texts.flatMap(latinWords).filter((word) => !ALLOWED.has(word)))]
}

describe('the Korean UI', () => {
  it('shows no English of its own anywhere an operator can reach', async () => {
    const stub = createElectronApiStub([repo])
    stub.getLanguage.mockResolvedValue('ko')
    stub.fetchTasks.mockResolvedValue(tasks)
    stub.listWorkflowTasks.mockResolvedValue(queue)
    stub.listProviders.mockResolvedValue(providers)
    stub.checkUpdate.mockResolvedValue({
      currentSha: 'a1b2c3d4e5f6',
      latestSha: 'f6e5d4c3b2a1',
      updateAvailable: true,
      runningTaskCount: 1,
    })
    stub.api.github.fetchTaskDetail = vi.fn(async (_owner: string, _repo: string, number: number) => detail(number)) as never
    const user = userEvent.setup()
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
    const ko = MESSAGES.ko
    const stray: Record<string, string[]> = {}
    const sweep = (view: string) => {
      const words = strayEnglish()
      if (words.length > 0) stray[view] = words
    }

    // The board, with a card in every workflow state, the update banner and the sidebar's menu.
    await screen.findByRole('heading', { name: ko.kanbanBoard.heading })
    await screen.findByText('Numbat refactor')
    await screen.findByText(ko.updateBanner.title)
    sweep('board')

    // An issue that is not queued yet, so the modal offers to add it.
    await user.click(screen.getByText('Bandicoot idea'))
    await screen.findByRole('button', { name: ko.taskDetailModal.addToWorkflow })
    await screen.findByText('Frotz body text')
    sweep('issue modal')
    await user.click(screen.getByRole('button', { name: ko.taskDetailModal.close }))

    await user.click(screen.getByRole('button', { name: ko.app.tabs.queue }))
    await screen.findByRole('heading', { name: ko.workflowQueue.heading })
    await screen.findByText('Bilby task')
    // Expand a finished stage, so its prompt/output labels are on screen too.
    await user.click(within(screen.getByText('Dingo task').closest('.card') as HTMLElement).getAllByRole('button', {
      name: ko.workflowQueue.showPromptOutput,
    })[0])
    sweep('queue')

    await user.click(screen.getByRole('button', { name: ko.app.tabs.settings }))
    await screen.findByRole('heading', { name: ko.projectSettings.heading })
    await user.click(screen.getByRole('button', { name: ko.projectSettings.removeRepo(repo.owner, repo.repo) }))
    sweep('project settings')

    await user.click(screen.getByRole('button', { name: ko.sidebar.addRepo.toggle }))
    sweep('add form')

    await user.click(screen.getByRole('button', { name: ko.sidebar.globalSettings }))
    await screen.findByRole('heading', { name: ko.globalSettings.heading })
    await user.click(screen.getAllByRole('button', { name: new RegExp(ko.globalSettings.presets) })[0])
    // A provider with no name and no key, saved: the validation errors are part of the pane too.
    await user.click(screen.getByRole('button', { name: ko.globalSettings.addProvider }))
    await user.click(screen.getByRole('button', { name: ko.globalSettings.saveChanges }))
    await screen.findByText(new RegExp(ko.globalSettings.validation.nameRequired))
    sweep('global settings')

    expect(stray).toEqual({})
  })
})
