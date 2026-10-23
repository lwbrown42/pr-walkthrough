import type { RunLogEntry, TokenUsage } from './types'

export interface UsageTotals {
  runs: number
  costUsd: number
  tokens: TokenUsage
}

export interface PrUsage {
  prTitle: string
  generations: number
  chats: number
  totals: UsageTotals
}

export interface UsageSummary {
  today: UsageTotals
  month: UsageTotals
  allTime: UsageTotals
  /** Most expensive first. */
  byPr: PrUsage[]
  /** Newest first. */
  recent: RunLogEntry[]
}

export const emptyTokens = (): TokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0
})

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation
  }
}

const emptyTotals = (): UsageTotals => ({ runs: 0, costUsd: 0, tokens: emptyTokens() })

function add(t: UsageTotals, e: RunLogEntry): void {
  t.runs += 1
  t.costUsd += e.costUsd ?? 0
  if (e.tokens) t.tokens = addTokens(t.tokens, e.tokens)
}

/** Today and this month are in the viewer's local time. */
export function summarizeRuns(entries: RunLogEntry[], now: Date = new Date()): UsageSummary {
  const today = emptyTotals()
  const month = emptyTotals()
  const allTime = emptyTotals()
  const prs = new Map<string, PrUsage>()

  for (const e of entries) {
    const at = new Date(e.at)
    const sameMonth = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth()
    if (sameMonth && at.getDate() === now.getDate()) add(today, e)
    if (sameMonth) add(month, e)
    add(allTime, e)

    let pr = prs.get(e.prTitle)
    if (!pr) {
      pr = { prTitle: e.prTitle, generations: 0, chats: 0, totals: emptyTotals() }
      prs.set(e.prTitle, pr)
    }
    if (e.kind === 'chat') pr.chats += 1
    else pr.generations += 1
    add(pr.totals, e)
  }

  return {
    today,
    month,
    allTime,
    byPr: [...prs.values()].sort((a, b) => b.totals.costUsd - a.totals.costUsd),
    recent: [...entries].sort((a, b) => b.at.localeCompare(a.at))
  }
}
