import { useEffect, useState } from 'react'
import type { OpenResult, PublicSettings } from '../../shared/api'
import type { Walkthrough as WalkthroughData } from '../../shared/walkthrough'
import Generating from './screens/Generating'
import Open from './screens/Open'
import Setup from './screens/Setup'
import WalkthroughScreen from './screens/Walkthrough'

type State =
  | { screen: 'setup' }
  | { screen: 'open'; opened?: OpenResult; error?: string }
  | { screen: 'generating'; opened: OpenResult }
  | { screen: 'walkthrough'; walkthrough: WalkthroughData }

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
      .then((s) => setState(s.hasApiKey ? { screen: 'open' } : { screen: 'setup' }))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(init, [])

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
          onOpened={(opened) => setState({ screen: 'open', opened })}
          onGenerate={() => setState({ screen: 'generating', opened: state.opened! })}
          onSettings={() => setState({ screen: 'setup' })}
        />
      )
    case 'generating':
      return (
        <Generating
          target={state.opened.target}
          onDone={(walkthrough) => setState({ screen: 'walkthrough', walkthrough })}
          onError={(error) => setState({ screen: 'open', opened: state.opened, error })}
        />
      )
    case 'walkthrough':
      return (
        <WalkthroughScreen
          walkthrough={state.walkthrough}
          onExit={() => setState({ screen: 'open' })}
        />
      )
  }
}

export default App
