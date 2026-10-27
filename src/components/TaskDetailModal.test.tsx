import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import TaskDetailModal from './TaskDetailModal'
import { createElectronApiStub } from '../test/electron-api-stub'
import { MESSAGES } from '../i18n'
import type { GithubTaskDetail } from '../../core/github-service'
import type { QueuedTask } from '../../core/workflow-engine'

const updatedAt = '2026-03-04T05:06:07Z'

/** An issue with GitHub's own text in every field the modal shows, so the test can tell whose words are whose. */
const detail: GithubTaskDetail = {
  id: 1,
  number: 12,
  title: 'Add a language menu',
  type: 'issue',
  state: 'open',
  url: 'https://github.com/acme/one/issues/12',
  updatedAt,
  urgent: true,
  labels: ['enhancement'],
  body: '',
  author: 'octocat',
  comments: [
    { id: 1, author: 'hubot', body: 'Looks good.', createdAt: updatedAt, url: 'https://github.com/acme/one/issues/12#1' },
    { id: 2, author: 'octocat', body: 'Thanks!', createdAt: updatedAt, url: 'https://github.com/acme/one/issues/12#2' },
  ],
}

function renderModal(language: 'en' | 'ko') {
  const stub = createElectronApiStub()
  stub.api.github.fetchTaskDetail = vi.fn(async () => detail) as never
  render(
    <TaskDetailModal
      messages={MESSAGES[language]}
      repo={{ owner: 'acme', repo: 'one' }}
      number={12}
      type="issue"
      alreadyQueued={false}
      onEnqueued={() => {}}
      onClose={() => {}}
    />,
  )
}

describe('TaskDetailModal language', () => {
  // Both languages, so neither can be a hardcoded copy of the other — and English is pinned too, which no
  // other test reached: the board's stub never answers `fetchTaskDetail`.
  it.each(['en', 'ko'] as const)('words its own text in %s and shows GitHub’s as it came', async (language) => {
    const messages = MESSAGES[language]
    renderModal(language)

    // The date is part of the same line, formatted for the language rather than for the machine.
    expect(
      await screen.findByText(messages.taskDetailModal.openedBy('octocat', new Date(updatedAt).toLocaleString(language))),
    ).toBeInTheDocument()
    expect(screen.getByText(`${messages.taskDetailModal.kicker.issue} #12`)).toBeInTheDocument()
    expect(screen.getByText(messages.taskDetailModal.noDescription)).toBeInTheDocument()
    expect(screen.getByText(messages.taskDetailModal.commentCount(2))).toBeInTheDocument()
    expect(screen.getByText(messages.common.urgent)).toBeInTheDocument()
    expect(screen.getByText(messages.common.githubState('open'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: messages.taskDetailModal.close })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: messages.taskDetailModal.addToWorkflow })).toBeInTheDocument()
    expect(screen.getByLabelText(messages.taskDetailModal.autoAdvance)).toBeChecked()
    expect(screen.getByRole('link', { name: `${messages.taskDetailModal.viewOnGithub} ↗` })).toBeInTheDocument()

    // Each comment's timestamp follows the language too.
    expect(screen.getByText(`hubot · ${new Date(updatedAt).toLocaleString(language)}`)).toBeInTheDocument()

    // GitHub's own words are never translated.
    expect(screen.getByRole('heading', { name: 'Add a language menu' })).toBeInTheDocument()
    expect(screen.getByText('enhancement')).toBeInTheDocument()
    expect(screen.getByText('Looks good.')).toBeInTheDocument()
  })
})

describe('TaskDetailModal enqueue failure', () => {
  it('re-words its own fallback when the language changes, while the engine’s error stays as it came', async () => {
    const stub = createElectronApiStub()
    stub.api.github.fetchTaskDetail = vi.fn(async () => detail) as never
    stub.api.workflow.enqueueFromIssue = vi.fn(async () => ({ id: 'task-1' }) as QueuedTask) as never
    // Failed at once, with no reason recorded — the case the modal words itself.
    stub.listWorkflowTasks.mockResolvedValue([{ id: 'task-1', status: 'error' } as QueuedTask])
    const user = userEvent.setup()
    const props = {
      repo: { owner: 'acme', repo: 'one' },
      number: 12,
      type: 'issue' as const,
      alreadyQueued: false,
      onEnqueued: () => {},
      onClose: () => {},
    }
    const { rerender } = render(<TaskDetailModal {...props} messages={MESSAGES.en} />)

    await user.click(await screen.findByRole('button', { name: MESSAGES.en.taskDetailModal.addToWorkflow }))
    expect(await screen.findByText(MESSAGES.en.taskDetailModal.failedToStart)).toBeInTheDocument()

    rerender(<TaskDetailModal {...props} messages={MESSAGES.ko} />)

    expect(screen.getByText(MESSAGES.ko.taskDetailModal.failedToStart)).toBeInTheDocument()
    expect(screen.queryByText(MESSAGES.en.taskDetailModal.failedToStart)).toBeNull()
  })
})
