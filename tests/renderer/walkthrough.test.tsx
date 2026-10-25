import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../src/shared/api'
import Walkthrough from '../../src/renderer/src/screens/Walkthrough'
import type { Walkthrough as W } from '../../src/shared/walkthrough'

vi.mock('../../src/renderer/src/components/CodePane', () => ({
  default: ({ mode }: { mode: string }) => <div data-testid="code-pane">mode:{mode}</div>
}))
vi.mock('../../src/renderer/src/components/ChatPanel', () => ({
  default: () => <input aria-label="chat input" />
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
let api: { getReviewUsage: ReturnType<typeof vi.fn>; getRunLog: ReturnType<typeof vi.fn> }
beforeEach(() => {
  api = {
    getReviewUsage: vi.fn().mockResolvedValue(reviewUsage),
    getRunLog: vi.fn().mockResolvedValue([])
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
