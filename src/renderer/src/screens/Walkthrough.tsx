import { useEffect, useRef, useState } from 'react'
import {
  hasNewCommits,
  SAVE_DEBOUNCE_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type ReviewState,
  type ReviewUpdate,
  type SavedReview
} from '../../../shared/reviews'
import type { ChatMessage } from '../../../shared/types'
import { labelSteps } from '../../../shared/stepLabels'
import type { Walkthrough as WalkthroughData } from '../../../shared/walkthrough'
import ChatPanel from '../components/ChatPanel'
import CodePane from '../components/CodePane'
import ExplanationPanel from '../components/ExplanationPanel'
import ResizableLayout from '../components/ResizableLayout'
import StepsList from '../components/StepsList'
import FileBar from '../components/FileBar'
import Usage from './Usage'

interface Props {
  walkthrough: WalkthroughData
  /** The saved review being read. Without it (the fixture) nothing is saved or checked. */
  review?: SavedReview
  /** An error line shown in the banner slot, e.g. "Regenerate failed: …". */
  notice?: string
  onExit: () => void
  onRegenerate?: (review: SavedReview) => void
}

function commitsLabel(count: number | null | undefined): string {
  if (count === 1) return '1 new commit since this walkthrough'
  if (count) return `${count} new commits since this walkthrough`
  return 'New commits since this walkthrough'
}

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

/** A focused resize handle uses the arrow keys itself. */
function isResizeHandle(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.getAttribute('role') === 'separator'
}

export default function Walkthrough({
  walkthrough,
  review,
  notice,
  onExit,
  onRegenerate
}: Props): React.JSX.Element {
  const { steps, target, files } = walkthrough
  const saved = review?.state
  const reviewId = review?.id
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(saved?.index ?? 0, 0), Math.max(steps.length - 1, 0))
  )
  const [messages, setMessages] = useState<ChatMessage[]>(() => saved?.messages ?? [])
  const [mode, setMode] = useState<'diff' | 'plain'>(() => saved?.mode ?? 'diff')
  const [usageOpen, setUsageOpen] = useState(false)
  const [openPrError, setOpenPrError] = useState<string | null>(null)
  const [reviewCost, setReviewCost] = useState<number>()
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set(saved?.seen ?? [0]))
  const [update, setUpdate] = useState<ReviewUpdate>()
  const [confirming, setConfirming] = useState(false)
  const codeRef = useRef<HTMLDivElement>(null)

  // A step counts as seen once opened (set during render, so no extra effect pass).
  if (!seen.has(index)) setSeen(new Set(seen).add(index))

  // Autosave. Refs let the debounced and unmount saves see the latest state.
  const latest = useRef<ReviewState>({ index, seen: [...seen], mode, messages })
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastPosition = useRef({ index, seen, mode })
  const lastMessages = useRef(messages)
  const saver = useRef({
    now(): void {
      clearTimeout(pending.current)
      pending.current = undefined
      if (reviewId === undefined) return
      window.api.saveReviewState({ id: reviewId, state: latest.current }).catch(() => {})
    },
    flush(): void {
      if (pending.current !== undefined) this.now()
    }
  })

  useEffect(() => {
    latest.current = { index, seen: [...seen], mode, messages }
  })

  useEffect(() => {
    const last = lastPosition.current
    if (last.index === index && last.seen === seen && last.mode === mode) return
    lastPosition.current = { index, seen, mode }
    if (reviewId === undefined) return
    clearTimeout(pending.current)
    pending.current = setTimeout(() => saver.current.now(), SAVE_DEBOUNCE_MS)
  }, [index, seen, mode, reviewId])

  useEffect(() => {
    if (lastMessages.current === messages) return
    lastMessages.current = messages
    saver.current.now()
  }, [messages])

  useEffect(() => {
    const s = saver.current
    return () => s.flush()
  }, [])

  // Update checks: on open and every few minutes. Failures are silent.
  useEffect(() => {
    if (reviewId === undefined) return
    let cancelled = false
    const check = (): void => {
      window.api
        .checkReviewUpdates(reviewId)
        .then((u) => !cancelled && u && setUpdate(u))
        .catch(() => {})
    }
    check()
    const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [reviewId])

  const moved = update
    ? update.latestHeadSha !== target.headSha
    : review !== undefined && hasNewCommits(review)
  const commitCount = update ? update.newCommits : review?.update?.newCommits

  // Each step starts at the top of its code.
  useEffect(() => {
    if (codeRef.current) codeRef.current.scrollTop = 0
  }, [index])

  // Refresh after each chat answer (every answer adds a message).
  useEffect(() => {
    let cancelled = false
    window.api
      .getReviewUsage()
      .then((u) => !cancelled && setReviewCost(u.costUsd))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [messages.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (usageOpen) {
        if (e.key === 'Escape') setUsageOpen(false)
        return
      }
      if (isTextTarget(e.target) || isResizeHandle(e.target) || e.metaKey || e.ctrlKey || e.altKey)
        return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => Math.min(i + 1, steps.length - 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => Math.max(i - 1, 0))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [steps.length, usageOpen])

  const step = steps[index]
  const jumpTo = (i: number): void =>
    document.getElementById(`segment-${i}`)?.scrollIntoView?.({ block: 'start' })
  const { labels, mainCount } = labelSteps(steps)
  if (!step) return <div className="screen">No steps.</div>

  return (
    <div className="walkthrough">
      <header className="topbar">
        <h1>{target.title}</h1>
        <div className="topbar-actions">
          {reviewCost !== undefined && (
            <span className="review-cost muted">This review: ${reviewCost.toFixed(2)}</span>
          )}
          {target.kind === 'github' && (
            <button
              type="button"
              className="link"
              onClick={() => {
                setOpenPrError(null)
                void window.api.openPr().then((r) => {
                  if (r && 'error' in r) setOpenPrError(r.error.message)
                })
              }}
            >
              View on GitHub
            </button>
          )}
          <button type="button" className="link" onClick={() => setUsageOpen(true)}>
            Usage
          </button>
          <button type="button" className="secondary" onClick={onExit}>
            New review
          </button>
        </div>
      </header>
      {notice && (
        <div className="banner banner-error" role="alert">
          {notice}
        </div>
      )}
      {openPrError && (
        <div className="banner banner-error" role="alert">
          Couldn&apos;t open the PR: {openPrError}
        </div>
      )}
      {moved && review && (
        <div className="banner">
          {confirming ? (
            <>
              <span>Regenerate? This replaces the current walkthrough and its chat.</span>
              <button
                type="button"
                onClick={() => {
                  saver.current.flush()
                  onRegenerate?.(review)
                }}
              >
                Regenerate
              </button>
              <button type="button" className="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span>{commitsLabel(commitCount)}</span>
              {onRegenerate && (
                <button type="button" className="link" onClick={() => setConfirming(true)}>
                  Regenerate
                </button>
              )}
            </>
          )}
        </div>
      )}
      <ResizableLayout
        steps={
          <StepsList
            steps={steps}
            files={files}
            currentIndex={index}
            seen={seen}
            onSelect={setIndex}
          />
        }
        code={
          <main className="code-column">
            <div className="code-toolbar">
              <FileBar segments={step.segments} onJump={jumpTo} />
              <div className="toggle" role="group" aria-label="Code view">
                {(['diff', 'plain'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    className={mode === m ? 'active' : undefined}
                    onClick={() => setMode(m)}
                  >
                    {m === 'diff' ? 'Diff' : 'Plain'}
                  </button>
                ))}
              </div>
            </div>
            <div className="code-scroll" ref={codeRef}>
              <CodePane step={step} files={files} target={target} mode={mode} />
            </div>
          </main>
        }
        explanation={
          <ExplanationPanel
            step={step}
            label={labels[index]}
            mainCount={mainCount}
            detourFrom={labels[index].match(/^(\d+)[a-z]+$/)?.[1]}
          />
        }
        chat={
          <ChatPanel
            stepId={step.id}
            steps={steps}
            messages={messages}
            onAppend={(m) => setMessages((prev) => [...prev, m])}
          />
        }
      />
      {usageOpen && (
        <div className="overlay" onClick={() => setUsageOpen(false)}>
          <div
            className="overlay-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Usage"
            onClick={(e) => e.stopPropagation()}
          >
            <Usage onBack={() => setUsageOpen(false)} backLabel="Close" />
          </div>
        </div>
      )}
    </div>
  )
}
