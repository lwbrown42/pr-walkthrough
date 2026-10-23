import type { ChangedFile, ChatMessage, ReviewTarget, Settings } from './types'
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
}

export type ApiError = { error: { message: string; reason?: string } }

export interface GenerateProgressEvent {
  turns: number
  lastTool?: string
  elapsedMs: number
}

export type PublicSettings = Omit<Settings, 'apiKey'> & { hasApiKey: boolean }

export interface PreloadApi {
  getSettings(): Promise<PublicSettings>
  saveSettings(patch: Partial<Settings>): Promise<void>
  /** Native folder dialog. */
  pickRepo(): Promise<string | null>
  openTarget(req: OpenRequest): Promise<OpenResult | ApiError>
  generate(target: ReviewTarget): Promise<Walkthrough | ApiError>
  onGenerateProgress(cb: (p: GenerateProgressEvent) => void): () => void
  ask(req: { stepId: string; question: string }): Promise<ChatMessage | ApiError>
  onChatText(cb: (chunk: string) => void): () => void
  readFile(req: { sha: string; path: string }): Promise<string | null>
}

export const CHANGED_LINES_LIMIT = 1300

export const IPC = {
  getSettings: 'api:getSettings',
  saveSettings: 'api:saveSettings',
  pickRepo: 'api:pickRepo',
  openTarget: 'api:openTarget',
  generate: 'api:generate',
  ask: 'api:ask',
  readFile: 'api:readFile',
  generateProgress: 'api:generateProgress',
  chatText: 'api:chatText'
} as const
