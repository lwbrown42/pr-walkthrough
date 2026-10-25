import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileBar from '../../src/renderer/src/components/FileBar'
import type { CodeSegment } from '../../src/shared/walkthrough'

afterEach(cleanup)

// jsdom has no layout: "Jump to" is 50px wide, each name 100px, the bar 450px.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.textContent === 'Jump to' ? 50 : 100
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(450)
})

const segs = (n: number): CodeSegment[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'change',
    path: `src/f${i}.ts`,
    startLine: 1,
    endLine: 2
  }))

const bar = (): HTMLElement => screen.getByRole('navigation', { name: 'Jump to segment' })
const links = (): string[] =>
  within(bar())
    .queryAllByRole('button')
    .map((b) => b.textContent!)

describe('FileBar', () => {
  it('shows every name when they all fit, with no menu', () => {
    render(<FileBar segments={segs(3)} onJump={vi.fn()} />)
    expect(links()).toEqual(['f0.ts', 'f1.ts', 'f2.ts'])
    expect(within(bar()).queryByRole('combobox')).toBeNull()
  })

  it('shows the whole names that fit and puts the rest in "+N more"', async () => {
    const onJump = vi.fn()
    render(<FileBar segments={segs(6)} onJump={onJump} />)
    // 450 - 50 - 10 = 390 of room; the menu takes 96, each name 110 with its gap: 2 fit.
    expect(links()).toEqual(['f0.ts', 'f1.ts'])
    const menu = within(bar()).getByRole('combobox', { name: 'More segments' })
    expect(within(menu).getByRole('option', { name: '+4 more' })).toBeTruthy()
    await userEvent.selectOptions(menu, 'src/f5.ts')
    expect(onJump).toHaveBeenCalledWith(5)
  })

  it('renders nothing for a single segment', () => {
    render(<FileBar segments={segs(1)} onJump={vi.fn()} />)
    expect(screen.queryByRole('navigation')).toBeNull()
  })
})
