import type { Step } from '../../../shared/walkthrough'

interface Props {
  step: Step
  index: number
  total: number
}

export default function ExplanationPanel({ step, index, total }: Props): React.JSX.Element {
  return (
    <section className="explanation">
      <p className="muted">
        Step {index + 1} of {total}
      </p>
      <h2>{step.title}</h2>
      {step.whyNext && <p className="muted why-next">{step.whyNext}</p>}
      <p className="explanation-text">{step.explanation}</p>
    </section>
  )
}
