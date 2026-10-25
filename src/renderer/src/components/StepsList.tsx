import { useEffect, useRef } from 'react'
import type { ChangedFile } from '../../../shared/types'
import type { Step } from '../../../shared/walkthrough'
import { labelSteps } from '../../../shared/stepLabels'
import InlineCode from './InlineCode'
import { summarizeFiles } from './segmentView'

interface Props {
  steps: Step[]
  files: ChangedFile[]
  currentIndex: number
  /** Indexes of steps the reader has opened. */
  seen: ReadonlySet<number>
  onSelect: (index: number) => void
}

/** The id normalize.ts gives the trailing catch-all step. */
const EVERYTHING_ELSE_ID = 'everything-else'

export default function StepsList({
  steps,
  files,
  currentIndex,
  seen,
  onSelect
}: Props): React.JSX.Element {
  const currentRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [currentIndex])

  const { labels } = labelSteps(steps)
  return (
    <nav className="steps-list" aria-label="Steps">
      <ol>
        {steps.map((s, i) => {
          const current = i === currentIndex
          const detour = /[a-z]$/.test(labels[i])
          const rest = s.id === EVERYTHING_ELSE_ID
          return (
            <li key={s.id} className={rest ? 'everything-else' : undefined}>
              <button
                type="button"
                ref={current ? currentRef : undefined}
                className={`step-item${current ? ' current' : ''}${detour ? ' detour' : ''}`}
                data-detour={detour ? 'true' : undefined}
                aria-current={current ? 'step' : undefined}
                onClick={() => onSelect(i)}
              >
                <span className="step-num">{labels[i]}</span>
                <span className="step-title">
                  <InlineCode text={s.title} />
                  {rest && s.segments.length > 0 && (
                    <span className="step-summary">{summarizeFiles(s, files)}</span>
                  )}
                </span>
                {seen.has(i) && !current && (
                  <svg
                    className="step-seen"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    role="img"
                    aria-label="viewed"
                  >
                    <path d="M3 8.5l3 3 7-7" />
                  </svg>
                )}
              </button>
            </li>
          )
        })}
      </ol>
      <p className="steps-hint">J / K or ↑ ↓ to move</p>
    </nav>
  )
}
