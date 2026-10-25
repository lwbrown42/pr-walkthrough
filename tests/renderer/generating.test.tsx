import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Generating from '../../src/renderer/src/screens/Generating'
import type { GenerateProgressEvent, OpenResult, PreloadApi } from '../../src/shared/api'

afterEach(cleanup)

const opened: OpenResult = {
  target: {
    kind: 'local',
    repoPath: '/repo',
    worktreePath: '/wt',
    baseSha: 'aaaaaaaaaaaaaaaa',
    headSha: 'bbbbbbbbbbbbbbbb',
    title: 'feat/skip-headers'
  },
  files: [],
  changedLines: 418,
  overLimit: false
}

const base: GenerateProgressEvent = {
  stage: 'reading',
  turns: 0,
  filesTotal: 12,
  lookups: 0,
  activity: [],
  stepTitles: [],
  elapsedMs: 0
}

let emit: (p: GenerateProgressEvent) => void

beforeEach(() => {
  window.api = {
    generate: vi.fn(() => new Promise(() => {})),
    cancelGenerate: vi.fn().mockResolvedValue(undefined),
    onGenerateProgress: vi.fn((cb: (p: GenerateProgressEvent) => void) => {
      emit = cb
      return () => {}
    })
  } as unknown as PreloadApi
})

const show = (): void => {
  render(
    <Generating
      opened={{ ...opened, files: Array(12).fill(null) as never }}
      limits={{ maxTurns: 60, maxBudgetUsd: 3 }}
      onDone={vi.fn()}
      onError={vi.fn()}
      onCancelled={vi.fn()}
    />
  )
}
const stage = (name: string): HTMLElement => screen.getByRole('listitem', { name })

describe('Generating', () => {
  it('names the change: title, base → head, files and lines', () => {
    show()
    expect(screen.getByText('feat/skip-headers')).toBeTruthy()
    expect(screen.getByText('aaaaaaa')).toBeTruthy()
    expect(screen.getByText('bbbbbbb')).toBeTruthy()
    expect(screen.getByText(/12 files · 418 lines/)).toBeTruthy()
  })

  it('shows reading progress and recent activity in plain words', () => {
    show()
    act(() =>
      emit({
        ...base,
        turns: 4,
        lookups: 9,
        activity: [
          { verb: 'Searching for', target: 'SkipHeaders' },
          { verb: 'Reading', target: 'src/config.ts', sections: 4 }
        ]
      })
    )
    const reading = stage('Reading the PR')
    expect(reading.getAttribute('data-state')).toBe('active')
    expect(within(reading).getByText('12 changed files · 9 lookups')).toBeTruthy()
    expect(within(reading).queryByText(/ of 12/)).toBeNull()
    expect(within(reading).getByText('· 4 sections')).toBeTruthy()
    expect(within(reading).getByText('SkipHeaders')).toBeTruthy()
    expect(within(reading).getByText('src/config.ts').tagName).toBe('CODE')
    expect(stage('Writing the steps').getAttribute('data-state')).toBe('pending')
  })

  it('lists step titles while writing, newest first and marked as in progress', () => {
    show()
    act(() =>
      emit({
        ...base,
        stage: 'writing',
        lookups: 20,
        stepTitles: ['Merging options', 'The type']
      })
    )
    expect(stage('Reading the PR').getAttribute('data-state')).toBe('done')
    expect(within(stage('Reading the PR')).getByText('12 changed files · 20 lookups')).toBeTruthy()
    const writing = stage('Writing the steps')
    expect(writing.getAttribute('data-state')).toBe('active')
    expect(within(writing).getByText('step 3…')).toBeTruthy()
    const items = within(writing).getAllByRole('listitem')
    expect(items.map((i) => i.textContent)).toEqual(['The type', 'Merging options'])
  })

  it('marks final checks active at the end', () => {
    show()
    act(() => emit({ ...base, stage: 'finishing', stepTitles: ['A'] }))
    expect(stage('Writing the steps').getAttribute('data-state')).toBe('done')
    expect(stage('Final checks').getAttribute('data-state')).toBe('active')
  })

  it('shows turns against the cap and the budget cap', () => {
    show()
    act(() => emit({ ...base, turns: 31 }))
    expect(screen.getByText('31')).toBeTruthy()
    expect(screen.getByText(/\/ 60/)).toBeTruthy()
    expect(screen.getByText('$3.00')).toBeTruthy()
  })
})
