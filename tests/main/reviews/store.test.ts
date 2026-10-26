import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReviewStore } from '../../../src/main/reviews/store'
import type { SavedReview } from '../../../src/shared/reviews'

const review = (over: Partial<SavedReview> = {}): SavedReview => ({
  id: 'r1',
  key: '/repo|github|12',
  walkthrough: {
    summary: 'sum',
    steps: [{ id: 's1', title: 's1', whyNext: '', explanation: '', segments: [] }],
    target: {
      kind: 'github',
      repoPath: '/repo',
      worktreePath: '/wt',
      baseSha: 'b1',
      headSha: 'h1',
      title: 'Add thing',
      prNumber: 12
    },
    files: [],
    changedLines: 10,
    sessionId: 'sess'
  },
  state: { index: 0, seen: [], mode: 'diff', messages: [] },
  createdAt: '2026-10-20T00:00:00.000Z',
  generatedAt: '2026-10-20T00:00:00.000Z',
  lastOpenedAt: '2026-10-20T00:00:00.000Z',
  costUsd: 0.5,
  ...over
})

let dir: string
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'review-store-')), 'reviews')
})
afterEach(() => {
  rmSync(join(dir, '..'), { recursive: true, force: true })
})

describe('createReviewStore', () => {
  it('save then get round-trips', () => {
    const store = createReviewStore(dir)
    const r = review()
    store.save(r)
    expect(store.get('r1')).toEqual(r)
  })

  it('findByKey returns the review with that key', () => {
    const store = createReviewStore(dir)
    store.save(review({ id: 'a', key: 'k1' }))
    store.save(review({ id: 'b', key: 'k2' }))
    expect(store.findByKey('k2')?.id).toBe('b')
    expect(store.findByKey('nope')).toBeNull()
  })

  it('remove deletes the file', () => {
    const store = createReviewStore(dir)
    store.save(review())
    store.remove('r1')
    expect(existsSync(join(dir, 'r1.json'))).toBe(false)
    expect(store.get('r1')).toBeNull()
    expect(() => store.remove('r1')).not.toThrow()
  })

  it('list skips a truncated JSON file and a schema-invalid file but returns the valid one', () => {
    const store = createReviewStore(dir)
    store.save(review({ id: 'good' }))
    writeFileSync(join(dir, 'truncated.json'), '{"id": "truncated", "key": ')
    writeFileSync(join(dir, 'invalid.json'), JSON.stringify({ id: 'invalid' }))
    writeFileSync(join(dir, 'good.json.tmp'), 'leftover')
    expect(store.list().map((r) => r.id)).toEqual(['good'])
  })

  it('list returns [] when the directory does not exist', () => {
    expect(createReviewStore(dir).list()).toEqual([])
  })

  it('save leaves no .tmp file behind', () => {
    const store = createReviewStore(dir)
    store.save(review())
    expect(readdirSync(dir)).toEqual(['r1.json'])
  })

  it('save refuses a non-plain id', () => {
    const store = createReviewStore(dir)
    expect(() => store.save(review({ id: '../settings' }))).toThrow()
    expect(() => store.save(review({ id: '' }))).toThrow()
    expect(() => store.save(review({ id: 'a\\b' }))).toThrow()
    expect(existsSync(join(dir, '..', 'settings.json'))).toBe(false)
  })

  it("get('../settings') returns null", () => {
    const store = createReviewStore(dir)
    writeFileSync(join(dir, '..', 'settings.json'), JSON.stringify(review()))
    expect(store.get('../settings')).toBeNull()
    expect(store.get('')).toBeNull()
    expect(store.get('a\\b')).toBeNull()
  })
})
