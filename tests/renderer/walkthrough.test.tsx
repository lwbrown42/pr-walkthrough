import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Walkthrough from '../../src/renderer/src/screens/Walkthrough'
import type { Walkthrough as W } from '../../src/shared/walkthrough'

vi.mock('../../src/renderer/src/components/CodePane', () => ({
  default: ({ mode }: { mode: string }) => <div data-testid="code-pane">mode:{mode}</div>
}))
vi.mock('../../src/renderer/src/components/ChatPanel', () => ({
  default: () => <input aria-label="chat input" />
}))

afterEach(cleanup)

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

  it('clicking step 3 shows Step 3 of 4 and its explanation', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: /Title 3/ }))
    expect(screen.getByText('Step 3 of 4')).toBeTruthy()
    expect(screen.getByText('Explain 3')).toBeTruthy()
    expect(screen.getByText('Because 3')).toBeTruthy()
  })

  it('omits whyNext when empty', () => {
    setup()
    expect(screen.getByText('Step 1 of 4')).toBeTruthy()
    expect(document.querySelector('.why-next')).toBeNull()
  })

  it('marks child steps as indented', () => {
    setup()
    expect(screen.getByRole('button', { name: /Title 2/ }).getAttribute('data-indented')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: /Title 3/ }).getAttribute('data-indented')).toBe(
      'false'
    )
  })

  it('j/k and arrows move between steps, clamped at the ends', async () => {
    setup()
    const user = userEvent.setup()
    await user.keyboard('k')
    expect(screen.getByText('Step 1 of 4')).toBeTruthy()
    await user.keyboard('j')
    expect(screen.getByText('Step 2 of 4')).toBeTruthy()
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(screen.getByText('Step 4 of 4')).toBeTruthy()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByText('Step 3 of 4')).toBeTruthy()
    await user.keyboard('k')
    expect(screen.getByText('Step 2 of 4')).toBeTruthy()
  })

  it('ignores keys typed in a text input', async () => {
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('chat input'))
    await user.keyboard('jj')
    expect(screen.getByText('Step 1 of 4')).toBeTruthy()
  })

  it('toggle switches mode passed to CodePane', async () => {
    setup()
    expect(screen.getByTestId('code-pane').textContent).toBe('mode:diff')
    await userEvent.click(screen.getByRole('button', { name: 'Plain' }))
    expect(screen.getByTestId('code-pane').textContent).toBe('mode:plain')
    await userEvent.click(screen.getByRole('button', { name: 'Diff' }))
    expect(screen.getByTestId('code-pane').textContent).toBe('mode:diff')
  })

  it('New review calls onExit', async () => {
    const onExit = setup()
    await userEvent.click(screen.getByRole('button', { name: 'New review' }))
    expect(onExit).toHaveBeenCalled()
  })
})
