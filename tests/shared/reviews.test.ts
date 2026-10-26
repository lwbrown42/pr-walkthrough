import { describe, expect, it } from 'vitest'
import {
  REVIEW_RETENTION_DAYS,
  SavedReviewSchema,
  hasNewCommits,
  isExpired,
  openRequestFor,
  progressLabel,
  reviewKey,
  summarizeReview,
  type ReviewUpdate,
  type SavedReview
} from '../../src/shared/reviews'
import type { ReviewTarget } from '../../src/shared/types'
import type { Step } from '../../src/shared/walkthrough'

const target = (over: Partial<ReviewTarget> = {}): ReviewTarget => ({
  kind: 'github',
  repoPath: '/repo',
  worktreePath: '/wt',
  baseSha: 'b1',
  headSha: 'h1',
  title: 'Add thing',
  prNumber: 12,
  ...over
})

const step = (id: string, parentId?: string): Step => ({
  id,
  title: id,
  parentId,
  whyNext: '',
  explanation: '',
  segments: []
})

// 9 main steps, with a detour '2a' after the second one.
const steps = (): Step[] => [
  step('s1'),
  step('s2'),
  step('d2', 's2'),
  ...['s3', 's4', 's5', 's6', 's7', 's8', 's9'].map((id) => step(id))
]

const review = (over: Partial<SavedReview> = {}): SavedReview => ({
  id: 'r1',
  key: '/repo|github|12',
  walkthrough: {
    summary: 'sum',
    steps: steps(),
    target: target(),
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

describe('reviewKey', () => {
  it('uses the PR number for github', () => {
    expect(reviewKey(target())).toBe('/repo|github|12')
  })
  it('uses headRef for local', () => {
    expect(reviewKey(target({ kind: 'local', prNumber: undefined, headRef: 'feat' }))).toBe(
      '/repo|local|feat'
    )
  })
  it('falls back to title for local without headRef', () => {
    expect(reviewKey(target({ kind: 'local', prNumber: undefined }))).toBe('/repo|local|Add thing')
  })
})

describe('progressLabel', () => {
  it('shows the main step label of the current index', () => {
    const r = review({ state: { index: 3, seen: [0, 1], mode: 'diff', messages: [] } })
    // index 3 is the third main step: s1, s2, d2 (2a), s3
    expect(progressLabel(r)).toBe('step 3 of 9')
    const r2 = review({ state: { index: 9, seen: [], mode: 'diff', messages: [] } })
    expect(progressLabel(r2)).toBe('step 9 of 9')
  })
  it('shows a detour label', () => {
    const r = review({ state: { index: 2, seen: [], mode: 'diff', messages: [] } })
    expect(progressLabel(r)).toBe('step 2a of 9')
  })
  it('is finished when every step has been seen', () => {
    const seen = steps().map((_, i) => i)
    expect(progressLabel(review({ state: { index: 4, seen, mode: 'diff', messages: [] } }))).toBe(
      'finished'
    )
  })
  it('is finished for a review with no steps', () => {
    const r = review()
    r.walkthrough.steps = []
    expect(progressLabel(r)).toBe('finished')
  })
})

describe('summarizeReview', () => {
  it('counts user messages as questions', () => {
    const r = review({
      state: {
        index: 0,
        seen: [],
        mode: 'diff',
        messages: [
          { id: '1', stepId: 's1', role: 'user', text: 'q' },
          { id: '2', stepId: 's1', role: 'assistant', text: 'a' },
          { id: '3', stepId: 's1', role: 'user', text: 'q2' }
        ]
      }
    })
    expect(summarizeReview(r, true).questions).toBe(2)
  })
  it('takes repoName from the last path segment', () => {
    const r = review()
    r.walkthrough.target = target({ repoPath: '/Users/x/projects/my-repo' })
    expect(summarizeReview(r, true).repoName).toBe('my-repo')
  })
  it('copies identity fields and repoFound', () => {
    const s = summarizeReview(review(), false)
    expect(s).toMatchObject({
      id: 'r1',
      title: 'Add thing',
      prNumber: 12,
      repoPath: '/repo',
      costUsd: 0.5,
      repoFound: false,
      target: target()
    })
  })
  it('reports newCommits as undefined, a count, or null', () => {
    const upd = (latestHeadSha: string, newCommits: number | null): ReviewUpdate => ({
      latestHeadSha,
      newCommits,
      checkedAt: 'now'
    })
    expect(summarizeReview(review({ update: upd('h1', 0) }), true).newCommits).toBeUndefined()
    expect(summarizeReview(review({ update: upd('h2', 3) }), true).newCommits).toBe(3)
    expect(summarizeReview(review({ update: upd('h2', null) }), true).newCommits).toBeNull()
    expect(summarizeReview(review(), true).newCommits).toBeUndefined()
  })
})

describe('hasNewCommits', () => {
  it('is true only when the latest head differs', () => {
    expect(hasNewCommits(review())).toBe(false)
    expect(
      hasNewCommits(review({ update: { latestHeadSha: 'h1', newCommits: 0, checkedAt: '' } }))
    ).toBe(false)
    expect(
      hasNewCommits(review({ update: { latestHeadSha: 'h2', newCommits: 1, checkedAt: '' } }))
    ).toBe(true)
  })
})

describe('isExpired', () => {
  const opened = Date.parse('2026-10-20T00:00:00.000Z')
  const week = REVIEW_RETENTION_DAYS * 24 * 60 * 60 * 1000
  it('is false just before 7 days and true just after', () => {
    const r = review({ lastOpenedAt: new Date(opened).toISOString() })
    expect(isExpired(r, opened + week - 1)).toBe(false)
    expect(isExpired(r, opened + week + 1)).toBe(true)
  })
})

describe('openRequestFor', () => {
  it('builds a github request', () => {
    expect(openRequestFor(target())).toEqual({ kind: 'github', repoPath: '/repo', pr: '12' })
  })
  it('builds a local request, omitting an undefined baseRef', () => {
    const t = target({ kind: 'local', prNumber: undefined, headRef: 'feat', baseRef: 'main' })
    expect(openRequestFor(t)).toEqual({
      kind: 'local',
      repoPath: '/repo',
      headRef: 'feat',
      baseRef: 'main'
    })
    const r = openRequestFor({ ...t, baseRef: undefined })
    expect(r).toEqual({ kind: 'local', repoPath: '/repo', headRef: 'feat' })
    expect('baseRef' in r).toBe(false)
  })
})

describe('SavedReviewSchema', () => {
  it('rejects an empty object', () => {
    expect(SavedReviewSchema.safeParse({}).success).toBe(false)
  })
  it('accepts a full review', () => {
    expect(SavedReviewSchema.safeParse(review()).success).toBe(true)
  })
  it('rejects a review whose steps are malformed', () => {
    const r = review()
    ;(r.walkthrough.steps as unknown[]).push({ id: 1 })
    expect(SavedReviewSchema.safeParse(r).success).toBe(false)
  })
})
