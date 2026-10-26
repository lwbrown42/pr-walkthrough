export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export interface Hunk {
  id: string
  newStart: number
  newLines: number
  oldStart: number
  oldLines: number
}

export interface ChangedFile {
  path: string
  oldPath?: string
  status: FileStatus
  binary: boolean
  additions: number
  deletions: number
  hunks: Hunk[]
}

export interface ReviewTarget {
  kind: 'local' | 'github'
  repoPath: string
  worktreePath: string
  baseSha: string
  headSha: string
  title: string
  prNumber?: number
  /** Human ref names, recorded so later update checks and the UI can show base → head. */
  baseRef?: string
  headRef?: string
}

export interface Settings {
  apiKey: string | null
  model: string
  /** The model that answers chat questions; it runs in its own session, so it can differ. */
  chatModel: string
  maxTurns: number
  maxBudgetUsd: number
  lastRepoPath?: string
}

/** Token counts for one run (summed across models when totalled). */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

/** What an agent session has spent so far, as its latest result reported it. */
export interface SessionUsage {
  costUsd: number
  tokensByModel: Record<string, TokenUsage>
}

export interface RunLogEntry {
  at: string
  kind: 'generate' | 'chat'
  prTitle: string
  changedLines: number
  durationMs: number
  costUsd: number | null
  turns: number | null
  outcome: 'success' | string
  /** Absent on entries written before token logging, or when the SDK reported none. */
  tokens?: TokenUsage | null
  /** Per-model breakdown, keyed by the SDK's model id. */
  tokensByModel?: Record<string, TokenUsage> | null
  /** The saved review this run belongs to, when it came from one. */
  reviewId?: string
}

export interface ChatMessage {
  id: string
  stepId: string
  role: 'user' | 'assistant'
  text: string
}
