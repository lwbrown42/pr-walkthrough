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
import { progressLabel, reviewKey, type SavedReview } from '../shared/reviews'
import { labelSteps } from '../shared/stepLabels'
import { summarizeRuns } from '../shared/usage'
import type { Walkthrough } from '../shared/walkthrough'
import { askAboutStep } from './agent/chat'
import { generateWalkthrough } from './agent/generate'
import { AgentRunError } from './agent/options'
import { countChangedLines, getChangedFiles, PLAIN_DIFF_FLAGS, readFileAt } from './git/diff'
import { runGit } from './git/run'
import { commitExists, ensureWorktree, resolveGithubPr, resolveLocalBranch } from './git/target'
import { checkForUpdates } from './git/updates'
import type { ReviewStore } from './reviews/store'
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
  reviews: ReviewStore
  checkForUpdates: typeof checkForUpdates
  /** ensureWorktree bound to worktreesDir. */
  ensureWorktree: (repoPath: string, headSha: string) => Promise<string>
  commitExists: typeof commitExists
  newId: () => string
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
  /** The saved review that is open, or null (none yet, or the fixture). */
  let reviewId: string | null = null
  /** Whether the open walkthrough's agent session is known to resume. */
  let sessionVerified = false

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
  const logRun = (e: RunLogEntry): void => deps.settings.appendRunLog(e)

  /** Adds a run's cost to a saved review, if it still exists. */
  const addCost = (id: string, costUsd: number | null | undefined): void => {
    const review = deps.reviews.get(id)
    if (!review || !costUsd) return
    deps.reviews.save({ ...review, costUsd: review.costUsd + costUsd })
  }

  async function countNewCommits(
    repoPath: string,
    savedHead: string,
    head: string
  ): Promise<number | null> {
    if (savedHead === head) return 0
    try {
      const n = Number(
        (await deps.runGit(repoPath, ['rev-list', '--count', `${savedHead}..${head}`])).trim()
      )
      return Number.isNaN(n) ? null : n
    } catch {
      return null
    }
  }

  /** Removes a replaced review's worktree unless the new walkthrough or another review uses it. */
  async function removeOldWorktree(old: SavedReview, newPath: string): Promise<void> {
    const { repoPath, worktreePath } = old.walkthrough.target
    if (worktreePath === newPath) return
    const shared = deps.reviews
      .list()
      .some((r) => r.id !== old.id && r.walkthrough.target.worktreePath === worktreePath)
    if (shared) return
    try {
      await deps.runGit(repoPath, ['worktree', 'remove', '--force', worktreePath])
    } catch {
      // best effort
    }
  }

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
        reviewId = null
        deps.settings.save({ lastRepoPath: req.repoPath })
        const result: OpenResult = {
          target,
          files,
          changedLines,
          overLimit: changedLines > CHANGED_LINES_LIMIT
        }
        const existing = deps.reviews.findByKey(reviewKey(target))
        if (existing) {
          result.saved = {
            id: existing.id,
            progress: progressLabel(existing),
            lastOpenedAt: existing.lastOpenedAt,
            newCommits: await countNewCommits(
              target.repoPath,
              existing.walkthrough.target.headSha,
              target.headSha
            )
          }
        }
        return result
      } catch (err) {
        return toApiError(err)
      }
    },

    async generate(target): Promise<SavedReview | ApiError> {
      const started = deps.now()
      const existing = deps.reviews.findByKey(reviewKey(target))
      const id = existing?.id ?? deps.newId()
      const entry = (partial: RunOutcome): void =>
        logRun({
          at: new Date(started).toISOString(),
          kind: 'generate',
          prTitle: target.title,
          changedLines: current?.changedLines ?? 0,
          reviewId: id,
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
        const generated: Walkthrough = {
          ...result.walkthrough,
          target,
          files,
          changedLines,
          sessionId: result.sessionId
        }
        const at = new Date(deps.now()).toISOString()
        const previous = existing ? (deps.reviews.get(existing.id) ?? existing) : null
        const review: SavedReview = {
          id,
          key: reviewKey(target),
          walkthrough: generated,
          state: { index: 0, seen: [0], mode: previous?.state.mode ?? 'diff', messages: [] },
          createdAt: previous?.createdAt ?? at,
          generatedAt: at,
          lastOpenedAt: at,
          costUsd: (previous?.costUsd ?? 0) + (result.costUsd ?? 0)
        }
        deps.reviews.save(review)
        walkthrough = generated
        reviewId = id
        sessionVerified = true
        entry({
          outcome: 'success',
          costUsd: result.costUsd,
          turns: result.turns,
          durationMs: result.durationMs,
          tokens: result.tokens,
          tokensByModel: result.tokensByModel
        })
        if (previous) await removeOldWorktree(previous, target.worktreePath)
        return review
      } catch (err) {
        const agentErr = err instanceof AgentRunError ? err : null
        if (existing) addCost(existing.id, agentErr?.costUsd)
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
      let started = deps.now()
      const asked = walkthrough
      const askedReviewId = reviewId
      const entry = (partial: RunOutcome): void => {
        if (!asked) return
        logRun({
          at: new Date(started).toISOString(),
          kind: 'chat',
          prTitle: asked.target.title,
          changedLines: asked.changedLines,
          ...(askedReviewId ? { reviewId: askedReviewId } : {}),
          ...partial
        })
      }
      const logFailure = (err: unknown): void => {
        if (!(err instanceof AgentRunError)) return
        entry({
          outcome: err.reason,
          costUsd: err.costUsd ?? null,
          turns: err.turns ?? null,
          durationMs: err.durationMs ?? deps.now() - started,
          tokens: err.tokens ?? null,
          tokensByModel: err.tokensByModel ?? null
        })
        if (askedReviewId) addCost(askedReviewId, err.costUsd)
      }
      try {
        if (!asked) throw new Error('No walkthrough is open.')
        const stepIndex = asked.steps.findIndex((s) => s.id === stepId)
        if (stepIndex < 0) throw new Error(`Unknown step: ${stepId}`)
        const ask = (fresh: boolean): ReturnType<typeof deps.askAboutStep> =>
          deps.askAboutStep({
            sessionId: fresh ? null : asked.sessionId,
            ...(fresh ? { walkthrough: { summary: asked.summary, steps: asked.steps } } : {}),
            worktreePath: asked.target.worktreePath,
            step: asked.steps[stepIndex],
            stepLabel: labelSteps(asked.steps).labels[stepIndex],
            question,
            settings: deps.settings.get(),
            onText: (chunk) => deps.send(IPC.chatText, chunk)
          })
        let result: Awaited<ReturnType<typeof deps.askAboutStep>>
        try {
          result = await ask(false)
        } catch (err) {
          // A stored session may not resume (e.g. after a restart): retry once in a fresh one.
          if (!(err instanceof AgentRunError && err.reason === 'failed') || sessionVerified)
            throw err
          logFailure(err)
          started = deps.now()
          result = await ask(true)
        }
        entry({
          outcome: 'success',
          costUsd: result.costUsd,
          turns: result.turns,
          durationMs: result.durationMs ?? deps.now() - started,
          tokens: result.tokens,
          tokensByModel: result.tokensByModel
        })
        if (walkthrough === asked) {
          walkthrough = { ...asked, sessionId: result.sessionId }
          sessionVerified = true
        }
        if (askedReviewId) {
          const review = deps.reviews.get(askedReviewId)
          if (review) {
            // A regenerate since the question was asked owns the session now; keep its id.
            const stillAsked = review.walkthrough.sessionId === asked.sessionId
            deps.reviews.save({
              ...review,
              walkthrough: stillAsked
                ? { ...review.walkthrough, sessionId: result.sessionId }
                : review.walkthrough,
              costUsd: review.costUsd + (result.costUsd ?? 0)
            })
          }
        }
        return { id: randomUUID(), stepId, role: 'assistant', text: result.answer }
      } catch (err) {
        logFailure(err)
        return toApiError(err)
      }
    },

    async getRunLog() {
      return deps.settings.readRunLog()
    },

    async getReviewUsage() {
      const id = reviewId
      return summarizeRuns(id ? deps.settings.readRunLog().filter((e) => e.reviewId === id) : [])
        .allTime
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
  reviews: ReviewStore
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
    reviews: opts.reviews,
    checkForUpdates,
    ensureWorktree: (r, s) => ensureWorktree(runGit, r, opts.worktreesDir, s),
    commitExists,
    newId: randomUUID,
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
  ipcMain.handle(IPC.getReviewUsage, () => handlers.getReviewUsage())
}
