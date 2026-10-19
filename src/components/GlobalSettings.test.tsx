import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import GlobalSettings from './GlobalSettings'
import { createElectronApiStub } from '../test/electron-api-stub'
import type { AiProviderConfig } from '../../core/ai/types'

/** What `MaoApp.saveProviders` resolves with once the write lands. Cast past the stub's throw-only type. */
const echoSave = (async (providers: AiProviderConfig[]) => providers) as never

describe('GlobalSettings provider save', () => {
  it('shows a core refusal and never claims a filtered provider snapshot was saved', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([{ id: 'claude', name: 'Claude', kind: 'cli', command: 'claude' }])
    const refusal =
      'Cannot save the filtered provider list from Global settings. Nothing was written. Repair the config file.'
    stub.api.ai.save.mockRejectedValueOnce(new Error(refusal))
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    // An edit, so there is a provider write for core to refuse — an unchanged list is not written at all.
    await user.type(await screen.findByDisplayValue('Claude'), ' Code')

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

describe('GlobalSettings saves only what it can stand behind', () => {
  const claude = { id: 'claude', name: 'Claude', kind: 'cli' as const, command: 'claude' }

  it('saves a token without re-writing an unchanged provider list', async () => {
    // Re-writing it would let an import made in a terminal meanwhile refuse this token-only save.
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([claude])
    stub.api.github.setToken.mockResolvedValue(undefined as never)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await screen.findByDisplayValue('Claude')
    await user.type(screen.getByPlaceholderText('ghp_...'), 'ghp_test')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await screen.findByText('Saved')
    expect(stub.api.ai.save).not.toHaveBeenCalled()
    expect(stub.api.github.setToken).toHaveBeenCalledWith('ghp_test')
  })

  it('says when the provider list could not be loaded, and refuses to save providers over it blind', async () => {
    // A failed load used to leave an empty pane that read as "no providers yet"; adding one and saving sent
    // no base, and core then replaced the whole stored list — every API key with it.
    const stub = createElectronApiStub()
    stub.listProviders.mockRejectedValue(new Error('Unexpected token \'g\', "ghp_SENTINEL" is not valid JSON'))
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    expect(await screen.findByText(/provider list could not be loaded/)).toBeInTheDocument()
    expect(screen.queryByText(/ghp_SENTINEL/)).toBeNull()
    expect(screen.queryByText('No AI providers registered yet.')).toBeNull()

    await user.click(screen.getByRole('button', { name: '+ Add provider' }))
    await user.type(screen.getByPlaceholderText('Name'), 'New')
    await user.type(screen.getByPlaceholderText('API key'), 'test-key')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(/never loaded, so saving these providers would replace it blind/)).toBeInTheDocument()
    expect(stub.api.ai.save).not.toHaveBeenCalled()
  })

  it('disables Save while a save is in flight, so a double-click cannot refuse itself', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([claude])
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    stub.api.ai.save.mockImplementation((async (providers: AiProviderConfig[]) => {
      await pending
      return providers
    }) as never)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await user.type(await screen.findByDisplayValue('Claude'), ' Code')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    release()
    await screen.findByText('Saved')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    expect(stub.api.ai.save).toHaveBeenCalledTimes(1)
  })

  it('keeps saying the load failed after a Save, and recovers through Retry', async () => {
    // The warning used to live in the save error, so the next Save cleared it and showed "Saved" beside
    // an empty pane — and "reopen Global settings" was impossible with no project to navigate away to.
    const stub = createElectronApiStub()
    stub.listProviders.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue([claude])
    stub.api.github.setToken.mockResolvedValue(undefined as never)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await screen.findByText(/provider list could not be loaded/)
    await user.type(screen.getByPlaceholderText('ghp_...'), 'ghp_test')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved')
    expect(screen.getByText(/provider list could not be loaded/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry loading providers' }))
    expect(await screen.findByDisplayValue('Claude')).toBeInTheDocument()
    expect(screen.queryByText(/provider list could not be loaded/)).toBeNull()
  })

  it('does not claim a save when there was nothing to write', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([claude])
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await screen.findByDisplayValue('Claude')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Nothing to save')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('keeps a provider typed during a failed load when Retry succeeds, and drops the stale refusal', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue([claude])
    stub.api.ai.save.mockImplementation(echoSave)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await screen.findByText(/provider list could not be loaded/)
    await user.click(screen.getByRole('button', { name: '+ Add provider' }))
    await user.type(screen.getByPlaceholderText('Name'), 'New')
    await user.type(screen.getByPlaceholderText('API key'), 'test-key')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText(/never loaded/)

    await user.click(screen.getByRole('button', { name: 'Retry loading providers' }))
    expect(await screen.findByDisplayValue('Claude')).toBeInTheDocument()
    expect(screen.getByDisplayValue('New')).toBeInTheDocument()
    expect(screen.queryByText(/never loaded/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Saved')
    const [saved, base] = vi.mocked(stub.api.ai.save).mock.calls[0] as unknown as [AiProviderConfig[], AiProviderConfig[]]
    expect(saved.map((p) => p.name)).toEqual(['Claude', 'New'])
    expect(base).toEqual([claude])
  })
})
