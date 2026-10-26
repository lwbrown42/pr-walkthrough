import { z } from 'zod'
import type { OpenRequest } from './api'
import { labelSteps } from './stepLabels'
import type { ChatMessage, ReviewTarget } from './types'
import { Step, type Walkthrough } from './walkthrough'

export const REVIEW_RETENTION_DAYS = 7

export type CodeMode = 'diff' | 'plain'

export interface ReviewState {
  index: number
  seen: number[]
  mode: CodeMode
  messages: ChatMessage[]
}

export interface ReviewUpdate {
  latestHeadSha: string
  newCommits: number | null
  checkedAt: string
}

export interface SavedReview {
  id: string
  key: string
  walkthrough: Walkthrough
  state: ReviewState
  createdAt: string
  generatedAt: string
  lastOpenedAt: string
  costUsd: number
  update?: ReviewUpdate
}

const MessageSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string()
})

const UpdateSchema = z.object({
  latestHeadSha: z.string(),
  newCommits: z.number().nullable(),
  checkedAt: z.string()
})

/** Structural check only: steps are fully validated, target and files are checked as objects. */
export const SavedReviewSchema = z.object({
  id: z.string(),
  key: z.string(),
  walkthrough: z.looseObject({
    summary: z.string(),
    steps: z.array(Step),
    target: z.looseObject({}),
    files: z.array(z.looseObject({})),
    changedLines: z.number(),
    sessionId: z.string(),
    chatSessionId: z.string().optional()
  }),
  state: z.object({
    index: z.number(),
    seen: z.array(z.number()),
    mode: z.enum(['diff', 'plain']),
    messages: z.array(MessageSchema)
  }),
  createdAt: z.string(),
  generatedAt: z.string(),
  lastOpenedAt: z.string(),
  costUsd: z.number(),
  update: UpdateSchema.optional()
}) as unknown as z.ZodType<SavedReview>

export interface ReviewSummary {
  id: string
  title: string
  prNumber?: number
  repoName: string
  repoPath: string
  baseRef?: string
  headRef?: string
  /** "step 4 of 9" | "step 2a of 9" | "finished" */
  progress: string
  questions: number
  costUsd: number
  lastOpenedAt: string
  /** undefined = up to date / never checked; null = moved, count unknown */
  newCommits: number | null | undefined
  repoFound: boolean
  /** For Regenerate from a row. */
  target: ReviewTarget
}

/** One review per repo + kind + (PR number | head ref). */
export function reviewKey(target: ReviewTarget): string {
  const id =
    target.kind === 'github' && target.prNumber !== undefined
      ? String(target.prNumber)
      : (target.headRef ?? target.title)
  return `${target.repoPath}|${target.kind}|${id}`
}

export function progressLabel(review: SavedReview): string {
  const { steps } = review.walkthrough
  const { seen, index } = review.state
  const seenSet = new Set(seen)
  if (steps.every((_, i) => seenSet.has(i))) return 'finished'
  const { labels, mainCount } = labelSteps(steps)
  return `step ${labels[index] ?? labels[labels.length - 1]} of ${mainCount}`
}

export function hasNewCommits(review: SavedReview): boolean {
  return (
    review.update !== undefined && review.update.latestHeadSha !== review.walkthrough.target.headSha
  )
}

export function summarizeReview(review: SavedReview, repoFound: boolean): ReviewSummary {
  const { target } = review.walkthrough
  const segments = target.repoPath.split(/[\\/]/).filter(Boolean)
  return {
    id: review.id,
    title: target.title,
    prNumber: target.prNumber,
    repoName: segments[segments.length - 1] ?? target.repoPath,
    repoPath: target.repoPath,
    baseRef: target.baseRef,
    headRef: target.headRef,
    progress: progressLabel(review),
    questions: review.state.messages.filter((m) => m.role === 'user').length,
    costUsd: review.costUsd,
    lastOpenedAt: review.lastOpenedAt,
    newCommits: hasNewCommits(review) ? review.update!.newCommits : undefined,
    repoFound,
    target
  }
}

export function isExpired(review: SavedReview, now: number): boolean {
  return now - Date.parse(review.lastOpenedAt) > REVIEW_RETENTION_DAYS * 24 * 60 * 60 * 1000
}

export function openRequestFor(target: ReviewTarget): OpenRequest {
  if (target.kind === 'github') {
    return { kind: 'github', repoPath: target.repoPath, pr: String(target.prNumber) }
  }
  const req: OpenRequest = {
    kind: 'local',
    repoPath: target.repoPath,
    headRef: target.headRef ?? ''
  }
  if (target.baseRef !== undefined) req.baseRef = target.baseRef
  return req
}

/** How many update checks the reviews list runs at once. */
export const LIST_CHECK_CONCURRENCY = 2

/** How long the walkthrough waits after the last position change before saving it. */
export const SAVE_DEBOUNCE_MS = 500

/** How often an open review checks its branch for new commits. */
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000
