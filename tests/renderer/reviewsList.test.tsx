import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReviewsList from '../../src/renderer/src/components/ReviewsList'
import type { PreloadApi } from '../../src/shared/api'
import type { ReviewSummary, ReviewUpdate, SavedReview } from '../../src/shared/reviews'

function summary(id: string, over: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    id,
    title: `Title ${id}`,
    repoName: 'fossa-cli',
    repoPath: '/work/fossa-cli',
    baseRef: 'main',
    headRef: `feat-${id}`,
    progress: 'step 4 of 9',
    questions: 3,
    costUsd: 1.4,
    lastOpenedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    newCommits: undefined,
    repoFound: true,
    target: {
      kind: 'local',
      repoPath: '/work/fossa-cli',
      worktreePath: '/wt',
      baseSha: 'a',
      headSha: 'old',
      title: `Title ${id}`
    },
    ...over
  }
}

const update = (n: number | null): ReviewUpdate => ({
  latestHeadSha: 'new',
  newCommits: n,
  checkedAt: 'now'
})

let api: Pick<
  { [K in keyof PreloadApi]: ReturnType<typeof vi.fn> },
  'listReviews' | 'checkReviewUpdates' | 'deleteReview' | 'restoreReview'
>

beforeEach(() => {
  api = {
    listReviews: vi.fn().mockResolvedValue([]),
    checkReviewUpdates: vi.fn().mockResolvedValue(null),
    deleteReview: vi.fn(),
    restoreReview: vi.fn().mockResolvedValue(undefined)
  }
  window.api = api as unknown as PreloadApi
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const noop = (): void => {}

describe('ReviewsList', () => {
  it('renders rows with progress, questions and cost', async () => {
    api.listReviews.mockResolvedValue([
      summary('1', { prNumber: 1421 }),
      summary('2', { questions: 1, progress: 'finished' })
    ])
    render(<ReviewsList onReopen={noop} onRegenerate={noop} />)
    expect(await screen.findByText('Title 1')).toBeTruthy()
    expect(screen.getByText('#1421')).toBeTruthy()
    expect(screen.getAllByText('2 h ago')).toHaveLength(2)
    const meta = screen.getAllByText(/fossa-cli/)[0]
    expect(meta.textContent).toBe('fossa-cli · main → feat-1 · step 4 of 9 · 3 questions · $1.40')
    expect(screen.getByText(/1 question ·/)).toBeTruthy()
    expect(screen.getByText('Reviews are kept for 7 days after you last open them.')).toBeTruthy()
  })

  it('reports the count through onLoaded', async () => {
    api.listReviews.mockResolvedValue([summary('1')])
    const onLoaded = vi.fn()
    render(<ReviewsList onReopen={noop} onRegenerate={noop} onLoaded={onLoaded} />)
    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith(1))
  })

  it('calls onReopen when a row is clicked', async () => {
    api.listReviews.mockResolvedValue([summary('1')])
    const onReopen = vi.fn()
    render(<ReviewsList onReopen={onReopen} onRegenerate={noop} />)
    await userEvent.click(await screen.findByText('Title 1'))
    expect(onReopen).toHaveBeenCalledWith('1')
  })

  it('shows the badge after checkReviewUpdates resolves', async () => {
    api.listReviews.mockResolvedValue([summary('1'), summary('2'), summary('3')])
    api.checkReviewUpdates.mockImplementation(async (id: string) =>
      id === '1' ? update(2) : id === '2' ? update(1) : update(null)
    )
    render(<ReviewsList onReopen={noop} onRegenerate={noop} />)
    expect(await screen.findByText('2 new commits')).toBeTruthy()
    expect(screen.getByText('1 new commit')).toBeTruthy()
    expect(screen.getByText('New commits')).toBeTruthy()
  })

  it('shows no badge when the head has not moved', async () => {
    api.listReviews.mockResolvedValue([summary('1')])
    api.checkReviewUpdates.mockResolvedValue({ ...update(0), latestHeadSha: 'old' })
    render(<ReviewsList onReopen={noop} onRegenerate={noop} />)
    await waitFor(() => expect(api.checkReviewUpdates).toHaveBeenCalled())
    expect(screen.queryByText(/new commit/i)).toBeNull()
  })

  it('runs at most 2 checks at once', async () => {
    const resolvers: Array<(u: ReviewUpdate | null) => void> = []
    api.listReviews.mockResolvedValue(['1', '2', '3', '4', '5'].map((i) => summary(i)))
    api.checkReviewUpdates.mockImplementation(
      () => new Promise((res) => resolvers.push(res as (u: ReviewUpdate | null) => void))
    )
    render(<ReviewsList onReopen={noop} onRegenerate={noop} />)
    await screen.findByText('Title 1')
    await waitFor(() => expect(api.checkReviewUpdates).toHaveBeenCalledTimes(2))
    await act(async () => {
      resolvers[0](null)
    })
    await waitFor(() => expect(api.checkReviewUpdates).toHaveBeenCalledTimes(3))
    expect(api.checkReviewUpdates).toHaveBeenCalledTimes(3)
  })

  it('does not check reviews whose repo is missing', async () => {
    api.listReviews.mockResolvedValue([summary('1', { repoFound: false })])
    render(<ReviewsList onReopen={noop} onRegenerate={noop} />)
    await screen.findByText('Repository not found at /work/fossa-cli')
    expect(api.checkReviewUpdates).not.toHaveBeenCalled()
  })

  it('missing repo row shows the message and only Delete', async () => {
    api.listReviews.mockResolvedValue([summary('1', { repoFound: false })])
    const onReopen = vi.fn()
    render(<ReviewsList onReopen={onReopen} onRegenerate={noop} />)
    await screen.findByText('Repository not found at /work/fossa-cli')
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Delete review'])
    await userEvent.click(screen.getByText('Title 1'))
    expect(onReopen).not.toHaveBeenCalled()
  })

  it('shows a row error, with Regenerate only when offered', async () => {
    api.listReviews.mockResolvedValue([summary('1'), summary('2')])
    const onRegenerate = vi.fn()
    const s1 = summary('1')
    api.listReviews.mockResolvedValue([s1, summary('2')])
    const { rerender } = render(
      <ReviewsList
        onReopen={noop}
        onRegenerate={onRegenerate}
        rowError={{ id: '1', message: 'Commit gone', regenerate: true }}
      />
    )
    expect(await screen.findByText('Commit gone')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect(onRegenerate).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }))
    expect(screen.getAllByRole('button', { name: 'Delete' }).length).toBe(1)
    rerender(
      <ReviewsList
        onReopen={noop}
        onRegenerate={onRegenerate}
        rowError={{ id: '1', message: 'Other problem' }}
      />
    )
    expect(screen.getByText('Other problem')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull()
  })

  it('delete hides the row and Undo restores it', async () => {
    const s = summary('1')
    const removed = { id: '1' } as SavedReview
    api.listReviews.mockResolvedValue([s])
    api.deleteReview.mockResolvedValue(removed)
    render(<ReviewsList onReopen={noop} onRegenerate={noop} />)
    await screen.findByText('Title 1')
    await userEvent.click(screen.getByRole('button', { name: 'Delete review' }))
    expect(screen.queryByText('Title 1')).toBeNull()
    expect(api.deleteReview).toHaveBeenCalledWith('1')
    const toast = await screen.findByText('Review deleted')
    expect(toast).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(api.restoreReview).toHaveBeenCalledWith(removed)
    await waitFor(() => expect(api.listReviews).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Review deleted')).toBeNull()
  })

  it('removes the Undo toast after 6 seconds', async () => {
    api.listReviews.mockResolvedValue([summary('1')])
    api.deleteReview.mockResolvedValue({ id: '1' } as SavedReview)
    render(<ReviewsList onReopen={noop} onRegenerate={noop} />)
    await screen.findByText('Title 1')
    vi.useFakeTimers()
    await act(async () => {
      screen.getByRole('button', { name: 'Delete review' }).click()
    })
    expect(screen.getByText('Review deleted')).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.queryByText('Review deleted')).toBeNull()
    expect(api.restoreReview).not.toHaveBeenCalled()
  })

  it('renders nothing for an empty list', async () => {
    const { container } = render(<ReviewsList onReopen={noop} onRegenerate={noop} />)
    await waitFor(() => expect(api.listReviews).toHaveBeenCalled())
    expect(container.textContent).toBe('')
    expect(within(container).queryByRole('list')).toBeNull()
  })
})
