import { useEffect, useState } from 'react'
import type { RunLogEntry, TokenUsage } from '../../../shared/types'
import { summarizeRuns, type UsageSummary, type UsageTotals } from '../../../shared/usage'

interface Props {
  onBack: () => void
  /** Label for the button that calls onBack. */
  backLabel?: string
}

/** How many recent runs the table shows. */
const RECENT_LIMIT = 50

function formatUsd(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `$${n.toFixed(2)}`
}

function formatTokens(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function TokenCells({ tokens }: { tokens: TokenUsage | null | undefined }): React.JSX.Element {
  return (
    <>
      <td className="num">{formatTokens(tokens?.input)}</td>
      <td className="num">{formatTokens(tokens?.output)}</td>
      <td className="num">{formatTokens(tokens?.cacheRead)}</td>
      <td className="num">{formatTokens(tokens?.cacheCreation)}</td>
    </>
  )
}

const TOKEN_HEADERS = (
  <>
    <th className="num">Input</th>
    <th className="num">Output</th>
    <th className="num">Cache read</th>
    <th className="num">Cache write</th>
  </>
)

function TotalsCard({ label, totals }: { label: string; totals: UsageTotals }): React.JSX.Element {
  return (
    <section className="panel usage-card" aria-label={label}>
      <h2>{label}</h2>
      <p className="usage-cost">{formatUsd(totals.costUsd)}</p>
      <p className="muted">{totals.runs === 1 ? '1 run' : `${totals.runs} runs`}</p>
      <p className="muted">
        {formatTokens(totals.tokens.input)} in · {formatTokens(totals.tokens.output)} out ·{' '}
        {formatTokens(totals.tokens.cacheRead)} cached
      </p>
    </section>
  )
}

export default function Usage({ onBack, backLabel = 'Back' }: Props): React.JSX.Element {
  const [summary, setSummary] = useState<UsageSummary>()
  const [error, setError] = useState<string>()

  const load = (): void => {
    window.api
      .getRunLog()
      .then((entries: RunLogEntry[]) => setSummary(summarizeRuns(entries)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(load, [])

  const retry = (): void => {
    setError(undefined)
    load()
  }

  return (
    <div className="screen usage">
      <div className="row between">
        <h1>Usage</h1>
        <button type="button" className="link" onClick={onBack}>
          {backLabel}
        </button>
      </div>
      <p className="muted">
        Costs are the SDK&apos;s estimates. Check the Claude Console for billed usage.
      </p>

      {error && (
        <div className="error" role="alert">
          <p>Could not read the run log: {error}</p>
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {summary && summary.allTime.runs === 0 && (
        <p className="muted">No runs logged yet. Generate a walkthrough to see usage here.</p>
      )}

      {summary && summary.allTime.runs > 0 && (
        <>
          <div className="usage-cards">
            <TotalsCard label="Today" totals={summary.today} />
            <TotalsCard label="This month" totals={summary.month} />
            <TotalsCard label="All time" totals={summary.allTime} />
          </div>

          <h2>By PR</h2>
          <table className="usage-table" aria-label="By PR">
            <thead>
              <tr>
                <th>PR</th>
                <th className="num">Walkthroughs</th>
                <th className="num">Questions</th>
                <th className="num">Cost</th>
                {TOKEN_HEADERS}
              </tr>
            </thead>
            <tbody>
              {summary.byPr.map((pr) => (
                <tr key={pr.prTitle}>
                  <td>{pr.prTitle}</td>
                  <td className="num">{pr.generations}</td>
                  <td className="num">{pr.chats}</td>
                  <td className="num">{formatUsd(pr.totals.costUsd)}</td>
                  <TokenCells tokens={pr.totals.tokens} />
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Recent runs</h2>
          <table className="usage-table" aria-label="Recent runs">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>PR</th>
                <th>Outcome</th>
                <th className="num">Time</th>
                <th className="num">Turns</th>
                <th className="num">Cost</th>
                {TOKEN_HEADERS}
              </tr>
            </thead>
            <tbody>
              {summary.recent.slice(0, RECENT_LIMIT).map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td>{new Date(r.at).toLocaleString()}</td>
                  <td>{r.kind}</td>
                  <td>{r.prTitle}</td>
                  <td>{r.outcome}</td>
                  <td className="num">{formatDuration(r.durationMs)}</td>
                  <td className="num">{r.turns ?? '—'}</td>
                  <td className="num">{formatUsd(r.costUsd)}</td>
                  <TokenCells tokens={r.tokens} />
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
