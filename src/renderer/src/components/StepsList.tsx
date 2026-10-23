import { useEffect, useRef } from 'react'
import type { Step } from '../../../shared/walkthrough'

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

  return (
    <nav className="steps-list" aria-label="Steps">
      <ol>
        {steps.map((s, i) => {
          const current = i === currentIndex
          return (
            <li key={s.id}>
              <button
                type="button"
                ref={current ? currentRef : undefined}
                className={`step-item${current ? ' current' : ''}${s.parentId ? ' indented' : ''}`}
                data-indented={s.parentId ? 'true' : 'false'}
                aria-current={current ? 'step' : undefined}
                onClick={() => onSelect(i)}
              >
                <span className="step-num">{i + 1}.</span> {s.title}
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
