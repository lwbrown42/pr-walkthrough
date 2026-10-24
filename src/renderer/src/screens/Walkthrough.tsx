import { useEffect, useState } from 'react'
import type { ChatMessage } from '../../../shared/types'
import { labelSteps } from '../../../shared/stepLabels'
import type { Walkthrough as WalkthroughData } from '../../../shared/walkthrough'
import ChatPanel from '../components/ChatPanel'
import CodePane from '../components/CodePane'
import ExplanationPanel from '../components/ExplanationPanel'
import StepsList from '../components/StepsList'
import Usage from './Usage'

interface Props {
  walkthrough: WalkthroughData
  onExit: () => void
}

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

export default function Walkthrough({ walkthrough, onExit }: Props): React.JSX.Element {
  const { steps, target, files } = walkthrough
  const [index, setIndex] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [mode, setMode] = useState<'diff' | 'plain'>('diff')
  const [usageOpen, setUsageOpen] = useState(false)
  const [reviewCost, setReviewCost] = useState<number>()

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
      if (isTextTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
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
          <button type="button" onClick={() => setUsageOpen(true)}>
            Usage
          </button>
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
          <button type="button" onClick={onExit}>
            New review
          </button>
        </div>
      </header>
      <div className="columns">
        <StepsList steps={steps} currentIndex={index} onSelect={setIndex} />
        <main className="code-column">
          <CodePane step={step} files={files} target={target} mode={mode} />
        </main>
        <aside className="right-column">
          <ExplanationPanel
            step={step}
            label={labels[index]}
            mainCount={mainCount}
            detourFrom={labels[index].match(/^(\d+)[a-z]+$/)?.[1]}
          />
          <ChatPanel
            stepId={step.id}
            steps={steps}
            messages={messages}
            onAppend={(m) => setMessages((prev) => [...prev, m])}
          />
        </aside>
      </div>
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
