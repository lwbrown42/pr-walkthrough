import { describe, expect, it } from 'vitest'
import type { RunLogEntry } from '../../src/shared/types'
import { summarizeRuns } from '../../src/shared/usage'

const run = (over: Partial<RunLogEntry>): RunLogEntry => ({
  at: '2026-10-23T12:00:00.000Z',
  kind: 'generate',
  prTitle: 'Add retry',
  changedLines: 100,
  durationMs: 1000,
  costUsd: 0.5,
  turns: 3,
  outcome: 'success',
  tokens: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 200 },
  ...over
})

const now = new Date('2026-10-23T18:00:00.000Z')

describe('summarizeRuns', () => {
  it('totals today, this month and all time separately', () => {
    const s = summarizeRuns(
      [
        run({ at: '2026-10-23T09:00:00.000Z' }),
        run({ at: '2026-10-02T09:00:00.000Z', costUsd: 1 }),
        run({ at: '2026-09-30T09:00:00.000Z', costUsd: 2 })
      ],
      now
    )
    expect(s.today).toMatchObject({ runs: 1, costUsd: 0.5 })
    expect(s.month).toMatchObject({ runs: 2, costUsd: 1.5 })
    expect(s.allTime).toMatchObject({ runs: 3, costUsd: 3.5 })
    expect(s.allTime.tokens).toEqual({
      input: 300,
      output: 150,
      cacheRead: 3000,
      cacheCreation: 600
    })
  })

  it('counts entries without cost or tokens (old or failed runs) as runs only', () => {
    const s = summarizeRuns([run({ costUsd: null, tokens: undefined }), run({})], now)
    expect(s.allTime).toMatchObject({ runs: 2, costUsd: 0.5 })
    expect(s.allTime.tokens.input).toBe(100)
  })

  it('groups by PR title, most expensive first, and splits generate vs chat', () => {
    const s = summarizeRuns(
      [
        run({ prTitle: 'A', costUsd: 0.2 }),
        run({ prTitle: 'B', costUsd: 1 }),
        run({ prTitle: 'A', kind: 'chat', costUsd: 0.05 })
      ],
      now
    )
    expect(s.byPr.map((p) => p.prTitle)).toEqual(['B', 'A'])
    expect(s.byPr[1]).toMatchObject({ generations: 1, chats: 1 })
    expect(s.byPr[1].totals.costUsd).toBeCloseTo(0.25)
  })

  it('lists recent runs newest first', () => {
    const s = summarizeRuns(
      [run({ at: '2026-10-20T00:00:00.000Z' }), run({ at: '2026-10-22T00:00:00.000Z' })],
      now
    )
    expect(s.recent.map((r) => r.at)).toEqual([
      '2026-10-22T00:00:00.000Z',
      '2026-10-20T00:00:00.000Z'
    ])
  })
})
