import { useEffect, useRef, useState } from 'react'
import type { GenerateProgressEvent, OpenResult } from '../../../shared/api'
import type { GenerateStage } from '../../../shared/progress'
import type { SavedReview } from '../../../shared/reviews'
import { friendlyError } from '../errors'

interface Props {
  opened: OpenResult
  /** The run's caps, shown so the reader can see a run nearing one. */
  limits: { maxTurns: number; maxBudgetUsd: number }
  onDone: (review: SavedReview) => void
  onError: (message: string) => void
  /** The reviewer cancelled; not an error. */
  onCancelled: () => void
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const STAGES: { id: GenerateStage; name: string }[] = [
  { id: 'reading', name: 'Reading the PR' },
  { id: 'writing', name: 'Writing the steps' },
  { id: 'finishing', name: 'Final checks' }
]

const INITIAL: GenerateProgressEvent = {
  stage: 'reading',
  turns: 0,
  filesTotal: 0,
  lookups: 0,
  activity: [],
  stepTitles: [],
  elapsedMs: 0
}

const shortSha = (sha: string): string => sha.slice(0, 7)

export default function Generating({
  opened,
  limits,
  onDone,
  onError,
  onCancelled
}: Props): React.JSX.Element {
  const { target } = opened
  const [progress, setProgress] = useState<GenerateProgressEvent>(INITIAL)
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

  const current = STAGES.findIndex((st) => st.id === progress.stage)
  const filesTotal = progress.filesTotal || opened.files.length
  const filesLine = `${filesTotal} changed files · ${progress.lookups} lookups`

  return (
    <div className="screen generating">
      <h1>
        <span className="pulse" aria-hidden="true" />
        Building your walkthrough
      </h1>
      <p className="muted generating-target">
        <span>{target.title}</span> · <code>{shortSha(target.baseSha)}</code> →{' '}
        <code>{shortSha(target.headSha)}</code> · {opened.files.length} files ·{' '}
        {opened.changedLines} lines
      </p>

      <ol className="stages">
        {STAGES.map((st, i) => {
          const state = i < current ? 'done' : i === current ? 'active' : 'pending'
          return (
            <li key={st.id} className={`stage ${state}`} data-state={state} aria-label={st.name}>
              <span className="stage-dot" aria-hidden="true" />
              <span className="stage-name">{st.name}</span>
              <span className="stage-count">
                {st.id === 'reading' && filesLine}
                {st.id === 'writing' &&
                  (state === 'active'
                    ? `step ${progress.stepTitles.length + 1}…`
                    : state === 'done'
                      ? `${progress.stepTitles.length} steps`
                      : '')}
              </span>
              {st.id === 'reading' && state === 'active' && (
                <div className="stage-detail">
                  {progress.activity.length > 0 && (
                    <ul className="activity">
                      {progress.activity.map((a, j) => (
                        <li key={j}>
                          {a.verb}
                          {a.target && (
                            <>
                              {' '}
                              <code>{a.target}</code>
                            </>
                          )}
                          {a.sections && a.sections > 1 && (
                            <span className="muted"> · {a.sections} sections</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {st.id === 'writing' && state === 'active' && progress.stepTitles.length > 0 && (
                <div className="stage-detail">
                  <ul className="step-titles">
                    {[...progress.stepTitles].reverse().map((t, j) => (
                      <li
                        key={progress.stepTitles.length - j}
                        className={j === 0 ? 'latest' : undefined}
                      >
                        {t}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      <div className="generating-meters">
        <span>
          Elapsed <b>{formatElapsed(Math.max(progress.elapsedMs, now - startedAt))}</b>
        </span>
        <span>
          Turns <b>{progress.turns}</b> / {limits.maxTurns}
        </span>
        <span>
          Budget cap <b>${limits.maxBudgetUsd.toFixed(2)}</b>
        </span>
      </div>

      <div className="row generating-actions">
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
