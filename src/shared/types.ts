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
}

export interface ChatMessage {
  id: string
  stepId: string
  role: 'user' | 'assistant'
  text: string
}
