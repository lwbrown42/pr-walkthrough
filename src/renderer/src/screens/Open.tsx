import { useEffect, useState } from 'react'
import type { OpenRequest, OpenResult } from '../../../shared/api'
import { CHANGED_LINES_LIMIT } from '../../../shared/api'
import { relativeTime } from '../../../shared/relativeTime'
import type { ReviewSummary } from '../../../shared/reviews'
import ReviewsList, { type RowError } from '../components/ReviewsList'
import { friendlyError } from '../errors'

interface Props {
  lastRepoPath?: string
  /** Set after a successful open (kept when generation fails, so Retry works). */
  opened?: OpenResult
  error?: string
  onOpened: (r: OpenResult) => void
  /** The repo, ref or tab changed, so the opened result (if any) is stale. */
  onInputsChanged: () => void
  onGenerate: () => void
  onSettings: () => void
  onUsage: () => void
  onReopen: (id: string) => void
  onRegenerateReview: (summary: ReviewSummary) => void
  rowError?: RowError
}

type Tab = 'local' | 'github'

function savedPrompt(saved: NonNullable<OpenResult['saved']>): string {
  const base = `You have a saved review of this PR (${saved.progress}, ${relativeTime(saved.lastOpenedAt, Date.now())})`
  const n = saved.newCommits
  if (!n) return base
  return `${base} · ${n === 1 ? '1 new commit' : `${n} new commits`} since`
}

export default function Open(props: Props): React.JSX.Element {
  const { opened, error } = props
  const [repoPath, setRepoPath] = useState(props.lastRepoPath ?? '')
  const [tab, setTab] = useState<Tab>('local')
  const [headRef, setHeadRef] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [pr, setPr] = useState('')
  const [busy, setBusy] = useState(false)
  const [openError, setOpenError] = useState<string>()
  const [reviewCount, setReviewCount] = useState(0)

  useEffect(() => {
    if (props.lastRepoPath) setRepoPath((cur) => cur || props.lastRepoPath!)
  }, [props.lastRepoPath])

  const pick = async (): Promise<void> => {
    const p = await window.api.pickRepo()
    if (p) {
      setRepoPath(p)
      props.onInputsChanged()
    }
  }

  const edit =
    (set: (v: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      set(e.target.value)
      props.onInputsChanged()
    }

  const switchTab = (t: Tab): void => {
    if (t === tab) return
    setTab(t)
    props.onInputsChanged()
  }

  const canOpen = repoPath !== '' && (tab === 'local' ? headRef.trim() !== '' : pr.trim() !== '')

  const open = async (): Promise<void> => {
    const req: OpenRequest =
      tab === 'local'
        ? {
            kind: 'local',
            repoPath,
            headRef: headRef.trim(),
            ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {})
          }
        : { kind: 'github', repoPath, pr: pr.trim() }
    setBusy(true)
    setOpenError(undefined)
    try {
      const res = await window.api.openTarget(req)
      if ('error' in res) setOpenError(friendlyError(res.error))
      else props.onOpened(res)
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const shownError = error ?? openError

  return (
    <div className="screen">
      <div className="row between">
        <h1>{reviewCount > 0 ? 'Reviews' : 'Open a change'}</h1>
        <div className="row">
          <button type="button" className="link" onClick={props.onUsage}>
            Usage
          </button>
          <button type="button" className="link" onClick={props.onSettings}>
            Settings
          </button>
        </div>
      </div>

      <ReviewsList
        onReopen={props.onReopen}
        onRegenerate={props.onRegenerateReview}
        onLoaded={setReviewCount}
        rowError={props.rowError}
      />
      {reviewCount > 0 && <h2>Start a new review</h2>}

      <label>
        Repository folder
        <div className="row">
          <input value={repoPath} readOnly placeholder="No folder selected" />
          <button type="button" onClick={pick}>
            Pick…
          </button>
        </div>
      </label>

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'local'}
          className={tab === 'local' ? 'active' : ''}
          onClick={() => switchTab('local')}
        >
          Local branch
        </button>
        <button
          role="tab"
          aria-selected={tab === 'github'}
          className={tab === 'github' ? 'active' : ''}
          onClick={() => switchTab('github')}
        >
          GitHub PR
        </button>
      </div>

      {tab === 'local' ? (
        <>
          <label>
            Head ref
            <input value={headRef} onChange={edit(setHeadRef)} />
          </label>
          <label>
            Base ref (optional)
            <input value={baseRef} onChange={edit(setBaseRef)} />
          </label>
        </>
      ) : (
        <label>
          PR number or URL
          <input value={pr} onChange={edit(setPr)} />
        </label>
      )}

      <div className="row">
        <button type="button" disabled={!canOpen || busy} onClick={open}>
          {busy ? 'Opening…' : 'Open'}
        </button>
      </div>

      {opened && (
        <div className="panel">
          <p>
            {opened.files.length} files, {opened.changedLines} changed lines
          </p>
          {opened.overLimit && (
            <p className="warning">
              {`This PR has ${opened.changedLines} changed lines, above the ${CHANGED_LINES_LIMIT.toLocaleString('en-US')} line limit. The walkthrough may be slower or less accurate.`}
            </p>
          )}
          {opened.saved ? (
            <>
              <p>{savedPrompt(opened.saved)}</p>
              <div className="row">
                <button type="button" onClick={() => props.onReopen(opened.saved!.id)}>
                  Reopen saved review
                </button>
                <button type="button" className="secondary" onClick={props.onGenerate}>
                  Generate a new one
                </button>
              </div>
            </>
          ) : (
            <div className="row">
              <button type="button" onClick={props.onGenerate}>
                Generate
              </button>
            </div>
          )}
        </div>
      )}

      {shownError && (
        <div className="error" role="alert">
          <p>{shownError}</p>
          {error && opened && (
            <button type="button" onClick={props.onGenerate}>
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}
