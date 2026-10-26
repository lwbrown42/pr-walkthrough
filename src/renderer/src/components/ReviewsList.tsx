import { useCallback, useEffect, useRef, useState } from 'react'
import {
  LIST_CHECK_CONCURRENCY,
  REVIEW_RETENTION_DAYS,
  type ReviewSummary,
  type ReviewUpdate,
  type SavedReview
} from '../../../shared/reviews'
import { relativeTime } from '../../../shared/relativeTime'

const UNDO_MS = 6000

export interface RowError {
  id: string
  message: string
  /** Offer Regenerate (the saved commit is gone). */
  regenerate?: boolean
}

interface Props {
  onReopen: (id: string) => void
  onRegenerate: (summary: ReviewSummary) => void
  onLoaded?: (count: number) => void
  rowError?: RowError
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function badgeText(newCommits: number | null): string {
  return newCommits ? plural(newCommits, 'new commit', 'new commits') : 'New commits'
}

export default function ReviewsList(props: Props): React.JSX.Element {
  const { onLoaded, rowError } = props
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  /** Update-check results by review id (null = checked, nothing found). */
  const [updates, setUpdates] = useState<Record<string, ReviewUpdate | null>>({})
  const [undo, setUndo] = useState<SavedReview>()
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      let list: ReviewSummary[]
      try {
        list = await window.api.listReviews()
      } catch {
        return
      }
      if (cancelled) return
      setReviews(list)
      onLoadedRef.current?.(list.length)
      const queue = list.filter((r) => r.repoFound)
      const worker = async (): Promise<void> => {
        for (let r = queue.shift(); r && !cancelled; r = queue.shift()) {
          try {
            const u = await window.api.checkReviewUpdates(r.id)
            if (!cancelled) setUpdates((cur) => ({ ...cur, [r.id]: u }))
          } catch {
            // Failures are silent.
          }
        }
      }
      await Promise.all(Array.from({ length: LIST_CHECK_CONCURRENCY }, worker))
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => clearTimeout(undoTimer.current), [])

  const remove = useCallback(async (id: string): Promise<void> => {
    setReviews((cur) => {
      const next = cur.filter((r) => r.id !== id)
      onLoadedRef.current?.(next.length)
      return next
    })
    const removed = await window.api.deleteReview(id)
    if (!removed) return
    setUndo(removed)
    clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setUndo(undefined), UNDO_MS)
  }, [])

  const restore = async (): Promise<void> => {
    if (!undo) return
    clearTimeout(undoTimer.current)
    const review = undo
    setUndo(undefined)
    await window.api.restoreReview(review)
    const list = await window.api.listReviews()
    setReviews(list)
    onLoadedRef.current?.(list.length)
  }

  const badgeFor = (r: ReviewSummary): string | undefined => {
    if (!(r.id in updates)) return r.newCommits === undefined ? undefined : badgeText(r.newCommits)
    const u = updates[r.id]
    return u && u.latestHeadSha !== r.target.headSha ? badgeText(u.newCommits) : undefined
  }

  const now = Date.now()

  return (
    <>
      {reviews.length > 0 && (
        <section className="reviews">
          <ul className="reviews-list">
            {reviews.map((r) => {
              const badge = badgeFor(r)
              const err = rowError?.id === r.id ? rowError : undefined
              const title = (
                <span className="review-title">
                  {r.title}
                  {r.prNumber !== undefined && <span className="muted"> #{r.prNumber}</span>}
                </span>
              )
              return (
                <li key={r.id} className="review-row">
                  {r.repoFound ? (
                    <button
                      type="button"
                      className="review-main"
                      onClick={() => props.onReopen(r.id)}
                    >
                      {title}
                      <span className="review-meta">
                        {r.repoName}
                        {r.baseRef && r.headRef ? (
                          <>
                            {' · '}
                            <code>{r.baseRef}</code> → <code>{r.headRef}</code>
                          </>
                        ) : r.headRef ? (
                          <>
                            {' · '}
                            <code>{r.headRef}</code>
                          </>
                        ) : null}
                        {` · ${r.progress} · ${plural(r.questions, 'question', 'questions')} · $${r.costUsd.toFixed(2)}`}
                      </span>
                    </button>
                  ) : (
                    <div className="review-main">
                      {title}
                      <span className="review-meta">{`Repository not found at ${r.repoPath}`}</span>
                    </div>
                  )}
                  <div className="review-side">
                    <span className="review-time">{relativeTime(r.lastOpenedAt, now)}</span>
                    {badge && <span className="review-badge">{badge}</span>}
                    <button
                      type="button"
                      className="review-trash"
                      aria-label="Delete review"
                      onClick={() => void remove(r.id)}
                    >
                      🗑
                    </button>
                  </div>
                  {err && (
                    <div className="review-error" role="alert">
                      <span>{err.message}</span>
                      {err.regenerate && (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => props.onRegenerate(r)}
                          >
                            Regenerate
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void remove(r.id)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="muted review-foot">
            {`Reviews are kept for ${REVIEW_RETENTION_DAYS} days after you last open them.`}
          </p>
        </section>
      )}
      {undo && (
        <div className="review-toast" role="status">
          <span>Review deleted</span>
          <button type="button" className="link" onClick={() => void restore()}>
            Undo
          </button>
        </div>
      )}
    </>
  )
}
