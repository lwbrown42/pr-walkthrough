import { useEffect, useRef, useState } from 'react'
import type { GenerateProgressEvent } from '../../../shared/api'
import type { ReviewTarget } from '../../../shared/types'
import type { Walkthrough } from '../../../shared/walkthrough'
import { friendlyError } from '../errors'

interface Props {
  target: ReviewTarget
  onDone: (w: Walkthrough) => void
  onError: (message: string) => void
  /** The reviewer cancelled; not an error. */
  onCancelled: () => void
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function Generating({
  target,
  onDone,
  onError,
  onCancelled
}: Props): React.JSX.Element {
  const [progress, setProgress] = useState<GenerateProgressEvent>({ turns: 0, elapsedMs: 0 })
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  const [cancelling, setCancelling] = useState(false)
  const started = useRef(false)
  const cbs = useRef({ onDone, onError, onCancelled })
  cbs.current = { onDone, onError, onCancelled }

  useEffect(() => window.api.onGenerateProgress(setProgress), [])

  // Progress events only arrive per agent turn; tick locally so the clock never looks stuck.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (started.current) return
    started.current = true
    window.api
      .generate(target)
      .then((res) => {
        if ('error' in res) {
          if (res.error.reason === 'cancelled') cbs.current.onCancelled()
          else cbs.current.onError(friendlyError(res.error))
        } else cbs.current.onDone(res)
      })
      .catch((e: unknown) => cbs.current.onError(e instanceof Error ? e.message : String(e)))
  }, [target])

  return (
    <div className="screen">
      <h1>Generating walkthrough…</h1>
      <p className="muted">{target.title}</p>
      <dl className="stats">
        <dt>Elapsed</dt>
        <dd>{formatElapsed(Math.max(progress.elapsedMs, now - startedAt))}</dd>
        <dt>Turns</dt>
        <dd>{progress.turns}</dd>
        <dt>Last tool</dt>
        <dd>{progress.lastTool ?? '—'}</dd>
      </dl>
      <div className="row">
        <button
          type="button"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true)
            void window.api.cancelGenerate()
          }}
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </div>
    </div>
  )
}
