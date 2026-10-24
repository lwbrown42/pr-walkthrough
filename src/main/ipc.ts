import { randomUUID } from 'node:crypto'
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import {
  CHANGED_LINES_LIMIT,
  IPC,
  type ApiError,
  type OpenRequest,
  type OpenResult,
  type PreloadApi
} from '../shared/api'
import type { ChangedFile, ChatMessage, ReviewTarget, RunLogEntry } from '../shared/types'
import { labelSteps } from '../shared/stepLabels'
import type { Walkthrough } from '../shared/walkthrough'
import { askAboutStep } from './agent/chat'
import { generateWalkthrough } from './agent/generate'
import { AgentRunError } from './agent/options'
import { countChangedLines, getChangedFiles, PLAIN_DIFF_FLAGS, readFileAt } from './git/diff'
import { runGit } from './git/run'
import { resolveGithubPr, resolveLocalBranch } from './git/target'
import type { SettingsStore } from './settings'
import type { LineCounts } from './walkthrough/normalize'

export interface HandlerDeps {
  settings: Pick<SettingsStore, 'get' | 'save' | 'appendRunLog' | 'readRunLog'>
  generateWalkthrough: typeof generateWalkthrough
  askAboutStep: typeof askAboutStep
  resolveLocalBranch: typeof resolveLocalBranch
  resolveGithubPr: typeof resolveGithubPr
  getChangedFiles: typeof getChangedFiles
  countChangedLines: typeof countChangedLines
  readFileAt: typeof readFileAt
  runGit: typeof runGit
  worktreesDir: string
  pickRepo: () => Promise<string | null>
  /** Pushes an event to the renderer (progress, chat text). */
  send: (channel: string, payload: unknown) => void
  /** Milliseconds since epoch. */
  now: () => number
  /** Dev-only walkthrough from --fixture; also serves readFile. */
  fixture?: Walkthrough | null
}

export type Handlers = {
  [K in keyof PreloadApi as K extends `on${string}` ? never : K]: PreloadApi[K]
}

function toApiError(err: unknown): ApiError {
  const message = err instanceof Error ? err.message : String(err)
  const reason = err instanceof AgentRunError ? err.reason : undefined
  return { error: reason ? { message, reason } : { message } }
}

/** The per-run fields of a log entry (the rest comes from the PR being reviewed). */
type RunOutcome = Pick<
  RunLogEntry,
  'outcome' | 'costUsd' | 'turns' | 'durationMs' | 'tokens' | 'tokensByModel'
>

/** At most this many `git show` processes run at once. */
const READ_CONCURRENCY = 8

async function runLimited(jobs: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) await jobs[next++]()
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
}

function countLines(text: string): number {
  if (text === '') return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

export function createHandlers(deps: HandlerDeps): Handlers {
  const fixture = deps.fixture ?? null
  let current: { target: ReviewTarget; files: ChangedFile[]; changedLines: number } | null = fixture
    ? { target: fixture.target, files: fixture.files, changedLines: fixture.changedLines }
    : null
  let walkthrough: Walkthrough | null = null

  async function computeLineCounts(
    target: ReviewTarget,
    files: ChangedFile[]
  ): Promise<LineCounts> {
    const counts: LineCounts = { head: {}, base: {} }
    const cwd = target.worktreePath
    // One unreadable file (gitlink, odd path) must not fail the run: skip it and let
    // normalization drop or fill its segments.
    const job =
      (sha: string, path: string, into: Record<string, number>) => async (): Promise<void> => {
        try {
          const t = await deps.readFileAt(cwd, sha, path)
          if (t !== null) into[path] = countLines(t)
        } catch {
          // skipped
        }
      }
    const jobs = files
      .filter((f) => !f.binary)
      .flatMap((f) => {
        const out: (() => Promise<void>)[] = []
        if (f.status !== 'deleted') out.push(job(target.headSha, f.path, counts.head))
        if (f.status !== 'added') {
          const basePath = f.status === 'renamed' ? (f.oldPath ?? f.path) : f.path
          out.push(job(target.baseSha, basePath, counts.base))
        }
        return out
      })
    await runLimited(jobs, READ_CONCURRENCY)
    return counts
  }

  let generation: AbortController | null = null

  return {
    async getSettings() {
      const { apiKey, ...rest } = deps.settings.get()
      return { ...rest, hasApiKey: !!apiKey }
    },

    async saveSettings(patch) {
      deps.settings.save(patch)
    },

    pickRepo: () => deps.pickRepo(),

    async openTarget(req: OpenRequest): Promise<OpenResult | ApiError> {
      try {
        const target =
          req.kind === 'local'
            ? await deps.resolveLocalBranch({
                repoPath: req.repoPath,
                headRef: req.headRef,
                baseRef: req.baseRef,
                worktreesDir: deps.worktreesDir
              })
            : await deps.resolveGithubPr({
                repoPath: req.repoPath,
                pr: req.pr,
                worktreesDir: deps.worktreesDir
              })
        const files = await deps.getChangedFiles(
          target.worktreePath,
          target.baseSha,
          target.headSha
        )
        const changedLines = deps.countChangedLines(files)
        current = { target, files, changedLines }
        walkthrough = null
        deps.settings.save({ lastRepoPath: req.repoPath })
        return { target, files, changedLines, overLimit: changedLines > CHANGED_LINES_LIMIT }
      } catch (err) {
        return toApiError(err)
      }
    },

    async generate(target): Promise<Walkthrough | ApiError> {
      const started = deps.now()
      const entry = (partial: RunOutcome): void =>
        deps.settings.appendRunLog({
          at: new Date(started).toISOString(),
          kind: 'generate',
          prTitle: target.title,
          changedLines: current?.changedLines ?? 0,
          ...partial
        })
      const abortController = new AbortController()
      generation?.abort()
      generation = abortController
      try {
        const files =
          current &&
          current.target.headSha === target.headSha &&
          current.target.baseSha === target.baseSha
            ? current.files
            : await deps.getChangedFiles(target.worktreePath, target.baseSha, target.headSha)
        const changedLines = deps.countChangedLines(files)
        current = { target, files, changedLines }
        const [diffText, lineCounts] = await Promise.all([
          deps.runGit(target.worktreePath, [
            'diff',
            ...PLAIN_DIFF_FLAGS,
            '-M',
            target.baseSha,
            target.headSha
          ]),
          computeLineCounts(target, files)
        ])
        if (abortController.signal.aborted) {
          throw new AgentRunError('cancelled', 'Generation was cancelled.')
        }
        const result = await deps.generateWalkthrough({
          target,
          files,
          diffText,
          lineCounts,
          settings: deps.settings.get(),
          abortController,
          readLineCount: async (path) => {
            const t = await deps.readFileAt(target.worktreePath, target.headSha, path)
            return t === null ? null : countLines(t)
          },
          onProgress: (p) =>
            deps.send(IPC.generateProgress, { ...p, elapsedMs: deps.now() - started })
        })
        walkthrough = {
          ...result.walkthrough,
          target,
          files,
          changedLines,
          sessionId: result.sessionId
        }
        entry({
          outcome: 'success',
          costUsd: result.costUsd,
          turns: result.turns,
          durationMs: result.durationMs,
          tokens: result.tokens,
          tokensByModel: result.tokensByModel
        })
        return walkthrough
      } catch (err) {
        const agentErr = err instanceof AgentRunError ? err : null
        entry({
          outcome: abortController.signal.aborted ? 'cancelled' : (agentErr?.reason ?? 'failed'),
          costUsd: agentErr?.costUsd ?? null,
          turns: agentErr?.turns ?? null,
          durationMs: agentErr?.durationMs ?? deps.now() - started,
          tokens: agentErr?.tokens ?? null,
          tokensByModel: agentErr?.tokensByModel ?? null
        })
        if (abortController.signal.aborted) {
          return { error: { message: 'Generation was cancelled.', reason: 'cancelled' } }
        }
        return toApiError(err)
      } finally {
        if (generation === abortController) generation = null
      }
    },

    async cancelGenerate() {
      generation?.abort()
    },

    async ask({ stepId, question }): Promise<ChatMessage | ApiError> {
      const started = deps.now()
      const asked = walkthrough
      const entry = (partial: RunOutcome): void => {
        if (!asked) return
        deps.settings.appendRunLog({
          at: new Date(started).toISOString(),
          kind: 'chat',
          prTitle: asked.target.title,
          changedLines: asked.changedLines,
          ...partial
        })
      }
      try {
        if (!walkthrough) throw new Error('No walkthrough is open.')
        const stepIndex = walkthrough.steps.findIndex((s) => s.id === stepId)
        if (stepIndex < 0) throw new Error(`Unknown step: ${stepId}`)
        const result = await deps.askAboutStep({
          sessionId: walkthrough.sessionId,
          worktreePath: walkthrough.target.worktreePath,
          step: walkthrough.steps[stepIndex],
          stepLabel: labelSteps(walkthrough.steps).labels[stepIndex],
          question,
          settings: deps.settings.get(),
          onText: (chunk) => deps.send(IPC.chatText, chunk)
        })
        entry({
          outcome: 'success',
          costUsd: result.costUsd,
          turns: result.turns,
          durationMs: result.durationMs ?? deps.now() - started,
          tokens: result.tokens,
          tokensByModel: result.tokensByModel
        })
        walkthrough = { ...walkthrough, sessionId: result.sessionId }
        return { id: randomUUID(), stepId, role: 'assistant', text: result.answer }
      } catch (err) {
        if (err instanceof AgentRunError) {
          entry({
            outcome: err.reason,
            costUsd: err.costUsd ?? null,
            turns: err.turns ?? null,
            durationMs: err.durationMs ?? deps.now() - started,
            tokens: err.tokens ?? null,
            tokensByModel: err.tokensByModel ?? null
          })
        }
        return toApiError(err)
      }
    },

    async getRunLog() {
      return deps.settings.readRunLog()
    },

    async getFixture() {
      return fixture
    },

    async readFile({ sha, path }) {
      if (!current) return null
      return deps.readFileAt(current.target.worktreePath, sha, path)
    }
  }
}

/** Electron glue: wires the handlers to ipcMain and the given window. */
export function registerIpc(opts: {
  settings: SettingsStore
  worktreesDir: string
  getWindow: () => BrowserWindow | null
  fixture?: Walkthrough | null
}): void {
  const { getWindow } = opts
  const handlers = createHandlers({
    settings: opts.settings,
    generateWalkthrough,
    askAboutStep,
    resolveLocalBranch,
    resolveGithubPr,
    getChangedFiles,
    countChangedLines,
    readFileAt,
    runGit,
    worktreesDir: opts.worktreesDir,
    pickRepo: async () => {
      const win = getWindow()
      const options = { properties: ['openDirectory' as const] }
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    },
    send: (channel, payload) => getWindow()?.webContents.send(channel, payload),
    now: () => Date.now(),
    fixture: opts.fixture
  })

  ipcMain.handle(IPC.getSettings, () => handlers.getSettings())
  ipcMain.handle(IPC.saveSettings, (_e, patch) => handlers.saveSettings(patch))
  ipcMain.handle(IPC.pickRepo, () => handlers.pickRepo())
  ipcMain.handle(IPC.openTarget, (_e, req) => handlers.openTarget(req))
  ipcMain.handle(IPC.generate, (_e, target) => handlers.generate(target))
  ipcMain.handle(IPC.cancelGenerate, () => handlers.cancelGenerate())
  ipcMain.handle(IPC.ask, (_e, req) => handlers.ask(req))
  ipcMain.handle(IPC.getFixture, () => handlers.getFixture())
  ipcMain.handle(IPC.readFile, (_e, req) => handlers.readFile(req))
  ipcMain.handle(IPC.getRunLog, () => handlers.getRunLog())
}
