import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import GlobalSettings from './GlobalSettings'
import { createElectronApiStub } from '../test/electron-api-stub'
import { LANGUAGE_NAMES, MESSAGES } from '../i18n'

describe('GlobalSettings provider save', () => {
  it('shows a core refusal and never claims a filtered provider snapshot was saved', async () => {
    const stub = createElectronApiStub()
    const refusal =
      'Cannot save the filtered provider list from Global settings. Nothing was written. Repair the config file.'
    stub.api.ai.save.mockRejectedValueOnce(new Error(refusal))
    const user = userEvent.setup()

    render(
      <GlobalSettings
        messages={MESSAGES.en}
        theme="system"
        onThemeChange={() => {}}
        language="system"
        onLanguageChange={() => {}}
      />,
    )
    await screen.findByText('No AI providers registered yet.')

    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(refusal)).toBeInTheDocument()
    expect(screen.queryByText('Saved')).toBeNull()
  })
})

describe('GlobalSettings language', () => {
  it('offers each language as a toggle in its own labelled group and hands the choice up', async () => {
    createElectronApiStub()
    const onLanguageChange = vi.fn()
    const user = userEvent.setup()

    render(
      <GlobalSettings
        messages={MESSAGES.en}
        theme="system"
        onThemeChange={() => {}}
        language="ko"
        onLanguageChange={onLanguageChange}
      />,
    )
    await screen.findByText('No AI providers registered yet.')

    // Scoped by its group: Appearance has a "System" toggle too.
    const group = screen.getByRole('group', { name: 'Language' })
    expect(
      within(group)
        .getAllByRole('button')
        .map((toggle) => [toggle.textContent, toggle.getAttribute('aria-pressed')]),
    ).toEqual([
      ['System', 'false'],
      [LANGUAGE_NAMES.en, 'false'],
      [LANGUAGE_NAMES.ko, 'true'],
    ])
    // Each language's name is marked with its own language, so a screen reader voices it correctly.
    expect(within(group).getAllByRole('button').map((toggle) => toggle.getAttribute('lang'))).toEqual([
      null,
      'en',
      'ko',
    ])

    await user.click(within(group).getByRole('button', { name: LANGUAGE_NAMES.en }))
    expect(onLanguageChange).toHaveBeenCalledWith('en')
  })

  it('says which language "system" resolves to on this machine, not which one is on screen', async () => {
    // Rendered in Korean on a machine jsdom reports as en-US, so the two candidates differ: the hint has
    // to name English — what 'system' would show here — while every other word on the pane is Korean.
    createElectronApiStub()
    render(
      <GlobalSettings
        messages={MESSAGES.ko}
        theme="system"
        onThemeChange={() => {}}
        language="ko"
        onLanguageChange={() => {}}
      />,
    )
    await screen.findByText(MESSAGES.ko.globalSettings.noProviders)

    expect(screen.getByText(MESSAGES.ko.language.hint(LANGUAGE_NAMES.en))).toBeInTheDocument()
    expect(screen.queryByText(MESSAGES.ko.language.hint(LANGUAGE_NAMES.ko))).toBeNull()
  })
})

describe('GlobalSettings validation', () => {
  it('re-words a validation error already on screen when the language changes', async () => {
    createElectronApiStub()
    const user = userEvent.setup()
    const props = { theme: 'system' as const, onThemeChange: () => {}, language: 'en' as const, onLanguageChange: () => {} }
    const { rerender } = render(<GlobalSettings {...props} messages={MESSAGES.en} />)
    await screen.findByText(MESSAGES.en.globalSettings.noProviders)

    // A new provider has no name and, being an API provider, no key: two complaints, joined by a space.
    await user.click(screen.getByRole('button', { name: MESSAGES.en.globalSettings.addProvider }))
    await user.click(screen.getByRole('button', { name: MESSAGES.en.globalSettings.saveChanges }))
    const worded = (language: 'en' | 'ko') => {
      const validation = MESSAGES[language].globalSettings.validation
      return `${validation.nameRequired} ${validation.apiKeyMissing(validation.unnamedProvider)}`
    }
    expect(await screen.findByText(worded('en'))).toBeInTheDocument()

    rerender(<GlobalSettings {...props} language="ko" messages={MESSAGES.ko} />)

    expect(screen.getByText(worded('ko'))).toBeInTheDocument()
    expect(screen.queryByText(worded('en'))).toBeNull()
  })
})
