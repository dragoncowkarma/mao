import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import GlobalSettings from './GlobalSettings'
import { createElectronApiStub } from '../test/electron-api-stub'
import type { AiProviderConfig } from '../../core/ai/types'

/** What `MaoApp.saveProviders` resolves with once the write lands. Cast past the stub's throw-only type. */
const echoSave = (async (providers: AiProviderConfig[]) => providers) as never

describe('GlobalSettings provider save', () => {
  it('shows a core refusal and never claims a filtered provider snapshot was saved', async () => {
    const stub = createElectronApiStub()
    const refusal =
      'Cannot save the filtered provider list from Global settings. Nothing was written. Repair the config file.'
    stub.api.ai.save.mockRejectedValueOnce(new Error(refusal))
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await screen.findByText('No AI providers registered yet.')

    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(refusal)).toBeInTheDocument()
    expect(screen.queryByText('Saved')).toBeNull()
  })
})

/**
 * Issue #73's provider half: the pane edits a copy of the list it loaded, so a save is derived from that
 * load. Core can only refuse a save over a list another process changed meanwhile (`mao config
 * import-providers` in a terminal) if it is told what the pane loaded — so every save sends it, and a
 * successful save becomes the base of the next. Drop the second argument, or stop advancing it after a
 * save, and this fails.
 */
describe('GlobalSettings provider save beside another process', () => {
  it('sends the list it loaded with a save, and the list it saved with the next one', async () => {
    const claude = { id: 'claude', name: 'Claude', kind: 'cli' as const, command: 'claude' }
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([claude])
    // `ai.save` is deliberately unimplemented in the shared stub; answer like core does on success.
    stub.api.ai.save.mockImplementation(echoSave)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    const name = await screen.findByDisplayValue('Claude')

    await user.type(name, ' Code')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved')
    expect(stub.api.ai.save).toHaveBeenLastCalledWith([{ ...claude, name: 'Claude Code' }], [claude])

    await user.type(name, '!')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(stub.api.ai.save).toHaveBeenCalledTimes(2))
    expect(stub.api.ai.save).toHaveBeenLastCalledWith(
      [{ ...claude, name: 'Claude Code!' }],
      [{ ...claude, name: 'Claude Code' }],
    )
  })

  it('keeps the loaded list as the base when a save is refused', async () => {
    // A refused save wrote nothing, so the stored list is still whatever it was — advancing the base to
    // the refused edit would let the retry land over the very change that caused the refusal.
    const claude = { id: 'claude', name: 'Claude', kind: 'cli' as const, command: 'claude' }
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([claude])
    stub.api.ai.save
      .mockRejectedValueOnce(new Error('The stored AI provider list changed after Global settings loaded it.'))
      .mockImplementation(echoSave)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    const name = await screen.findByDisplayValue('Claude')
    await user.type(name, ' Code')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText(/changed after Global settings loaded it/)

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(stub.api.ai.save).toHaveBeenCalledTimes(2))
    expect(stub.api.ai.save).toHaveBeenLastCalledWith([{ ...claude, name: 'Claude Code' }], [claude])
  })
})
