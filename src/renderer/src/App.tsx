import { useEffect, useState } from 'react'
import type { OpenResult, PublicSettings } from '../../shared/api'
import { openRequestFor, type ReviewSummary, type SavedReview } from '../../shared/reviews'
import type { RowError } from './components/ReviewsList'
import { friendlyError } from './errors'
import type { Walkthrough as WalkthroughData } from '../../shared/walkthrough'
import Generating from './screens/Generating'
import Open from './screens/Open'
import Setup from './screens/Setup'
import Usage from './screens/Usage'
import WalkthroughScreen from './screens/Walkthrough'

type State =
  | { screen: 'setup' }
  | { screen: 'open'; opened?: OpenResult; error?: string; rowError?: RowError }
  /** returnTo: the review a walkthrough Regenerate came from; cancel or failure goes back to it. */
  | { screen: 'generating'; opened: OpenResult; returnTo?: string }
  | { screen: 'walkthrough'; walkthrough: WalkthroughData; review?: SavedReview; notice?: string }
  | { screen: 'usage' }

function App(): React.JSX.Element | null {
  const [settings, setSettings] = useState<PublicSettings>()
  const [loadError, setLoadError] = useState<string>()
  const [state, setState] = useState<State>({ screen: 'setup' })

  const load = async (): Promise<PublicSettings> => {
    const s = await window.api.getSettings()
    setSettings(s)
    return s
  }

  const init = (): void => {
    setLoadError(undefined)
    load()
      .then(async (s) => {
        const fixture = await window.api.getFixture()
        if (fixture) setState({ screen: 'walkthrough', walkthrough: fixture })
        else setState(s.hasApiKey ? { screen: 'open' } : { screen: 'setup' })
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(init, [])

  const rowFail = (id: string, e: { message: string; reason?: string }): void =>
    setState({
      screen: 'open',
      rowError: { id, message: e.message, regenerate: e.reason === 'missing_commit' }
    })

  const reopen = async (id: string): Promise<void> => {
    try {
      const r = await window.api.reopenReview(id)
      if ('error' in r) rowFail(id, r.error)
      else setState({ screen: 'walkthrough', walkthrough: r.walkthrough, review: r })
    } catch (e) {
      rowFail(id, { message: e instanceof Error ? e.message : String(e) })
    }
  }

  const regenerateFromRow = async (summary: ReviewSummary): Promise<void> => {
    try {
      const opened = await window.api.openTarget(openRequestFor(summary.target))
      if ('error' in opened) rowFail(summary.id, { message: friendlyError(opened.error) })
      else setState({ screen: 'generating', opened })
    } catch (e) {
      rowFail(summary.id, { message: e instanceof Error ? e.message : String(e) })
    }
  }

  const regenerateFromWalkthrough = async (review: SavedReview): Promise<void> => {
    const fail = (message: string): void =>
      setState({
        screen: 'walkthrough',
        walkthrough: review.walkthrough,
        review,
        notice: `Regenerate failed: ${message}`
      })
    try {
      const opened = await window.api.openTarget(openRequestFor(review.walkthrough.target))
      if ('error' in opened) fail(friendlyError(opened.error))
      else setState({ screen: 'generating', opened, returnTo: review.id })
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e))
    }
  }

  /** Back to the review a Regenerate came from; to Open if it can't be reopened. */
  const returnToReview = async (id: string, notice?: string): Promise<void> => {
    try {
      const r = await window.api.reopenReview(id)
      if ('error' in r) setState({ screen: 'open', error: friendlyError(r.error) })
      else setState({ screen: 'walkthrough', walkthrough: r.walkthrough, review: r, notice })
    } catch (e) {
      setState({ screen: 'open', error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (loadError)
    return (
      <div className="screen">
        <div className="error" role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={init}>
            Retry
          </button>
        </div>
      </div>
    )
  if (!settings) return null

  switch (state.screen) {
    case 'setup':
      return (
        <Setup
          settings={settings}
          onSaved={() =>
            load()
              .then(() => setState({ screen: 'open' }))
              .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
          }
          onCancel={settings.hasApiKey ? () => setState({ screen: 'open' }) : undefined}
        />
      )
    case 'open':
      return (
        <Open
          lastRepoPath={settings.lastRepoPath}
          opened={state.opened}
          error={state.error}
          rowError={state.rowError}
          onReopen={(id) => void reopen(id)}
          onRegenerateReview={(r) => void regenerateFromRow(r)}
          onOpened={(opened) => setState({ screen: 'open', opened })}
          onInputsChanged={() =>
            setState((s) => (s.screen === 'open' && (s.opened || s.error) ? { screen: 'open' } : s))
          }
          onGenerate={() => setState({ screen: 'generating', opened: state.opened! })}
          onSettings={() => setState({ screen: 'setup' })}
          onUsage={() => setState({ screen: 'usage' })}
        />
      )
    case 'generating':
      return (
        <Generating
          opened={state.opened}
          limits={{ maxTurns: settings.maxTurns, maxBudgetUsd: settings.maxBudgetUsd }}
          onDone={(review) =>
            setState({ screen: 'walkthrough', walkthrough: review.walkthrough, review })
          }
          onError={(error) =>
            state.returnTo !== undefined
              ? void returnToReview(state.returnTo, `Regenerate failed: ${error}`)
              : setState({ screen: 'open', opened: state.opened, error })
          }
          onCancelled={() =>
            state.returnTo !== undefined
              ? void returnToReview(state.returnTo)
              : setState({ screen: 'open', opened: state.opened })
          }
        />
      )
    case 'usage':
      return <Usage onBack={() => setState({ screen: 'open' })} />
    case 'walkthrough':
      return (
        <WalkthroughScreen
          key={state.review ? state.review.id + state.review.generatedAt : 'fixture'}
          walkthrough={state.walkthrough}
          review={state.review}
          notice={state.notice}
          onExit={() => setState({ screen: 'open' })}
          onRegenerate={(review) => void regenerateFromWalkthrough(review)}
        />
      )
  }
}

export default App
