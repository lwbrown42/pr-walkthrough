import { useState } from 'react'
import type { PublicSettings } from '../../../shared/api'

interface Props {
  settings: PublicSettings
  onSaved: () => void
  onCancel?: () => void
}

export default function Setup({ settings, onSaved, onCancel }: Props): React.JSX.Element {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings.model)
  const [maxTurns, setMaxTurns] = useState(String(settings.maxTurns))
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(String(settings.maxBudgetUsd))
  const canSave = apiKey.trim() !== '' || settings.hasApiKey

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const patch: Parameters<typeof window.api.saveSettings>[0] = {
      model,
      maxTurns: Number(maxTurns),
      maxBudgetUsd: Number(maxBudgetUsd)
    }
    if (apiKey.trim() !== '') patch.apiKey = apiKey.trim()
    await window.api.saveSettings(patch)
    onSaved()
  }

  return (
    <form className="screen" onSubmit={save}>
      <h1>Settings</h1>
      <label>
        Anthropic API key
        <input
          type="password"
          value={apiKey}
          placeholder={settings.hasApiKey ? 'Saved — leave blank to keep' : 'sk-ant-…'}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <label>
        Model
        <input value={model} onChange={(e) => setModel(e.target.value)} />
      </label>
      <label>
        Max turns
        <input type="number" min={1} value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
      </label>
      <label>
        Max budget (USD)
        <input
          type="number"
          min={0}
          step="0.5"
          value={maxBudgetUsd}
          onChange={(e) => setMaxBudgetUsd(e.target.value)}
        />
      </label>
      <div className="row">
        <button type="submit" disabled={!canSave}>
          Save
        </button>
        {onCancel && (
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}
