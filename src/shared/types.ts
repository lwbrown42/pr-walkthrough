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
}

export interface Settings {
  apiKey: string | null
  model: string
  maxTurns: number
  maxBudgetUsd: number
  lastRepoPath?: string
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
}

export interface ChatMessage {
  id: string
  stepId: string
  role: 'user' | 'assistant'
  text: string
}
