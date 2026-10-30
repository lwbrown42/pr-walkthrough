import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PreloadApi } from '../../src/shared/api'
import Walkthrough from '../../src/renderer/src/screens/Walkthrough'
import type { ReviewUpdate, SavedReview } from '../../src/shared/reviews'
import type { Walkthrough as W } from '../../src/shared/walkthrough'

vi.mock('../../src/renderer/src/components/CodePane', () => ({
  default: ({ mode }: { mode: string }) => <div data-testid="code-pane">mode:{mode}</div>
}))
vi.mock('../../src/renderer/src/components/ChatPanel', () => ({
  default: ({
    messages,
    onAppend
  }: {
    messages: { id: string; text: string }[]
    onAppend: (m: object) => void
  }) => (
    <div>
      <input aria-label="chat input" />
      {messages.map((m) => (
        <p key={m.id}>{m.text}</p>
      ))}
      <button
        type="button"
        onClick={() => onAppend({ id: 'new', stepId: 's1', role: 'user', text: 'Why?' })}
      >
        Ask
      </button>
    </div>
  )
}))

afterEach(cleanup)
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe = vi.fn()
    disconnect = vi.fn()
  }
)

const reviewUsage = {
  runs: 2,
  costUsd: 1.32,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }
}
let api: {
  getReviewUsage: ReturnType<typeof vi.fn>
  getRunLog: ReturnType<typeof vi.fn>
  saveReviewState: ReturnType<typeof vi.fn>
  checkReviewUpdates: ReturnType<typeof vi.fn>
}
beforeEach(() => {
  api = {
    getReviewUsage: vi.fn().mockResolvedValue(reviewUsage),
    getRunLog: vi.fn().mockResolvedValue([]),
    saveReviewState: vi.fn().mockResolvedValue(undefined),
    checkReviewUpdates: vi.fn().mockResolvedValue(null)
  }
  window.api = api as unknown as PreloadApi
})

const step = (n: number, extra: object = {}): W['steps'][number] => ({
  id: `s${n}`,
  title: `Title ${n}`,
  whyNext: n === 1 ? '' : `Because ${n}`,
  explanation: `Explain ${n}`,
  segments: [],
  ...extra
})

const wt: W = {
  summary: 'sum',
  steps: [step(1), step(2, { parentId: 's1' }), step(3), step(4)],
  target: {
    kind: 'local',
    repoPath: '/r',
    worktreePath: '/w',
    baseSha: 'a',
    headSha: 'b',
    title: 'My PR'
  },
  files: [],
  changedLines: 5,
  sessionId: 'x'
}

function setup(onExit = vi.fn()): ReturnType<typeof vi.fn> {
  render(<Walkthrough walkthrough={wt} onExit={onExit} />)
  return onExit
}

describe('Walkthrough screen', () => {
  it('renders every step title and the PR title', () => {
    setup()
    for (const n of [1, 2, 3, 4])
      expect(screen.getByRole('button', { name: new RegExp(`Title ${n}`) })).toBeTruthy()
    expect(screen.getByText('My PR')).toBeTruthy()
  })

  // Steps s1, s2 (detour from s1), s3, s4 → labels 1, 1a, 2, 3.
  const header = (text: string): HTMLElement => screen.getByText(new RegExp(`^${text}`))

  it('clicking a step shows its label of the main-step count and its explanation', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: /Title 3/ }))
    expect(header('Step 2 of 3')).toBeTruthy()
    expect(screen.getByText('Explain 3')).toBeTruthy()
    expect(screen.getByText('Because 3')).toBeTruthy()
  })

  it('omits whyNext when empty', () => {
    setup()
    expect(header('Step 1 of 3')).toBeTruthy()
    expect(document.querySelector('.why-next')).toBeNull()
  })

  it('labels a detour 1a, marks it in the list, and names its main step', async () => {
    setup()
    const detour = screen.getByRole('button', { name: /Title 2/ })
    expect(detour.textContent).toMatch(/^1a/)
    expect(detour.getAttribute('data-detour')).toBe('true')
    expect(screen.getByRole('button', { name: /Title 3/ }).getAttribute('data-detour')).toBeNull()
    await userEvent.click(detour)
    expect(header('Step 1a of 3').textContent).toContain('Detour from step 1')
  })

  it('j/k and arrows move between steps, clamped at the ends', async () => {
    setup()
    const user = userEvent.setup()
    await user.keyboard('k')
    expect(header('Step 1 of 3')).toBeTruthy()
    await user.keyboard('j')
    expect(header('Step 1a of 3')).toBeTruthy()
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(header('Step 3 of 3')).toBeTruthy()
    await user.keyboard('{ArrowUp}')
    expect(header('Step 2 of 3')).toBeTruthy()
    await user.keyboard('k')
    expect(header('Step 1a of 3')).toBeTruthy()
  })

  it('splits the explanation into paragraphs and renders backticks as code', () => {
    render(
      <Walkthrough
        walkthrough={{
          ...wt,
          steps: [step(1, { explanation: 'Calls `merge` first.\n\nThen `<|>` wins.' })]
        }}
        onExit={vi.fn()}
      />
    )
    const paras = document.querySelectorAll('.explanation-text p')
    expect(paras).toHaveLength(2)
    expect(
      [...document.querySelectorAll('.explanation-text code')].map((c) => c.textContent)
    ).toEqual(['merge', '<|>'])
    expect(document.querySelector('.explanation-text')?.textContent).not.toContain('`')
  })

  it('has a resize handle between each pair of panes', () => {
    setup()
    const handles = screen.getAllByRole('separator')
    expect(handles.map((h) => h.getAttribute('aria-orientation'))).toEqual([
      'vertical',
      'vertical',
      'horizontal'
    ])
    for (const h of handles) expect(h.tabIndex).toBe(0)
  })

  it('arrow keys on a focused resize handle do not change the step', async () => {
    // jsdom lays nothing out; the panels library needs real sizes to move a handle.
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200)
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
    onTestFinished(() => {
      width.mockRestore()
      height.mockRestore()
    })
    setup()
    const user = userEvent.setup()
    const chatHandle = screen.getAllByRole('separator')[2]
    act(() => chatHandle.focus())
    await user.keyboard('{ArrowDown}{ArrowUp}{ArrowDown}j')
    expect(header('Step 1 of 3')).toBeTruthy()
  })

  it('ignores keys typed in a text input', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('chat input'))
    await user.keyboard('jj')
    expect(header('Step 1 of 3')).toBeTruthy()
  })

  it('toggle switches mode passed to CodePane', async () => {
    setup()
    expect(screen.getByTestId('code-pane').textContent).toBe('mode:diff')
    await userEvent.click(screen.getByRole('button', { name: 'Plain' }))
    expect(screen.getByTestId('code-pane').textContent).toBe('mode:plain')
    await userEvent.click(screen.getByRole('button', { name: 'Diff' }))
    expect(screen.getByTestId('code-pane').textContent).toBe('mode:diff')
  })

  it('ticks steps already opened, but not the current one', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: /Title 3/ }))
    expect(screen.getByRole('button', { name: /Title 1/ }).textContent).toBe('1Title 1')
    expect(screen.getByRole('button', { name: /Title 1/ }).querySelector('.step-seen')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Title 3/ }).querySelector('.step-seen')).toBeNull()
    expect(screen.getByRole('button', { name: /Title 4/ }).querySelector('.step-seen')).toBeNull()
  })

  it('starts each step at the top of its code', async () => {
    setup()
    const scroller = document.querySelector('.code-scroll') as HTMLElement
    scroller.scrollTop = 200
    await userEvent.keyboard('j')
    expect(scroller.scrollTop).toBe(0)
  })

  it('New review calls onExit', async () => {
    const onExit = setup()
    await userEvent.click(screen.getByRole('button', { name: 'New review' }))
    expect(onExit).toHaveBeenCalled()
  })
})

describe('open the PR on GitHub', () => {
  const pr: W = { ...wt, target: { ...wt.target, kind: 'github', prNumber: 7 } }

  it('is offered only for a GitHub PR', () => {
    setup()
    expect(screen.queryByRole('button', { name: 'View on GitHub' })).toBeNull()
    cleanup()
    render(<Walkthrough walkthrough={pr} onExit={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'View on GitHub' })).toBeTruthy()
  })

  it('asks the main process to open it, and shows an error if that fails', async () => {
    const openPr = vi.fn().mockResolvedValue({ error: { message: 'gh: not logged in' } })
    window.api = { ...api, openPr } as unknown as PreloadApi
    render(<Walkthrough walkthrough={pr} onExit={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'View on GitHub' }))
    expect(openPr).toHaveBeenCalledOnce()
    expect((await screen.findByRole('alert')).textContent).toContain('gh: not logged in')
  })
})

describe('usage during a review', () => {
  it('shows what this review has cost so far in the top bar', async () => {
    setup()
    expect(await screen.findByText('This review: $1.32')).toBeTruthy()
  })

  it('opens Usage over the walkthrough and closes it with Esc, keeping the current step', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Title 3/ }))
    await user.click(screen.getByRole('button', { name: 'Usage' }))
    const dialog = await screen.findByRole('dialog', { name: 'Usage' })
    expect(dialog).toBeTruthy()
    // Step keys don't move the walkthrough while Usage is open.
    await user.keyboard('j')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText(/^Step 2 of 3/)).toBeTruthy()
  })

  it('closes Usage with its Close button', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Usage' }))
    await user.click(await screen.findByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

function makeReview(over: Partial<SavedReview> = {}): SavedReview {
  return {
    id: 'r1',
    key: 'k',
    walkthrough: wt,
    state: { index: 0, seen: [0], mode: 'diff', messages: [] },
    createdAt: '2026-10-20T00:00:00.000Z',
    generatedAt: '2026-10-20T00:00:00.000Z',
    lastOpenedAt: '2026-10-20T00:00:00.000Z',
    costUsd: 1,
    ...over
  }
}

const update = (latestHeadSha: string, newCommits: number | null): ReviewUpdate => ({
  latestHeadSha,
  newCommits,
  checkedAt: '2026-10-26T00:00:00.000Z'
})

describe('saved review', () => {
  afterEach(() => vi.useRealTimers())

  it('restores index, mode and messages from review.state', () => {
    const review = makeReview({
      state: {
        index: 2,
        seen: [0, 1, 2],
        mode: 'plain',
        messages: [{ id: 'm1', stepId: 's1', role: 'user', text: 'Earlier question' }]
      }
    })
    render(<Walkthrough walkthrough={wt} review={review} onExit={vi.fn()} />)
    expect(screen.getByText(/^Step 2 of 3/)).toBeTruthy()
    expect(screen.getByTestId('code-pane').textContent).toBe('mode:plain')
    expect(screen.getByText('Earlier question')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Title 2/ }).querySelector('.step-seen')).toBeTruthy()
  })

  it('clamps a restored index that is out of range', () => {
    const review = makeReview({ state: { index: 9, seen: [], mode: 'diff', messages: [] } })
    render(<Walkthrough walkthrough={wt} review={review} onExit={vi.fn()} />)
    expect(screen.getByText(/^Step 3 of 3/)).toBeTruthy()
  })

  it('saves position once after rapid j presses (debounced)', () => {
    vi.useFakeTimers()
    render(<Walkthrough walkthrough={wt} review={makeReview()} onExit={vi.fn()} />)
    for (let i = 0; i < 3; i++) fireEvent.keyDown(window, { key: 'j' })
    act(() => vi.advanceTimersByTime(499))
    expect(api.saveReviewState).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(api.saveReviewState).toHaveBeenCalledTimes(1)
    expect(api.saveReviewState).toHaveBeenCalledWith({
      id: 'r1',
      state: { index: 3, seen: [0, 1, 2, 3], mode: 'diff', messages: [] }
    })
  })

  it('flushes a pending save on unmount', () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <Walkthrough walkthrough={wt} review={makeReview()} onExit={vi.fn()} />
    )
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.click(screen.getByRole('button', { name: 'Plain' }))
    unmount()
    expect(api.saveReviewState).toHaveBeenCalledTimes(1)
    expect(api.saveReviewState).toHaveBeenCalledWith({
      id: 'r1',
      state: { index: 1, seen: [0, 1], mode: 'plain', messages: [] }
    })
    act(() => vi.advanceTimersByTime(1000))
    expect(api.saveReviewState).toHaveBeenCalledTimes(1)
  })

  it('saves chat messages immediately, with the current position', async () => {
    render(<Walkthrough walkthrough={wt} review={makeReview()} onExit={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(api.saveReviewState).toHaveBeenCalledWith({
      id: 'r1',
      state: {
        index: 0,
        seen: [0],
        mode: 'diff',
        messages: [{ id: 'new', stepId: 's1', role: 'user', text: 'Why?' }]
      }
    })
  })

  it('does not save on mount', () => {
    vi.useFakeTimers()
    render(<Walkthrough walkthrough={wt} review={makeReview()} onExit={vi.fn()} />)
    act(() => vi.advanceTimersByTime(1000))
    expect(api.saveReviewState).not.toHaveBeenCalled()
  })

  it('shows the banner when checkReviewUpdates reports a new head', async () => {
    api.checkReviewUpdates.mockResolvedValue(update('c', 2))
    render(<Walkthrough walkthrough={wt} review={makeReview()} onExit={vi.fn()} />)
    expect(await screen.findByText('2 new commits since this walkthrough')).toBeTruthy()
    expect(api.checkReviewUpdates).toHaveBeenCalledWith('r1')
  })

  it('shows no banner when the head is unchanged', async () => {
    api.checkReviewUpdates.mockResolvedValue(update('b', 0))
    render(<Walkthrough walkthrough={wt} review={makeReview()} onExit={vi.fn()} />)
    await act(async () => {})
    expect(screen.queryByText(/since this walkthrough/)).toBeNull()
  })

  it('shows the banner from the saved update before any check, singular for one commit', () => {
    render(
      <Walkthrough
        walkthrough={wt}
        review={makeReview({ update: update('c', 1) })}
        onExit={vi.fn()}
      />
    )
    expect(screen.getByText('1 new commit since this walkthrough')).toBeTruthy()
  })

  it('says "New commits" when the head moved but the count is 0 or unknown', async () => {
    api.checkReviewUpdates.mockResolvedValue(update('c', 0))
    render(
      <Walkthrough
        walkthrough={wt}
        review={makeReview({ update: update('c', null) })}
        onExit={vi.fn()}
      />
    )
    expect(screen.getByText('New commits since this walkthrough')).toBeTruthy()
    await act(async () => {})
    expect(screen.getByText('New commits since this walkthrough')).toBeTruthy()
  })

  it('checks for updates again every 5 minutes', async () => {
    vi.useFakeTimers()
    render(<Walkthrough walkthrough={wt} review={makeReview()} onExit={vi.fn()} />)
    expect(api.checkReviewUpdates).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(5 * 60_000))
    expect(api.checkReviewUpdates).toHaveBeenCalledTimes(2)
  })

  it('Regenerate asks to confirm and then calls onRegenerate', async () => {
    const onRegenerate = vi.fn()
    const review = makeReview({ update: update('c', 2) })
    render(
      <Walkthrough walkthrough={wt} review={review} onExit={vi.fn()} onRegenerate={onRegenerate} />
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect(onRegenerate).not.toHaveBeenCalled()
    expect(
      screen.getByText('Regenerate? This replaces the current walkthrough and its chat.')
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('2 new commits since this walkthrough')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Regenerate' }))
    await user.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect(onRegenerate).toHaveBeenCalledWith(review)
  })

  it('shows a notice in the banner slot', () => {
    render(
      <Walkthrough
        walkthrough={wt}
        review={makeReview()}
        notice="Regenerate failed: boom"
        onExit={vi.fn()}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain('Regenerate failed: boom')
  })

  it('no saves without a review (fixture)', async () => {
    vi.useFakeTimers()
    setup()
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    act(() => vi.advanceTimersByTime(1000))
    cleanup()
    expect(api.saveReviewState).not.toHaveBeenCalled()
    expect(api.checkReviewUpdates).not.toHaveBeenCalled()
  })
})
