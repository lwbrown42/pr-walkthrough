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
