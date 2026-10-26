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
  const [chatModel, setChatModel] = useState(settings.chatModel)
  const [maxTurns, setMaxTurns] = useState(String(settings.maxTurns))
  const [maxBudgetUsd, setMaxBudgetUsd] = useState(String(settings.maxBudgetUsd))
  const [error, setError] = useState<string>()
  const canSave = apiKey.trim() !== '' || settings.hasApiKey

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const turns = Number(maxTurns)
    const budget = Number(maxBudgetUsd)
    if (model.trim() === '') return setError('Model is required.')
    if (chatModel.trim() === '') return setError('Chat model is required.')
    if (maxTurns.trim() === '' || !Number.isInteger(turns) || turns <= 0)
      return setError('Max turns must be a positive whole number.')
    if (maxBudgetUsd.trim() === '' || !Number.isFinite(budget) || budget <= 0)
      return setError('Max budget must be a positive number.')
    setError(undefined)
    const patch: Parameters<typeof window.api.saveSettings>[0] = {
      model: model.trim(),
      chatModel: chatModel.trim(),
      maxTurns: turns,
      maxBudgetUsd: budget
    }
    if (apiKey.trim() !== '') patch.apiKey = apiKey.trim()
    try {
      await window.api.saveSettings(patch)
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err))
    }
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
        Chat model
        <input value={chatModel} onChange={(e) => setChatModel(e.target.value)} />
      </label>
      <label>
        Max turns
        <input
          type="number"
          min={1}
          value={maxTurns}
          onChange={(e) => setMaxTurns(e.target.value)}
        />
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
      {error && (
        <div className="error" role="alert">
          <p>{error}</p>
        </div>
      )}
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
