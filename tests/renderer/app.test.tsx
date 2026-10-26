import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/renderer/src/App'
import type { OpenResult, PreloadApi, PublicSettings } from '../../src/shared/api'
import type { SavedReview } from '../../src/shared/reviews'

vi.mock('../../src/renderer/src/components/CodePane', () => ({ default: () => null }))

// Generating ends at once, the way the test asks.
let generatingEnds: 'cancelled' | 'error' = 'cancelled'
vi.mock('../../src/renderer/src/screens/Generating', () => ({
  default: function GeneratingStub({
    onCancelled,
    onError
  }: {
    onCancelled: () => void
    onError: (m: string) => void
  }) {
    useEffect(() => {
      if (generatingEnds === 'cancelled') onCancelled()
      else onError('the agent gave up')
    }, [onCancelled, onError])
    return <p>Generating…</p>
  }
}))

afterEach(cleanup)

const settings: PublicSettings = {
  model: 'm',
  maxTurns: 30,
  maxBudgetUsd: 5,
  hasApiKey: true,
  lastRepoPath: '/repo'
}

const target = {
  kind: 'github' as const,
  repoPath: '/repo',
  worktreePath: '/wt',
  baseSha: 'a',
  headSha: 'b',
  title: 'My PR',
  prNumber: 7
}

const review: SavedReview = {
  id: 'r1',
  key: 'k',
  walkthrough: {
    summary: '',
    steps: [
      { id: 's1', title: 'First step', whyNext: '', explanation: '', segments: [] },
      { id: 's2', title: 'Second step', whyNext: '', explanation: '', segments: [] }
    ],
    target,
    files: [],
    changedLines: 3,
    sessionId: 'x'
  },
  state: { index: 1, seen: [0, 1], mode: 'diff', messages: [] },
  createdAt: '2026-10-20T00:00:00.000Z',
  generatedAt: '2026-10-20T00:00:00.000Z',
  lastOpenedAt: '2026-10-20T00:00:00.000Z',
  costUsd: 1,
  update: { latestHeadSha: 'c', newCommits: 2, checkedAt: '2026-10-26T00:00:00.000Z' }
}

const opened: OpenResult = {
  target: { ...target, headSha: 'c' },
  files: [],
  changedLines: 3,
  overLimit: false
}

let api: { [K in keyof PreloadApi]: ReturnType<typeof vi.fn> }

beforeEach(() => {
  generatingEnds = 'cancelled'
  api = {
    getSettings: vi.fn().mockResolvedValue(settings),
    saveSettings: vi.fn(),
    pickRepo: vi.fn(),
    openTarget: vi.fn().mockResolvedValue(opened),
    generate: vi.fn(),
    cancelGenerate: vi.fn(),
    onGenerateProgress: vi.fn().mockReturnValue(() => {}),
    ask: vi.fn(),
    onChatText: vi.fn().mockReturnValue(() => {}),
    readFile: vi.fn(),
    listReviews: vi.fn().mockResolvedValue([]),
    checkReviewUpdates: vi.fn().mockResolvedValue(null),
    reopenReview: vi.fn().mockResolvedValue(review),
    saveReviewState: vi.fn().mockResolvedValue(undefined),
    deleteReview: vi.fn(),
    restoreReview: vi.fn(),
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

/** Opens the PR, reopens its saved review, and confirms Regenerate. */
async function regenerate(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  api.openTarget.mockResolvedValueOnce({
    ...opened,
    saved: { id: 'r1', progress: 'step 2 of 2', lastOpenedAt: review.lastOpenedAt, newCommits: 2 }
  })
  await user.click(await screen.findByRole('tab', { name: 'GitHub PR' }))
  await user.type(screen.getByLabelText('PR number or URL'), '7')
  await user.click(screen.getByRole('button', { name: 'Open' }))
  await user.click(await screen.findByRole('button', { name: 'Reopen saved review' }))
  expect(await screen.findByText('2 new commits since this walkthrough')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Regenerate' }))
  await user.click(screen.getByRole('button', { name: 'Regenerate' }))
}

describe('regenerate from the walkthrough', () => {
  it('cancelled regenerate reopens the review instead of the Open screen', async () => {
    const user = userEvent.setup()
    render(<App />)
    await regenerate(user)
    expect(api.openTarget).toHaveBeenLastCalledWith({ kind: 'github', repoPath: '/repo', pr: '7' })
    expect(await screen.findByText(/^Step 2 of 2/)).toBeTruthy()
    expect(api.reopenReview).toHaveBeenCalledTimes(2)
    expect(api.reopenReview).toHaveBeenLastCalledWith('r1')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Open a change')).toBeNull()
  })

  it('failed regenerate reopens the review with a notice', async () => {
    generatingEnds = 'error'
    const user = userEvent.setup()
    render(<App />)
    await regenerate(user)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Regenerate failed: the agent gave up'
    )
    expect(screen.getByText(/^Step 2 of 2/)).toBeTruthy()
  })

  it('an openTarget error stays on the walkthrough with a notice', async () => {
    const user = userEvent.setup()
    render(<App />)
    api.openTarget.mockResolvedValueOnce({
      ...opened,
      saved: { id: 'r1', progress: 'step 2 of 2', lastOpenedAt: review.lastOpenedAt, newCommits: 2 }
    })
    api.openTarget.mockResolvedValueOnce({ error: { message: 'PR #7 not found' } })
    await user.click(await screen.findByRole('tab', { name: 'GitHub PR' }))
    await user.type(screen.getByLabelText('PR number or URL'), '7')
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(await screen.findByRole('button', { name: 'Reopen saved review' }))
    await user.click(await screen.findByRole('button', { name: 'Regenerate' }))
    await user.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Regenerate failed: PR #7 not found'
    )
    expect(screen.getByText(/^Step 2 of 2/)).toBeTruthy()
    expect(api.reopenReview).toHaveBeenCalledTimes(1)
  })

  it('falls back to Open with the error when the reopen after a cancel fails', async () => {
    const user = userEvent.setup()
    render(<App />)
    api.reopenReview
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce({ error: { message: 'Repository not found at /repo' } })
    await regenerate(user)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Repository not found at /repo'
    )
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
    expect(screen.queryByText(/^Step/)).toBeNull()
  })
})
