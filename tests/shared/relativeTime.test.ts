import { describe, expect, it } from 'vitest'
import { relativeTime } from '../../src/shared/relativeTime'

const now = Date.parse('2026-10-26T12:00:00Z')
const ago = (ms: number): string => new Date(now - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

describe('relativeTime', () => {
  it('formats each range', () => {
    expect(relativeTime(ago(30_000), now)).toBe('just now')
    expect(relativeTime(ago(5 * MIN), now)).toBe('5 min ago')
    expect(relativeTime(ago(2 * HOUR), now)).toBe('2 h ago')
    expect(relativeTime(ago(30 * HOUR), now)).toBe('yesterday')
    expect(relativeTime(ago(72 * HOUR), now)).toBe('3 days ago')
  })
})
