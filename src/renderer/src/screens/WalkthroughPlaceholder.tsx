import type { Walkthrough } from '../../../shared/walkthrough'

/** Temporary; replaced by the real walkthrough view in Task 10. */
export default function WalkthroughPlaceholder({
  walkthrough
}: {
  walkthrough: Walkthrough
}): React.JSX.Element {
  return (
    <div className="screen">
      <h1>{walkthrough.target.title}</h1>
      <ul>
        {walkthrough.steps.map((s) => (
          <li key={s.id}>{s.title}</li>
        ))}
      </ul>
    </div>
  )
}
