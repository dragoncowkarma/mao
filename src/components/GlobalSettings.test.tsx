import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import GlobalSettings from './GlobalSettings'
import { createElectronApiStub } from '../test/electron-api-stub'
import type { AiProviderConfig } from '../../core/ai/types'
import type { ModelCatalogView } from '../../core/ai/provider-options'
import type { ModelCatalogRefreshReport } from '../../core/model-catalog'

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

  /** A load the test answers by hand, so two loads can be made to overlap in either order. */
  function deferredList() {
    let answer!: (list: AiProviderConfig[]) => void
    const promise = new Promise<AiProviderConfig[]>((resolve) => {
      answer = resolve
    })
    return { promise, answer }
  }

  it.each([['in order'], ['out of order']])(
    'does not resurrect a provider deleted between two overlapping loads (%s)',
    async (order) => {
      // The fifth review's reproduction: a double-clicked Retry, with `import-providers` deleting B between
      // the two reads. Carrying the earlier load's B over as if it were typed made the next token-only Save
      // write B — and its API key — back.
      const other = { id: 'other', name: 'Other', kind: 'api' as const, apiKey: 'test-key' }
      const stub = createElectronApiStub()
      const first = deferredList()
      const second = deferredList()
      stub.listProviders
        .mockRejectedValueOnce(new Error('EACCES'))
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      stub.api.github.setToken.mockResolvedValue(undefined as never)
      const user = userEvent.setup()

      render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
      const retry = await screen.findByRole('button', { name: 'Retry loading providers' })
      await user.click(retry)
      await user.click(retry)
      if (order === 'in order') {
        first.answer([claude, other])
        second.answer([claude])
      } else {
        second.answer([claude])
        first.answer([claude, other])
      }

      expect(await screen.findByDisplayValue('Claude')).toBeInTheDocument()
      expect(screen.queryByDisplayValue('Other')).toBeNull()
      await user.type(screen.getByPlaceholderText('ghp_...'), 'ghp_test')
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      await screen.findByText('Saved')
      expect(stub.api.ai.save).not.toHaveBeenCalled()
    },
  )

  it('keeps an error that still applies when Retry succeeds', async () => {
    // Only the never-loaded refusal is made moot by a load. A token write that failed is still unsaved.
    const stub = createElectronApiStub()
    stub.listProviders.mockRejectedValueOnce(new Error('EACCES')).mockResolvedValue([claude])
    stub.api.github.setToken.mockRejectedValue(new Error('The GitHub token could not be written.'))
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await screen.findByText(/provider list could not be loaded/)
    await user.type(screen.getByPlaceholderText('ghp_...'), 'ghp_test')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('The GitHub token could not be written.')

    await user.click(screen.getByRole('button', { name: 'Retry loading providers' }))
    expect(await screen.findByDisplayValue('Claude')).toBeInTheDocument()
    expect(screen.getByText('The GitHub token could not be written.')).toBeInTheDocument()
  })
})

describe('GlobalSettings design system selector', () => {
  it('renders all 3 selectable design presets with aria-pressed and invokes onDesignChange when clicked', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([])
    const onDesignChange = vi.fn()
    const user = userEvent.setup()

    const { rerender } = render(
      <GlobalSettings theme="system" onThemeChange={() => {}} design="classic" onDesignChange={onDesignChange} />,
    )

    const group = screen.getByRole('group', { name: 'Design system' })
    expect(group).toBeInTheDocument()

    const classicBtn = screen.getByRole('button', { name: /Classic/ })
    const crimsonBtn = screen.getByRole('button', { name: /Crimson Signal/ })
    const consoleBtn = screen.getByRole('button', { name: /Developer Console/ })

    expect(classicBtn).toHaveAttribute('aria-pressed', 'true')
    expect(crimsonBtn).toHaveAttribute('aria-pressed', 'false')
    expect(consoleBtn).toHaveAttribute('aria-pressed', 'false')

    await user.click(crimsonBtn)
    expect(onDesignChange).toHaveBeenLastCalledWith('crimson')

    rerender(
      <GlobalSettings theme="system" onThemeChange={() => {}} design="crimson" onDesignChange={onDesignChange} />,
    )
    expect(classicBtn).toHaveAttribute('aria-pressed', 'false')
    expect(crimsonBtn).toHaveAttribute('aria-pressed', 'true')
    expect(consoleBtn).toHaveAttribute('aria-pressed', 'false')

    await user.click(consoleBtn)
    expect(onDesignChange).toHaveBeenLastCalledWith('console')

    rerender(
      <GlobalSettings theme="system" onThemeChange={() => {}} design="console" onDesignChange={onDesignChange} />,
    )
    expect(classicBtn).toHaveAttribute('aria-pressed', 'false')
    expect(crimsonBtn).toHaveAttribute('aria-pressed', 'false')
    expect(consoleBtn).toHaveAttribute('aria-pressed', 'true')

    await user.click(classicBtn)
    expect(onDesignChange).toHaveBeenLastCalledWith('classic')
  })

  it('displays appearanceError in an alert without clearing unsaved GitHub token or AI provider inputs', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([{ id: 'claude', name: 'Claude', kind: 'cli', command: 'claude' }])
    const user = userEvent.setup()

    const { rerender } = render(<GlobalSettings theme="system" onThemeChange={() => {}} design="classic" />)

    const providerName = await screen.findByDisplayValue('Claude')
    await user.type(providerName, ' Code')
    await user.type(screen.getByPlaceholderText('ghp_...'), 'ghp_unsaved_token')

    rerender(
      <GlobalSettings
        theme="system"
        onThemeChange={() => {}}
        design="classic"
        appearanceError="Cannot write config.json: EACCES"
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Cannot write config.json: EACCES')
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.getByPlaceholderText('ghp_...')).toHaveValue('ghp_unsaved_token')
    expect(screen.getByDisplayValue('Claude Code')).toBeInTheDocument()
  })

  it('invokes onDismissAppearanceError when the Dismiss button is clicked and marks preset disclosure as button', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([{ id: 'claude', name: 'Claude', kind: 'cli', command: 'claude' }])
    const onDismiss = vi.fn()
    const user = userEvent.setup()

    render(
      <GlobalSettings
        theme="system"
        onThemeChange={() => {}}
        design="classic"
        appearanceError="Cannot write config.json: EACCES"
        onDismissAppearanceError={onDismiss}
      />,
    )

    const disclosure = await screen.findByRole('button', { name: /Model \/ Effort presets/ })
    expect(disclosure).toHaveAttribute('type', 'button')
    expect(disclosure).toHaveClass('btn-disclosure')

    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    expect(dismiss).toHaveAttribute('type', 'button')
    expect(screen.getByRole('alert')).toContainElement(dismiss)

    await user.click(dismiss)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

/**
 * Issue #140: the pickers merge the refreshed model catalog over the built-in tables, the pane says where
 * each list came from, and a manual refresh re-reads every CLI without ever showing raw error text.
 */
describe('GlobalSettings model catalog', () => {
  const codexCli: AiProviderConfig = { id: 'codex', name: 'Codex runner', kind: 'cli', command: 'codex', providerKindId: 'codex' }
  const refreshed: ModelCatalogView = {
    providers: { codex: { updatedAt: '2026-11-22T00:00:00.000Z', source: 'codex-debug-models',
      models: [{ id: 'gpt-7-nova', efforts: ['low', 'medium', 'high'] }] } },
    attempts: {
      codex: { at: '2026-11-22T00:00:00.000Z', outcome: 'updated' },
      antigravity: { at: '2026-11-22T00:00:00.000Z', outcome: 'failed', reason: 'command-not-found' },
    },
    ttlMs: 86_400_000,
  }

  it('offers a model only the refreshed catalog knows, beside the built-in ones', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([codexCli])
    stub.getModelCatalog.mockResolvedValue(refreshed)

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)

    expect(await screen.findByRole('option', { name: 'gpt-7-nova' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'gpt-6.2-sol' })).toBeInTheDocument()
    expect(screen.getByText(/Codex: 1 model\(s\), refreshed/)).toBeInTheDocument()
    expect(screen.getByText('Antigravity (agy): built-in list — last refresh failed: the CLI is not installed or not on PATH'))
      .toBeInTheDocument()
  })

  it('keeps a saved model the catalog no longer lists visible and selected', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([{ ...codexCli, providerKindId: 'claude', command: 'claude', model: 'claude-opus-5' }])

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)

    const retired = await screen.findByRole('option', { name: 'claude-opus-5 (not in catalog)' })
    expect((retired as HTMLOptionElement).selected).toBe(true)
  })

  it('refreshes on request and shows each provider\'s outcome', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([codexCli])
    stub.api.ai.refreshModelCatalog.mockImplementation((async () => ({
      results: [
        { kind: 'antigravity', outcome: 'failed', reason: 'command-not-found', models: 0 },
        { kind: 'codex', outcome: 'updated', models: 1 },
      ],
      catalog: refreshed,
      persisted: true,
    })) as never)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await screen.findByDisplayValue('Codex runner')
    expect(screen.queryByRole('option', { name: 'gpt-7-nova' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Refresh model lists' }))

    expect(await screen.findByRole('option', { name: 'gpt-7-nova' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Model lists refreshed with problems')
    expect(stub.api.ai.refreshModelCatalog).toHaveBeenCalledTimes(1)
  })

  it('says a refresh failed in fixed words, never the rejection\'s own text', async () => {
    const stub = createElectronApiStub()
    stub.api.ai.refreshModelCatalog.mockRejectedValue(new Error('spawn codex at /home/me with sk-ant-SECRET'))
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Refresh model lists' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh the model lists.')
    expect(document.body.textContent).not.toContain('sk-ant-SECRET')
    expect(screen.getByRole('button', { name: 'Refresh model lists' })).toBeEnabled()
  })

  it('keeps a saved effort the chosen model no longer offers visible and selected', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([{
      ...codexCli, presets: [{ id: 'p1', model: 'gpt-6-luna', effort: 'ultra' }], selectedPresetId: 'p1',
    }])
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /Model \/ Effort presets/ }))

    const kept = screen.getByRole('option', { name: 'ultra (not supported by this model)' })
    expect((kept as HTMLOptionElement).selected).toBe(true)
  })

  // `hidden: true` because the rows sit in a collapsed <details>: present for every operator to expand.
  it('lists every provider\'s models with their levels, even one no provider uses yet', async () => {
    const stub = createElectronApiStub()
    stub.getModelCatalog.mockResolvedValue(refreshed)

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)

    const codexModels = await screen.findByRole('list', { name: 'Codex models', hidden: true })
    expect(within(codexModels).getByText('gpt-7-nova')).toBeInTheDocument()
    expect(within(codexModels).getByText('gpt-7-nova').parentElement).toHaveTextContent('gpt-7-nova low, medium, high')
    expect(within(codexModels).getByText('gpt-6-luna').parentElement).toHaveTextContent('low, medium, high, xhigh, max')
    const claudeModels = screen.getByRole('list', { name: 'Claude models', hidden: true })
    expect(within(claudeModels).getByText('haiku').parentElement).toHaveTextContent('haiku no effort flag')
    expect(within(screen.getByRole('list', { name: 'Antigravity (agy) models', hidden: true })).getByText('gemini-4-neon')).toBeInTheDocument()
  })

  it('says when a refresh could not be saved, which no provider line can', async () => {
    const stub = createElectronApiStub()
    stub.api.ai.refreshModelCatalog.mockImplementation((async () => ({
      results: [{ kind: 'codex', outcome: 'updated', models: 1 }], catalog: refreshed, persisted: false,
    })) as never)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await user.click(await screen.findByRole('button', { name: 'Refresh model lists' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Model lists refreshed.'))
    expect(screen.getByRole('status')).toHaveTextContent('could not be saved, so the rest of MAO keeps the previous lists')
  })

  it('states the refresh cadence only once the catalog has loaded', async () => {
    const stub = createElectronApiStub()
    let answer!: (view: ModelCatalogView) => void
    stub.getModelCatalog.mockImplementation(() => new Promise((resolve) => { answer = resolve }))

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await screen.findByRole('heading', { name: 'Model catalog' })
    expect(screen.queryByText(/refreshes them every|Automatic refresh is off/)).toBeNull()

    answer({ ...refreshed, ttlMs: null })
    expect(await screen.findByText(/Automatic refresh is off/)).toBeInTheDocument()
    expect(screen.queryByText(/on request only/)).toBeNull()
  })

  it('announces a refresh in progress through the same status region', async () => {
    const stub = createElectronApiStub()
    let finish!: (report: ModelCatalogRefreshReport) => void
    stub.api.ai.refreshModelCatalog.mockImplementation((() => new Promise((resolve) => { finish = resolve })) as never)
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    const status = screen.getByRole('status')
    await user.click(await screen.findByRole('button', { name: 'Refresh model lists' }))

    expect(status).toHaveTextContent('Refreshing model lists…')
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled()
    finish({ results: [], catalog: refreshed, persisted: true })
    await waitFor(() => expect(status).toHaveTextContent('Model lists refreshed.'))
    expect(screen.getByRole('status')).toBe(status)
  })

  it('names the daily cadence for the default period', async () => {
    const stub = createElectronApiStub()
    stub.getModelCatalog.mockResolvedValue(refreshed)
    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    expect(await screen.findByText(/MAO also refreshes them every 24 h\./)).toBeInTheDocument()
  })

  it('narrows a preset\'s effort choices to the chosen model\'s levels', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([{
      ...codexCli, presets: [{ id: 'p1', model: 'gpt-6-luna' }, { id: 'p2', model: 'gpt-6.2-sol' }], selectedPresetId: 'p1',
    }])
    const user = userEvent.setup()

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)
    await user.click(await screen.findByRole('button', { name: /Model \/ Effort presets/ }))

    const [luna, sol] = screen.getAllByRole('combobox').filter((select) =>
      within(select).queryByRole('option', { name: 'Effort: —' }) && within(select).queryByRole('option', { name: 'max' }))
    expect(within(luna).queryByRole('option', { name: 'ultra' })).toBeNull()
    expect(within(sol).getByRole('option', { name: 'ultra' })).toBeInTheDocument()
  })
})

describe('GlobalSettings Antigravity levels (PR #141 review)', () => {
  it('offers a refreshed stem only at the levels agy listed, still showing a saved one it no longer lists', async () => {
    const stub = createElectronApiStub()
    stub.listProviders.mockResolvedValue([{
      id: 'agy', name: 'Antigravity runner', kind: 'cli', command: 'agy', providerKindId: 'antigravity', model: 'gemini-4-neon-xhigh',
    }])
    stub.getModelCatalog.mockResolvedValue({
      providers: { antigravity: { updatedAt: '2026-11-22T00:00:00.000Z', source: 'agy-models',
        models: [{ id: 'gemini-4-neon', efforts: ['high'] }] } },
      attempts: {}, ttlMs: 86_400_000,
    })

    render(<GlobalSettings theme="system" onThemeChange={() => {}} />)

    const saved = await screen.findByRole('option', { name: 'gemini-4-neon-xhigh (not in catalog)' })
    expect((saved as HTMLOptionElement).selected).toBe(true)
    expect(screen.getByRole('option', { name: 'gemini-4-neon (high)' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'gemini-4-neon (xhigh)' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'gemini-4-neon (low)' })).toBeNull()
    // A built-in stem the refresh did not list keeps its built-in levels.
    expect(screen.getByRole('option', { name: 'gemini-4-hydrogen (xhigh)' })).toBeInTheDocument()
  })
})
