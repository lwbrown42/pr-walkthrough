import { useEffect, useRef, useState } from 'react'
import type { GenerateProgressEvent } from '../../../shared/api'
import type { ReviewTarget } from '../../../shared/types'
import type { Walkthrough } from '../../../shared/walkthrough'
import { friendlyError } from '../errors'

interface Props {
  target: ReviewTarget
  onDone: (w: Walkthrough) => void
  onError: (message: string) => void
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function Generating({ target, onDone, onError }: Props): React.JSX.Element {
  const [progress, setProgress] = useState<GenerateProgressEvent>({ turns: 0, elapsedMs: 0 })
  const started = useRef(false)
  const cbs = useRef({ onDone, onError })
  cbs.current = { onDone, onError }

  useEffect(() => window.api.onGenerateProgress(setProgress), [])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void window.api.generate(target).then((res) => {
      if ('error' in res) cbs.current.onError(friendlyError(res.error))
      else cbs.current.onDone(res)
    })
  }, [target])

  return (
    <div className="screen">
      <h1>Generating walkthrough…</h1>
      <p className="muted">{target.title}</p>
      <dl className="stats">
        <dt>Elapsed</dt>
        <dd>{formatElapsed(progress.elapsedMs)}</dd>
        <dt>Turns</dt>
        <dd>{progress.turns}</dd>
        <dt>Last tool</dt>
        <dd>{progress.lastTool ?? '—'}</dd>
      </dl>
    </div>
  )
}
