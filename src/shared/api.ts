import type { ChangedFile, ChatMessage, ReviewTarget, RunLogEntry, Settings } from './types'
import type { GenerateProgress } from './progress'
import type { ReviewState, ReviewSummary, ReviewUpdate, SavedReview } from './reviews'
import type { UsageTotals } from './usage'
import type { Walkthrough } from './walkthrough'

export type OpenRequest =
  | { kind: 'local'; repoPath: string; headRef: string; baseRef?: string }
  | { kind: 'github'; repoPath: string; pr: string }

export interface OpenResult {
  target: ReviewTarget
  files: ChangedFile[]
  changedLines: number
  /** changedLines > CHANGED_LINES_LIMIT */
  overLimit: boolean
  /** A saved review with the same key, if any. newCommits is null when they can't be counted. */
  saved?: { id: string; progress: string; lastOpenedAt: string; newCommits: number | null }
}

export type ApiError = { error: { message: string; reason?: string } }

export type GenerateProgressEvent = GenerateProgress & { elapsedMs: number }

export type PublicSettings = Omit<Settings, 'apiKey'> & { hasApiKey: boolean }

export interface PreloadApi {
  getSettings(): Promise<PublicSettings>
  saveSettings(patch: Partial<Settings>): Promise<void>
  /** Native folder dialog. */
  pickRepo(): Promise<string | null>
  openTarget(req: OpenRequest): Promise<OpenResult | ApiError>
  /** Generates a walkthrough and saves it, replacing any saved review with the same key. */
  generate(target: ReviewTarget): Promise<SavedReview | ApiError>
  /** Aborts the in-flight generate(); it then resolves with reason 'cancelled'. */
  cancelGenerate(): Promise<void>
  onGenerateProgress(cb: (p: GenerateProgressEvent) => void): () => void
  ask(req: { stepId: string; question: string }): Promise<ChatMessage | ApiError>
  onChatText(cb: (chunk: string) => void): () => void
  /** Dev-only: the walkthrough loaded via --fixture <file.json>, else null. */
  getFixture(): Promise<Walkthrough | null>
  readFile(req: { sha: string; path: string }): Promise<string | null>
  /** Opens the open review's GitHub PR in the browser. */
  openPr(): Promise<void | ApiError>
  /** Every logged generation and chat question, oldest first. */
  getRunLog(): Promise<RunLogEntry[]>
  /** Totals for the open saved review: every generation and chat question logged under its id. */
  getReviewUsage(): Promise<UsageTotals>
  /** Saved reviews, newest lastOpenedAt first. Removes expired reviews first. */
  listReviews(): Promise<ReviewSummary[]>
  /** Opens a saved review: recreates its worktree if needed and updates lastOpenedAt. */
  reopenReview(id: string): Promise<SavedReview | ApiError>
  /** Replaces a saved review's reading state; nothing else changes. */
  saveReviewState(req: { id: string; state: ReviewState }): Promise<void>
  /** Deletes a saved review and returns it (for Undo), or null if there was none. */
  deleteReview(id: string): Promise<SavedReview | null>
  /** Saves a review back after deleteReview (Undo). Invalid input is ignored. */
  restoreReview(review: SavedReview): Promise<void>
  /** Checks a saved review's branch for new commits and stores the result. */
  checkReviewUpdates(id: string): Promise<ReviewUpdate | null>
}

export const CHANGED_LINES_LIMIT = 1300

export const IPC = {
  getSettings: 'api:getSettings',
  saveSettings: 'api:saveSettings',
  pickRepo: 'api:pickRepo',
  openTarget: 'api:openTarget',
  generate: 'api:generate',
  cancelGenerate: 'api:cancelGenerate',
  ask: 'api:ask',
  readFile: 'api:readFile',
  openPr: 'api:openPr',
  getFixture: 'api:getFixture',
  getRunLog: 'api:getRunLog',
  getReviewUsage: 'api:getReviewUsage',
  listReviews: 'api:listReviews',
  reopenReview: 'api:reopenReview',
  saveReviewState: 'api:saveReviewState',
  deleteReview: 'api:deleteReview',
  restoreReview: 'api:restoreReview',
  checkReviewUpdates: 'api:checkReviewUpdates',
  generateProgress: 'api:generateProgress',
  chatText: 'api:chatText'
} as const
