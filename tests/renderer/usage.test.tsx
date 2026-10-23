import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Usage from '../../src/renderer/src/screens/Usage'
import type { PreloadApi } from '../../src/shared/api'
import type { RunLogEntry } from '../../src/shared/types'

afterEach(cleanup)

const entry = (over: Partial<RunLogEntry>): RunLogEntry => ({
  at: new Date().toISOString(),
  kind: 'generate',
  prTitle: 'Add retry',
  changedLines: 420,
  durationMs: 95_000,
  costUsd: 1.25,
  turns: 18,
  outcome: 'success',
  tokens: { input: 12_000, output: 8_000, cacheRead: 400_000, cacheCreation: 30_000 },
  ...over
})

let getRunLog: ReturnType<typeof vi.fn>

beforeEach(() => {
  getRunLog = vi.fn()
  window.api = { getRunLog } as unknown as PreloadApi
})

describe('Usage', () => {
  it('shows totals, per-PR rows, and recent runs', async () => {
    getRunLog.mockResolvedValue([
      entry({}),
      entry({ kind: 'chat', costUsd: 0.05, turns: 2, durationMs: 4000, tokens: null })
    ])
    render(<Usage onBack={() => {}} />)

    const today = await screen.findByRole('region', { name: 'Today' })
    expect(within(today).getByText('$1.30')).toBeTruthy()
    expect(within(today).getByText('2 runs')).toBeTruthy()

    const byPr = screen.getByRole('table', { name: 'By PR' })
    expect(within(byPr).getByText('Add retry')).toBeTruthy()

    const recent = screen.getByRole('table', { name: 'Recent runs' })
    // header + 2 rows
    expect(within(recent).getAllByRole('row')).toHaveLength(3)
    expect(within(recent).getByText('chat')).toBeTruthy()
    expect(within(recent).getByText('1:35')).toBeTruthy()
  })

  it('formats token counts compactly', async () => {
    getRunLog.mockResolvedValue([entry({})])
    render(<Usage onBack={() => {}} />)
    const recent = await screen.findByRole('table', { name: 'Recent runs' })
    expect(within(recent).getByText('12k')).toBeTruthy()
    expect(within(recent).getByText('400k')).toBeTruthy()
  })

  it('shows an empty state with no runs', async () => {
    getRunLog.mockResolvedValue([])
    render(<Usage onBack={() => {}} />)
    expect(await screen.findByText(/No runs logged yet/)).toBeTruthy()
  })

  it('shows an error with Retry if the log cannot be read', async () => {
    getRunLog.mockRejectedValueOnce(new Error('disk')).mockResolvedValueOnce([])
    const user = userEvent.setup()
    render(<Usage onBack={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toContain('disk')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/No runs logged yet/)).toBeTruthy()
  })

  it('Back calls onBack', async () => {
    getRunLog.mockResolvedValue([])
    const onBack = vi.fn()
    const user = userEvent.setup()
    render(<Usage onBack={onBack} />)
    await user.click(await screen.findByRole('button', { name: 'Back' }))
    expect(onBack).toHaveBeenCalled()
  })
})
