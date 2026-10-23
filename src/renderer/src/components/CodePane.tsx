import type { ChangedFile, ReviewTarget } from '../../../shared/types'
import type { Step } from '../../../shared/walkthrough'

interface Props {
  step: Step
  files: ChangedFile[]
  target: ReviewTarget
  mode: 'diff' | 'plain'
}

/** Placeholder; Task 11 replaces the internals. */
export default function CodePane({ step, mode }: Props): React.JSX.Element {
  return (
    <div className="code-pane" data-mode={mode}>
      <ul>
        {step.segments.map((s, i) => (
          <li key={i}>
            {s.path} {s.startLine}-{s.endLine} ({s.kind})
          </li>
        ))}
      </ul>
    </div>
  )
}
