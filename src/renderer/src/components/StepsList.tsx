import { useEffect, useRef } from 'react'
import type { Step } from '../../../shared/walkthrough'
import { labelSteps } from '../../../shared/stepLabels'

interface Props {
  steps: Step[]
  currentIndex: number
  onSelect: (index: number) => void
}

export default function StepsList({ steps, currentIndex, onSelect }: Props): React.JSX.Element {
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
          return (
            <li key={s.id}>
              <button
                type="button"
                ref={current ? currentRef : undefined}
                className={`step-item${current ? ' current' : ''}${detour ? ' detour' : ''}`}
                data-detour={detour ? 'true' : undefined}
                aria-current={current ? 'step' : undefined}
                onClick={() => onSelect(i)}
              >
                <span className="step-num">{labels[i]}.</span>
                <span className="step-title">{s.title}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
