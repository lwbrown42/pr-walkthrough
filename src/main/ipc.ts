import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
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
import {
  isExpired,
  progressLabel,
  reviewKey,
  SavedReviewSchema,
  summarizeReview,
  type SavedReview
} from '../shared/reviews'
import { labelSteps } from '../shared/stepLabels'
import { summarizeRuns } from '../shared/usage'
import type { Step, Walkthrough } from '../shared/walkthrough'
import { askAboutStep } from './agent/chat'
import { generateWalkthrough } from './agent/generate'
import { AgentRunError } from './agent/options'
import {
  countChangedLines,
  getChangedFiles,
  isDiffOmitted,
  promptDiffArgs,
  readFileAt
} from './git/diff'
import { runGit } from './git/run'
import { commitExists, ensureWorktree, resolveGithubPr, resolveLocalBranch } from './git/target'
import { checkForUpdates } from './git/updates'
import { isPlainId, type ReviewStore } from './reviews/store'
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

/** A step diff longer than this (about 6K tokens) is left for the chat agent to read itself. */
const STEP_DIFF_MAX_CHARS = 12_000

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
  /** Whether the open walkthrough's chat session is known to resume. */
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

  /**
   * The diff of the files a step changes, to seed a fresh chat; undefined when there are none,
   * when it is too long to be worth sending (the agent can still read the files), or on error.
   */
  async function stepDiffFor(w: Walkthrough, step: Step): Promise<string | undefined> {
    const changed = new Set(step.segments.filter((s) => s.kind === 'change').map((s) => s.path))
    const paths = w.files
      .filter((f) => changed.has(f.path))
      .flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]))
    if (paths.length === 0) return undefined
    try {
      const diff = await deps.runGit(w.target.worktreePath, [
        ...promptDiffArgs(w.target.baseSha, w.target.headSha, []),
        '--',
        ...paths.map((p) => `:(literal)${p}`)
      ])
      return diff.length <= STEP_DIFF_MAX_CHARS ? diff : undefined
    } catch {
      return undefined
    }
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

  /** Whether a path lies inside worktreesDir (as given, or its realpath if it exists). */
  function insideWorktreesDir(path: string): boolean {
    // git resolves a relative worktree path against the repo, not our cwd.
    if (!isAbsolute(path)) return false
    const roots = [resolve(deps.worktreesDir)]
    try {
      roots.push(realpathSync(deps.worktreesDir))
    } catch {
      // missing dir: the resolved path alone
    }
    const abs = resolve(path)
    return roots.some((root) => abs.startsWith(root + sep))
  }

  /**
   * Removes a replaced or deleted review's worktree unless the new walkthrough (keepPath) or
   * another review uses it. Never touches a path outside worktreesDir (a restored review comes
   * from the renderer). A missing repo makes the removal fail, which is ignored.
   */
  async function removeOldWorktree(old: SavedReview, keepPath?: string): Promise<void> {
    const { repoPath, worktreePath } = old.walkthrough.target
    if (worktreePath === keepPath || !insideWorktreesDir(worktreePath)) return
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

  /** Deletes a saved review's file, then its worktree under the shared-worktree rule. */
  async function removeReview(review: SavedReview): Promise<void> {
    deps.reviews.remove(review.id)
    await removeOldWorktree(review)
  }

  async function repoExists(repoPath: string): Promise<boolean> {
    try {
      await deps.runGit(repoPath, ['rev-parse', '--git-dir'])
      return true
    } catch {
      return false
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
          deps.runGit(
            target.worktreePath,
            promptDiffArgs(
              target.baseSha,
              target.headSha,
              files
                .filter(isDiffOmitted)
                .flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]))
            )
          ),
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
        entry({
          outcome: 'success',
          costUsd: result.costUsd,
          turns: result.turns,
          durationMs: result.durationMs,
          tokens: result.tokens,
          tokensByModel: result.tokensByModel
        })
        walkthrough = generated
        reviewId = id
        sessionVerified = false
        // The walkthrough is made and paid for: a failure to persist or tidy up must not
        // turn it into an error or log the run a second time.
        try {
          deps.reviews.save(review)
        } catch {
          // The reader still gets the review; it just is not saved.
          return review
        }
        try {
          if (previous) await removeOldWorktree(previous, target.worktreePath)
        } catch {
          // best effort
        }
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
        const step = asked.steps[stepIndex]
        const settings = deps.settings.get()
        // Null starts a fresh session seeded from the walkthrough: much cheaper than resuming
        // the generation's long session, whose cache a chat would rebuild in full.
        const ask = async (resume: string | null): ReturnType<typeof deps.askAboutStep> => {
          const seed =
            resume === null
              ? {
                  walkthrough: { summary: asked.summary, steps: asked.steps },
                  stepDiff: await stepDiffFor(asked, step)
                }
              : asked.chatUsage
                ? { sessionUsage: asked.chatUsage }
                : {}
          return deps.askAboutStep({
            sessionId: resume,
            ...seed,
            worktreePath: asked.target.worktreePath,
            step,
            stepLabel: labelSteps(asked.steps).labels[stepIndex],
            question,
            settings,
            onText: (chunk) => deps.send(IPC.chatText, chunk)
          })
        }
        let result: Awaited<ReturnType<typeof deps.askAboutStep>>
        // A session on another model would rebuild its cache anyway and lose its thinking.
        if (!asked.chatSessionId || asked.chatModel !== settings.chatModel) {
          result = await ask(null)
        } else {
          try {
            result = await ask(asked.chatSessionId)
          } catch (err) {
            // A stored session may not resume (e.g. after a restart): retry once in a fresh one.
            if (!(err instanceof AgentRunError && err.reason === 'failed') || sessionVerified)
              throw err
            logFailure(err)
            started = deps.now()
            result = await ask(null)
          }
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
          walkthrough = {
            ...asked,
            chatSessionId: result.sessionId,
            chatModel: settings.chatModel,
            chatUsage: result.sessionUsage
          }
          sessionVerified = true
        }
        if (askedReviewId) {
          const review = deps.reviews.get(askedReviewId)
          if (review) {
            // A regenerate since the question was asked starts its own chat; leave it be.
            const stillAsked = review.walkthrough.sessionId === asked.sessionId
            deps.reviews.save({
              ...review,
              walkthrough: stillAsked
                ? {
                    ...review.walkthrough,
                    chatSessionId: result.sessionId,
                    chatModel: settings.chatModel,
                    chatUsage: result.sessionUsage
                  }
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

    async listReviews() {
      const now = deps.now()
      const kept: SavedReview[] = []
      for (const review of deps.reviews.list()) {
        if (isExpired(review, now)) await removeReview(review)
        else kept.push(review)
      }
      kept.sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
      return Promise.all(
        kept.map(async (r) => summarizeReview(r, await repoExists(r.walkthrough.target.repoPath)))
      )
    },

    async reopenReview(id): Promise<SavedReview | ApiError> {
      try {
        const review = deps.reviews.get(id)
        if (!review) throw new Error('This review no longer exists.')
        const saved = review.walkthrough.target
        if (!(await repoExists(saved.repoPath))) {
          return {
            error: { message: `Repository not found at ${saved.repoPath}`, reason: 'missing_repo' }
          }
        }
        if (!(await deps.commitExists(saved.repoPath, saved.headSha))) {
          return {
            error: {
              message: 'This review’s commit is no longer in the repository.',
              reason: 'missing_commit'
            }
          }
        }
        const worktreePath = await deps.ensureWorktree(saved.repoPath, saved.headSha)
        // Re-read: an update check or a chat write may have landed during the awaits above.
        const latest = deps.reviews.get(id) ?? review
        const target =
          worktreePath === latest.walkthrough.target.worktreePath
            ? latest.walkthrough.target
            : { ...latest.walkthrough.target, worktreePath }
        const reopened: SavedReview = {
          ...latest,
          walkthrough: { ...latest.walkthrough, target },
          lastOpenedAt: new Date(deps.now()).toISOString()
        }
        deps.reviews.save(reopened)
        walkthrough = reopened.walkthrough
        current = { target, files: walkthrough.files, changedLines: walkthrough.changedLines }
        reviewId = id
        sessionVerified = false
        return reopened
      } catch (err) {
        return toApiError(err)
      }
    },

    async saveReviewState({ id, state }) {
      // Re-read so costUsd and chatSessionId written here since the renderer loaded it survive.
      const review = deps.reviews.get(id)
      if (!review) return
      // The state comes from the renderer: a malformed one would make the file unreadable.
      const updated = { ...review, state }
      if (SavedReviewSchema.safeParse(updated).success) deps.reviews.save(updated)
    },

    async deleteReview(id) {
      const review = deps.reviews.get(id)
      if (!review) return null
      await removeReview(review)
      if (reviewId === id) {
        reviewId = null
        walkthrough = null
        current = null
      }
      return review
    },

    async restoreReview(review) {
      // Comes from the renderer: save only a well-formed review with a plain file-name id.
      const parsed = SavedReviewSchema.safeParse(review)
      if (!parsed.success || !isPlainId(parsed.data.id)) return
      deps.reviews.save(parsed.data)
    },

    async checkReviewUpdates(id) {
      const review = deps.reviews.get(id)
      if (!review) return null
      const result = await deps.checkForUpdates(review.walkthrough.target)
      if (!result) return null
      const update = { ...result, checkedAt: new Date(deps.now()).toISOString() }
      // Re-read: the review may have changed or been deleted during the check.
      const latest = deps.reviews.get(id)
      if (latest) deps.reviews.save({ ...latest, update })
      return update
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
  ipcMain.handle(IPC.listReviews, () => handlers.listReviews())
  ipcMain.handle(IPC.reopenReview, (_e, id) => handlers.reopenReview(id))
  ipcMain.handle(IPC.saveReviewState, (_e, req) => handlers.saveReviewState(req))
  ipcMain.handle(IPC.deleteReview, (_e, id) => handlers.deleteReview(id))
  ipcMain.handle(IPC.restoreReview, (_e, review) => handlers.restoreReview(review))
  ipcMain.handle(IPC.checkReviewUpdates, (_e, id) => handlers.checkReviewUpdates(id))
}
