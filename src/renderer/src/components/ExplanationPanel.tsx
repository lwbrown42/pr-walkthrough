import type { Step } from '../../../shared/walkthrough'
import InlineCode from './InlineCode'

interface Props {
  step: Step
  /** e.g. '2' or '1a' */
  label: string
  /** Number of main steps. */
  mainCount: number
  /** Label of the main step this one is a detour from, if it is one. */
  detourFrom?: string
}

export default function ExplanationPanel({
  step,
  label,
  mainCount,
  detourFrom
}: Props): React.JSX.Element {
  return (
    <section className="explanation">
      <p className="muted">
        Step {label} of {mainCount}
        {detourFrom && <span className="detour-tag"> · Detour from step {detourFrom}</span>}
      </p>
      <h2>
        <InlineCode text={step.title} />
      </h2>
      {step.whyNext && (
        <p className="muted why-next">
          <InlineCode text={step.whyNext} />
        </p>
      )}
      <div className="explanation-text">
        {step.explanation
          .split(/\n\s*\n/)
          .map((para) => para.trim())
          .filter((para) => para !== '')
          .map((para, i) => (
            <p key={i}>
              <InlineCode text={para} />
            </p>
          ))}
      </div>
    </section>
  )
}
