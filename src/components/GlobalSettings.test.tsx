import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import GlobalSettings from './GlobalSettings'
import { createElectronApiStub } from '../test/electron-api-stub'

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
