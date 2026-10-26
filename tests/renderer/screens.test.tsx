import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import type { OpenResult, PreloadApi, PublicSettings } from '../../src/shared/api'

vi.mock('../../src/renderer/src/components/CodePane', () => ({ default: () => null }))

const settings: PublicSettings = {
  model: 'm',
  maxTurns: 30,
  maxBudgetUsd: 5,
  hasApiKey: true,
  lastRepoPath: '/repo'
}

const target = {
  kind: 'local' as const,
  repoPath: '/repo',
  worktreePath: '/wt',
  baseSha: 'a',
  headSha: 'b',
  title: 'My PR'
}

function opened(changedLines: number, overLimit: boolean): OpenResult {
  return { target, files: [], changedLines, overLimit }
}

afterEach(cleanup)

let api: { [K in keyof PreloadApi]: ReturnType<typeof vi.fn> }

beforeEach(() => {
  api = {
    getSettings: vi.fn().mockResolvedValue(settings),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    pickRepo: vi.fn().mockResolvedValue(null),
    openTarget: vi.fn().mockResolvedValue(opened(10, false)),
    generate: vi.fn(),
    cancelGenerate: vi.fn().mockResolvedValue(undefined),
    onGenerateProgress: vi.fn().mockReturnValue(() => {}),
    ask: vi.fn(),
    onChatText: vi.fn().mockReturnValue(() => {}),
    readFile: vi.fn(),
    listReviews: vi.fn().mockResolvedValue([]),
    checkReviewUpdates: vi.fn().mockResolvedValue(null),
    reopenReview: vi.fn(),
    saveReviewState: vi.fn().mockResolvedValue(undefined),
    deleteReview: vi.fn(),
    restoreReview: vi.fn().mockResolvedValue(undefined),
    getFixture: vi.fn().mockResolvedValue(null),
    getRunLog: vi.fn().mockResolvedValue([]),
    getReviewUsage: vi.fn().mockResolvedValue({
      runs: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    })
  }
  window.api = api as unknown as PreloadApi
})

async function openLocal(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(await screen.findByLabelText('Head ref'), 'feature')
  await user.click(screen.getByRole('button', { name: 'Open' }))
}

describe('screens', () => {
  it('Open shows "Start a new review" when reviews exist', async () => {
    api.listReviews.mockResolvedValue([
      {
        id: 'r1',
        title: 'Saved one',
        repoName: 'repo',
        repoPath: '/repo',
        progress: 'finished',
        questions: 0,
        costUsd: 0.5,
        lastOpenedAt: new Date().toISOString(),
        newCommits: undefined,
        repoFound: true,
        target
      }
    ])
    render(<App />)
    expect(await screen.findByText('Start a new review')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Reviews' })).toBeTruthy()
    expect(screen.queryByText('Open a change')).toBeNull()
  })

  it('shows Setup without an API key and saves it', async () => {
    api.getSettings.mockResolvedValue({ ...settings, hasApiKey: false })
    const user = userEvent.setup()
    render(<App />)
    await user.type(await screen.findByLabelText('Anthropic API key'), 'sk-test')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-test' }))
    expect(await screen.findByText('Open a change')).toBeTruthy()
  })

  it('prefills the repo, opens a target and shows counts', async () => {
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    expect(api.openTarget).toHaveBeenCalledWith({
      kind: 'local',
      repoPath: '/repo',
      headRef: 'feature'
    })
    expect(await screen.findByText('0 files, 10 changed lines')).toBeTruthy()
  })

  it('warns when over the limit and Generate still works', async () => {
    api.openTarget.mockResolvedValue(opened(2000, true))
    api.generate.mockResolvedValue({
      id: 'r1',
      walkthrough: {
        summary: '',
        steps: [{ id: 's1', title: 'First step', whyNext: '', explanation: '', segments: [] }],
        target,
        files: [],
        changedLines: 2000,
        sessionId: 'x'
      },
      state: { index: 0, seen: [0], mode: 'diff', messages: [] },
      generatedAt: '2026-10-26T00:00:00.000Z'
    })
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    expect(
      await screen.findByText(
        'This PR has 2000 changed lines, above the 1,300 line limit. The walkthrough may be slower or less accurate.'
      )
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(api.generate).toHaveBeenCalledWith(target)
    expect(await screen.findByText(/^Step 1 of 1/)).toBeTruthy()
  })

  it('shows a no_api_key error naming the API key, with Retry', async () => {
    api.generate.mockResolvedValue({ error: { message: 'raw', reason: 'no_api_key' } })
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    await user.click(await screen.findByRole('button', { name: 'Generate' }))
    expect(await screen.findByText(/API key/)).toBeTruthy()
    api.generate.mockClear()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api.generate).toHaveBeenCalledTimes(1))
  })

  it('shows GitHub CLI errors from openTarget verbatim', async () => {
    const message = 'GitHub CLI (gh) is not installed or not logged in'
    api.openTarget.mockResolvedValue({ error: { message } })
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    expect(await screen.findByText(message)).toBeTruthy()
  })

  it('returns to Open with the error when generate rejects', async () => {
    api.generate.mockRejectedValue(new Error('ipc boom'))
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    await user.click(await screen.findByRole('button', { name: 'Generate' }))
    expect(await screen.findByText('ipc boom')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('shows the error when openTarget rejects', async () => {
    api.openTarget.mockRejectedValue(new Error('open boom'))
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    expect(await screen.findByText('open boom')).toBeTruthy()
  })

  it('ticks the elapsed time every second while generating', async () => {
    api.generate.mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    vi.useFakeTimers()
    try {
      await act(async () => {
        screen.getByRole('button', { name: 'Generate' }).click()
      })
      expect(screen.getByText('0:00')).toBeTruthy()
      await act(async () => {
        vi.advanceTimersByTime(3000)
      })
      expect(screen.getByText('0:03')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a generation and returns to Open without an error', async () => {
    let resolve!: (v: unknown) => void
    api.generate.mockReturnValue(new Promise((r) => (resolve = r)))
    api.cancelGenerate.mockImplementation(async () =>
      resolve({ error: { message: 'Generation was cancelled.', reason: 'cancelled' } })
    )
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    await user.click(await screen.findByRole('button', { name: 'Generate' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(api.cancelGenerate).toHaveBeenCalled()
    expect(await screen.findByText('Open a change')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeTruthy()
  })

  it('Open offers Reopen saved review and Generate a new one when opened.saved is set', async () => {
    const lastOpenedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    api.openTarget.mockResolvedValue({
      ...opened(2000, true),
      saved: { id: 'r9', progress: 'step 4 of 9', lastOpenedAt, newCommits: 2 }
    })
    api.reopenReview.mockResolvedValue({ error: { message: 'gone' } })
    api.generate.mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    expect(
      await screen.findByText(
        'You have a saved review of this PR (step 4 of 9, 2 days ago) · 2 new commits since'
      )
    ).toBeTruthy()
    expect(screen.getByText(/above the 1,300 line limit/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reopen saved review' }))
    expect(api.reopenReview).toHaveBeenCalledWith('r9')
    await openLocal(user)
    await user.click(await screen.findByRole('button', { name: 'Generate a new one' }))
    expect(api.generate).toHaveBeenCalledWith(target)
  })

  it('Open adds nothing to the saved-review prompt when there are no new commits', async () => {
    api.openTarget.mockResolvedValue({
      ...opened(10, false),
      saved: {
        id: 'r9',
        progress: 'step 1 of 2',
        lastOpenedAt: new Date().toISOString(),
        newCommits: 0
      }
    })
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    expect(
      await screen.findByText('You have a saved review of this PR (step 1 of 2, just now)')
    ).toBeTruthy()
  })

  it('clears the opened target when inputs change or tabs switch', async () => {
    const user = userEvent.setup()
    render(<App />)
    await openLocal(user)
    expect(await screen.findByRole('button', { name: 'Generate' })).toBeTruthy()
    await user.type(screen.getByLabelText('Head ref'), 'x')
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open' }))
    expect(await screen.findByRole('button', { name: 'Generate' })).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: 'GitHub PR' }))
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull()
  })

  it('blocks saving when maxTurns is empty', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    await user.clear(await screen.findByLabelText('Max turns'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Max turns must be/)).toBeTruthy()
    expect(api.saveSettings).not.toHaveBeenCalled()
  })

  it('offers Retry when getSettings rejects', async () => {
    api.getSettings.mockRejectedValueOnce(new Error('settings boom'))
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByText('settings boom')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Open a change')).toBeTruthy()
  })
})

describe('usage navigation', () => {
  it('opens Usage from the Open screen and comes back', async () => {
    api.getRunLog.mockResolvedValue([])
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Usage' }))
    expect(await screen.findByText(/No runs logged yet/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('Open a change')).toBeTruthy()
  })
})
