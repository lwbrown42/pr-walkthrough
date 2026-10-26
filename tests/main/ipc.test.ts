import { describe, expect, it, vi } from 'vitest'
import { createHandlers, type HandlerDeps } from '../../src/main/ipc'
import { AgentRunError } from '../../src/main/agent/options'
import type { ReviewStore } from '../../src/main/reviews/store'
import { reviewKey, type SavedReview } from '../../src/shared/reviews'
import type { ChangedFile, ReviewTarget, RunLogEntry, Settings } from '../../src/shared/types'
import type { Step } from '../../src/shared/walkthrough'

const target: ReviewTarget = {
  kind: 'local',
  repoPath: '/repo',
  worktreePath: '/wt',
  baseSha: 'base',
  headSha: 'head',
  title: 'feat/x'
}

const file = (over: Partial<ChangedFile>): ChangedFile => ({
  path: 'a.ts',
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 0,
  hunks: [],
  ...over
})

const step: Step = { id: 's1', title: 'T', whyNext: '', explanation: 'E', segments: [] }

/** In-memory ReviewStore; copies on the way in and out, like the disk store. */
function memStore(initial: SavedReview[] = []): ReviewStore {
  const data = new Map(initial.map((r) => [r.id, structuredClone(r)]))
  return {
    list: () => [...data.values()].map((r) => structuredClone(r)),
    get: (id) => (data.has(id) ? structuredClone(data.get(id)!) : null),
    findByKey: (key) => {
      const r = [...data.values()].find((x) => x.key === key)
      return r ? structuredClone(r) : null
    },
    save: vi.fn((r: SavedReview) => void data.set(r.id, structuredClone(r))),
    remove: (id) => void data.delete(id)
  }
}

const savedReview = (over: Partial<SavedReview> = {}, t: ReviewTarget = target): SavedReview => ({
  id: 'old-id',
  key: reviewKey(t),
  walkthrough: {
    summary: 'old summary',
    steps: [step, { ...step, id: 's2' }],
    target: { ...t, worktreePath: '/wt-old', headSha: 'oldhead' },
    files: [],
    changedLines: 5,
    sessionId: 'old-sess'
  },
  state: {
    index: 1,
    seen: [0],
    mode: 'plain',
    messages: [{ id: 'm1', stepId: 's1', role: 'user', text: 'q' }]
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  generatedAt: '2026-10-01T00:00:00.000Z',
  lastOpenedAt: '2026-10-02T00:00:00.000Z',
  costUsd: 2,
  update: { latestHeadSha: 'newer', newCommits: 1, checkedAt: '2026-10-02T00:00:00.000Z' },
  ...over
})

function setup(
  over: Partial<HandlerDeps> = {},
  files: ChangedFile[] = [file({})],
  changed = 10
): { h: ReturnType<typeof createHandlers>; deps: HandlerDeps; log: RunLogEntry[] } {
  const log: RunLogEntry[] = []
  const settings: Settings = { apiKey: 'sk-secret', model: 'm', maxTurns: 1, maxBudgetUsd: 1 }
  let t = 1000
  const deps: HandlerDeps = {
    settings: {
      get: () => settings,
      save: vi.fn(() => settings),
      appendRunLog: (e) => void log.push(e),
      readRunLog: () => [...log]
    },
    generateWalkthrough: vi.fn(async (args) => {
      args.onProgress?.({
        stage: 'reading',
        turns: 1,
        lookups: 1,
        filesTotal: 3,
        activity: [{ verb: 'Reading', target: 'new.ts' }],
        stepTitles: []
      })
      return {
        walkthrough: { summary: 's', steps: [step] },
        sessionId: 'sess1',
        costUsd: 0.5,
        turns: 4,
        durationMs: 99,
        tokens: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 10 },
        tokensByModel: { m: { input: 100, output: 50, cacheRead: 1000, cacheCreation: 10 } }
      }
    }),
    askAboutStep: vi.fn(async () => ({
      answer: 'yes',
      sessionId: 'sess2',
      costUsd: 0.1,
      turns: 2,
      durationMs: 700,
      tokens: { input: 5, output: 7, cacheRead: 900, cacheCreation: 0 },
      tokensByModel: null
    })),
    resolveLocalBranch: vi.fn(async () => target),
    resolveGithubPr: vi.fn(async () => target),
    getChangedFiles: vi.fn(async () => files),
    countChangedLines: vi.fn(() => changed),
    readFileAt: vi.fn(async () => 'l1\nl2\nl3\n'),
    runGit: vi.fn(async () => 'DIFF'),
    worktreesDir: '/wts',
    reviews: memStore(),
    checkForUpdates: vi.fn(async () => null),
    ensureWorktree: vi.fn(async () => '/wt'),
    commitExists: vi.fn(async () => true),
    newId: () => 'new-id',
    pickRepo: async () => null,
    send: vi.fn(),
    now: () => (t += 10),
    ...over
  }
  return { h: createHandlers(deps), deps, log }
}

const local = { kind: 'local', repoPath: '/repo', headRef: 'feat/x' } as const

describe('openTarget', () => {
  it('flags overLimit only above 1300 changed lines', async () => {
    expect(await setup({}, undefined, 1300).h.openTarget(local)).toMatchObject({
      changedLines: 1300,
      overLimit: false
    })
    expect(await setup({}, undefined, 1301).h.openTarget(local)).toMatchObject({
      changedLines: 1301,
      overLimit: true
    })
  })

  it('persists lastRepoPath on success', async () => {
    const { h, deps } = setup()
    await h.openTarget(local)
    expect(deps.settings.save).toHaveBeenCalledWith({ lastRepoPath: '/repo' })
  })

  it('returns an error object instead of rejecting', async () => {
    const { h, deps } = setup({
      resolveGithubPr: vi.fn(async () => {
        throw new Error('gh broke')
      })
    })
    expect(await h.openTarget({ kind: 'github', repoPath: '/repo', pr: '1' })).toEqual({
      error: { message: 'gh broke' }
    })
    expect(deps.settings.save).not.toHaveBeenCalled()
  })
})

describe('generate', () => {
  it('logs success, sends progress, and passes diff and line counts', async () => {
    const files = [
      file({ path: 'new.ts', oldPath: 'old.ts', status: 'renamed' }),
      file({ path: 'bin.png', binary: true }),
      file({ path: 'gone.ts', status: 'deleted' })
    ]
    const { h, deps, log } = setup({}, files)
    await h.openTarget(local)
    const res = await h.generate(target)
    expect(res).toMatchObject({
      walkthrough: { sessionId: 'sess1', changedLines: 10, summary: 's' }
    })
    expect(deps.runGit).toHaveBeenCalledWith('/wt', [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-M',
      'base',
      'head'
    ])
    const args = vi.mocked(deps.generateWalkthrough).mock.calls[0][0]
    expect(args.diffText).toBe('DIFF')
    expect(args.lineCounts).toEqual({ head: { 'new.ts': 3 }, base: { 'old.ts': 3, 'gone.ts': 3 } })
    expect(deps.send).toHaveBeenCalledWith('api:generateProgress', {
      stage: 'reading',
      turns: 1,
      lookups: 1,
      filesTotal: 3,
      activity: [{ verb: 'Reading', target: 'new.ts' }],
      stepTitles: [],
      elapsedMs: expect.any(Number)
    })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      kind: 'generate',
      prTitle: 'feat/x',
      changedLines: 10,
      outcome: 'success',
      costUsd: 0.5,
      turns: 4,
      durationMs: 99
    })
  })

  it('logs the AgentRunError reason on failure and returns an error', async () => {
    const { h, log } = setup({
      generateWalkthrough: vi.fn(async () => {
        throw new AgentRunError('max_turns', 'too many turns')
      })
    })
    await h.openTarget(local)
    expect(await h.generate(target)).toEqual({
      error: { message: 'too many turns', reason: 'max_turns' }
    })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      outcome: 'max_turns',
      costUsd: null,
      turns: null,
      durationMs: 10
    })
  })

  it('logs the cost, turns and duration a failed run reports', async () => {
    const { h, log } = setup({
      generateWalkthrough: vi.fn(async () => {
        throw new AgentRunError('max_budget', 'over', {
          usage: { costUsd: 3.1, turns: 22, durationMs: 5000 }
        })
      })
    })
    await h.generate(target)
    expect(log[0]).toMatchObject({
      outcome: 'max_budget',
      costUsd: 3.1,
      turns: 22,
      durationMs: 5000
    })
  })

  it('skips a file whose contents cannot be read instead of failing', async () => {
    const files = [file({ path: 'ok.ts' }), file({ path: 'sub' })]
    const { h, deps } = setup(
      {
        readFileAt: vi.fn(async (_c: string, _s: string, p: string) => {
          if (p === 'sub') throw new Error('fatal: bad object')
          return 'x\n'
        })
      },
      files
    )
    await h.openTarget(local)
    expect(await h.generate(target)).not.toHaveProperty('error')
    const args = vi.mocked(deps.generateWalkthrough).mock.calls[0][0]
    expect(args.lineCounts).toEqual({ head: { 'ok.ts': 1 }, base: { 'ok.ts': 1 } })
  })

  it('cancelGenerate aborts the run, returns a cancelled error, and logs cancelled', async () => {
    const { h, log } = setup({
      generateWalkthrough: vi.fn(
        (args) =>
          new Promise((_resolve, reject) => {
            args.abortController!.signal.addEventListener('abort', () =>
              reject(new AgentRunError('cancelled', 'Generation was cancelled.'))
            )
          })
      )
    })
    await h.openTarget(local)
    const p = h.generate(target)
    await new Promise((r) => setTimeout(r, 0))
    await h.cancelGenerate()
    expect(await p).toEqual({
      error: { message: 'Generation was cancelled.', reason: 'cancelled' }
    })
    expect(log[0].outcome).toBe('cancelled')
  })

  it('logs "failed" for non-agent errors', async () => {
    const { h, log } = setup({
      runGit: vi.fn(async () => {
        throw new Error('git died')
      })
    })
    expect(await h.generate(target)).toEqual({ error: { message: 'git died' } })
    expect(log[0].outcome).toBe('failed')
  })
})

describe('ask', () => {
  it('asks about the step, keeps the new session id, and returns an assistant message', async () => {
    const { h, deps } = setup()
    await h.generate(target)
    const msg = await h.ask({ stepId: 's1', question: 'why?' })
    expect(msg).toMatchObject({ stepId: 's1', role: 'assistant', text: 'yes' })
    await h.ask({ stepId: 's1', question: 'again?' })
    const calls = vi.mocked(deps.askAboutStep).mock.calls
    expect(calls[0][0]).toMatchObject({ sessionId: 'sess1', stepLabel: '1', worktreePath: '/wt' })
    expect(calls[1][0].sessionId).toBe('sess2')
  })

  it('errors without a walkthrough or for an unknown step', async () => {
    const { h } = setup()
    expect(await h.ask({ stepId: 's1', question: 'q' })).toHaveProperty('error')
    await h.generate(target)
    expect(await h.ask({ stepId: 'nope', question: 'q' })).toHaveProperty('error')
  })
})

describe('getSettings / readFile', () => {
  it('never returns the key, only hasApiKey', async () => {
    const s = await setup().h.getSettings()
    expect(s).not.toHaveProperty('apiKey')
    expect(JSON.stringify(s)).not.toContain('sk-secret')
    expect(s.hasApiKey).toBe(true)
  })

  it('reads files from the current worktree', async () => {
    const { h, deps } = setup()
    expect(await h.readFile({ sha: 'head', path: 'a.ts' })).toBeNull()
    await h.openTarget(local)
    await h.readFile({ sha: 'head', path: 'a.ts' })
    expect(deps.readFileAt).toHaveBeenCalledWith('/wt', 'head', 'a.ts')
  })
})

describe('generate with the real walkthrough pipeline', () => {
  it('keeps a context segment on a file the PR did not change', async () => {
    const { generateWalkthrough } = await import('../../src/main/agent/generate')
    const output = {
      summary: 's',
      steps: [
        {
          id: 's1',
          title: 'T',
          whyNext: '',
          explanation: 'E',
          segments: [
            { kind: 'change', path: 'a.ts', startLine: 1, endLine: 1 },
            { kind: 'context', path: 'lib/util.ts', startLine: 2, endLine: 9 }
          ]
        }
      ]
    }
    const queryFn = (() =>
      (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'sess1',
          total_cost_usd: 0.1,
          num_turns: 1,
          result: '',
          structured_output: output
        }
      })()) as never
    const readFileAt = vi.fn(async (_cwd: string, _sha: string, path: string) =>
      path === 'lib/util.ts' ? 'u1\nu2\nu3\nu4\n' : 'l1\nl2\nl3\n'
    )
    const { h } = setup({
      readFileAt,
      generateWalkthrough: (args) => generateWalkthrough({ ...args, queryFn })
    })
    const res = await h.generate(target)
    expect(res).not.toHaveProperty('error')
    const segs = (res as SavedReview).walkthrough.steps[0].segments
    expect(segs).toContainEqual({ kind: 'context', path: 'lib/util.ts', startLine: 2, endLine: 4 })
    expect(readFileAt).toHaveBeenCalledWith('/wt', 'head', 'lib/util.ts')
  })
})

describe('usage logging', () => {
  it('logs generation tokens and the per-model breakdown', async () => {
    const { h, log } = setup()
    await h.generate(target)
    expect(log[0].tokens).toEqual({ input: 100, output: 50, cacheRead: 1000, cacheCreation: 10 })
    expect(log[0].tokensByModel?.m.output).toBe(50)
  })

  it('logs tokens a failed run reports', async () => {
    const { h, log } = setup({
      generateWalkthrough: vi.fn(async () => {
        throw new AgentRunError('max_budget', 'over', {
          usage: { tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } }
        })
      })
    })
    await h.generate(target)
    expect(log[0].tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 })
  })

  it('logs each chat question as a chat entry under the PR title', async () => {
    const { h, log } = setup()
    await h.generate(target)
    await h.ask({ stepId: 's1', question: 'why?' })
    expect(log).toHaveLength(2)
    expect(log[1]).toMatchObject({
      kind: 'chat',
      prTitle: 'feat/x',
      outcome: 'success',
      costUsd: 0.1,
      turns: 2,
      durationMs: 700,
      tokens: { input: 5, output: 7, cacheRead: 900, cacheCreation: 0 }
    })
  })

  it('logs a failed chat question with its reason', async () => {
    const { h, log } = setup({
      askAboutStep: vi.fn(async () => {
        throw new AgentRunError('max_turns', 'too many')
      })
    })
    await h.generate(target)
    await h.ask({ stepId: 's1', question: 'why?' })
    expect(log[1]).toMatchObject({ kind: 'chat', outcome: 'max_turns', costUsd: null })
  })

  it('getRunLog returns the logged runs', async () => {
    const { h } = setup()
    await h.generate(target)
    expect(await h.getRunLog()).toHaveLength(1)
  })
})

describe('getReviewUsage', () => {
  it('is zero before any walkthrough', async () => {
    expect(await setup().h.getReviewUsage()).toMatchObject({ runs: 0, costUsd: 0 })
  })

  it('counts the generation and each chat question for the current review', async () => {
    const { h } = setup()
    await h.generate(target)
    await h.ask({ stepId: 's1', question: 'why?' })
    const u = await h.getReviewUsage()
    expect(u.runs).toBe(2)
    expect(u.costUsd).toBeCloseTo(0.6)
    expect(u.tokens.output).toBe(57)
  })

  it('starts over when a different review is generated', async () => {
    let n = 0
    const { h } = setup({ newId: () => `id-${++n}` })
    await h.generate(target)
    await h.ask({ stepId: 's1', question: 'why?' })
    await h.generate({ ...target, headRef: 'feat/y', title: 'feat/y' })
    expect(await h.getReviewUsage()).toMatchObject({ runs: 1, costUsd: 0.5 })
  })

  it("getReviewUsage counts only the open review's runs", async () => {
    const { h, log } = setup()
    log.push(
      {
        at: 'x',
        kind: 'generate',
        prTitle: 'other',
        changedLines: 1,
        durationMs: 1,
        costUsd: 9,
        turns: 1,
        outcome: 'success',
        reviewId: 'other-id'
      },
      {
        at: 'x',
        kind: 'chat',
        prTitle: 'old',
        changedLines: 1,
        durationMs: 1,
        costUsd: 4,
        turns: 1,
        outcome: 'success'
      }
    )
    await h.generate(target)
    await h.ask({ stepId: 's1', question: 'why?' })
    const u = await h.getReviewUsage()
    expect(u.runs).toBe(2)
    expect(u.costUsd).toBeCloseTo(0.6)
  })
})

describe('saved reviews', () => {
  it('generate saves a new review with reviewId on its run-log entry and costUsd 0.5', async () => {
    const { h, deps, log } = setup()
    await h.openTarget(local)
    const res = await h.generate(target)
    const stored = deps.reviews.get('new-id')
    expect(res).toEqual(stored)
    expect(stored).toMatchObject({
      id: 'new-id',
      key: reviewKey(target),
      costUsd: 0.5,
      state: { index: 0, seen: [0], mode: 'diff', messages: [] },
      walkthrough: { summary: 's', sessionId: 'sess1', target, changedLines: 10 }
    })
    expect(stored!.createdAt).toBe(stored!.generatedAt)
    expect(stored!.lastOpenedAt).toBe(stored!.generatedAt)
    expect(log[0].reviewId).toBe('new-id')
  })

  it('generate for the same key keeps id and createdAt, resets messages and index, keeps mode', async () => {
    const reviews = memStore([savedReview()])
    const { h } = setup({ reviews })
    const res = (await h.generate(target)) as SavedReview
    expect(res).toMatchObject({
      id: 'old-id',
      createdAt: '2026-10-01T00:00:00.000Z',
      costUsd: 2.5,
      state: { index: 0, seen: [0], mode: 'plain', messages: [] },
      walkthrough: { summary: 's', sessionId: 'sess1', target }
    })
    expect(res.generatedAt).not.toBe('2026-10-01T00:00:00.000Z')
    expect(res.lastOpenedAt).toBe(res.generatedAt)
    expect(res).not.toHaveProperty('update')
    expect(reviews.list()).toHaveLength(1)
    expect(reviews.get('old-id')).toEqual(res)
  })

  it('failed generate leaves the saved review unchanged except costUsd', async () => {
    const reviews = memStore([savedReview()])
    const { h, log } = setup({
      reviews,
      generateWalkthrough: vi.fn(async () => {
        throw new AgentRunError('max_budget', 'over', { usage: { costUsd: 0.75 } })
      })
    })
    expect(await h.generate(target)).toHaveProperty('error')
    expect(reviews.get('old-id')).toEqual(savedReview({ costUsd: 2.75 }))
    expect(log[0].reviewId).toBe('old-id')
  })

  it('cancelled generate adds its cost to the saved review and changes nothing else', async () => {
    const reviews = memStore([savedReview()])
    const { h } = setup({
      reviews,
      generateWalkthrough: vi.fn(
        (args) =>
          new Promise((_resolve, reject) => {
            args.abortController!.signal.addEventListener('abort', () =>
              reject(new AgentRunError('cancelled', 'c', { usage: { costUsd: 0.25 } }))
            )
          })
      )
    })
    const p = h.generate(target)
    await new Promise((r) => setTimeout(r, 0))
    await h.cancelGenerate()
    await p
    expect(reviews.get('old-id')).toEqual(savedReview({ costUsd: 2.25 }))
  })

  it('failed generate with no saved review saves nothing', async () => {
    const reviews = memStore()
    const { h } = setup({
      reviews,
      generateWalkthrough: vi.fn(async () => {
        throw new AgentRunError('failed', 'x', { usage: { costUsd: 1 } })
      })
    })
    await h.generate(target)
    expect(reviews.list()).toEqual([])
  })

  it('regenerate removes the old worktree when no other review uses it', async () => {
    const { h, deps } = setup({ reviews: memStore([savedReview()]) })
    await h.generate(target)
    expect(deps.runGit).toHaveBeenCalledWith('/repo', ['worktree', 'remove', '--force', '/wt-old'])
  })

  it('regenerate ignores a failure to remove the old worktree', async () => {
    const { h } = setup({
      reviews: memStore([savedReview()]),
      runGit: vi.fn(async (_cwd: string, args: string[]) => {
        if (args[0] === 'worktree') throw new Error('locked')
        return 'DIFF'
      })
    })
    expect(await h.generate(target)).not.toHaveProperty('error')
  })

  it('regenerate keeps the old worktree when another review shares it', async () => {
    const pr: ReviewTarget = { ...target, kind: 'github', prNumber: 7, title: 'PR 7' }
    const other = savedReview({ id: 'pr-id' }, pr)
    const { h, deps } = setup({ reviews: memStore([savedReview(), other]) })
    await h.generate(target)
    expect(deps.runGit).not.toHaveBeenCalledWith('/repo', expect.arrayContaining(['worktree']))
  })

  it('regenerate keeps the worktree when the path is unchanged', async () => {
    const r = savedReview()
    r.walkthrough.target.worktreePath = '/wt'
    const { h, deps } = setup({ reviews: memStore([r]) })
    await h.generate(target)
    expect(deps.runGit).not.toHaveBeenCalledWith('/repo', expect.arrayContaining(['worktree']))
  })

  it('openTarget reports nothing saved when there is no review for the key', async () => {
    const res = await setup().h.openTarget(local)
    expect(res).not.toHaveProperty('saved')
  })

  it('openTarget reports saved with newCommits 0 for the same head', async () => {
    const r = savedReview()
    r.walkthrough.target.headSha = 'head'
    const { h, deps } = setup({ reviews: memStore([r]) })
    expect(await h.openTarget(local)).toMatchObject({
      saved: {
        id: 'old-id',
        progress: 'step 2 of 2',
        lastOpenedAt: '2026-10-02T00:00:00.000Z',
        newCommits: 0
      }
    })
    expect(deps.runGit).not.toHaveBeenCalled()
  })

  it('openTarget reports saved newCommits from rev-list when the head moved', async () => {
    const { h, deps } = setup({
      reviews: memStore([savedReview()]),
      runGit: vi.fn(async () => '3\n')
    })
    expect(await h.openTarget(local)).toMatchObject({ saved: { id: 'old-id', newCommits: 3 } })
    expect(deps.runGit).toHaveBeenCalledWith('/repo', ['rev-list', '--count', 'oldhead..head'])
  })

  it('openTarget reports saved newCommits null when rev-list fails', async () => {
    const { h } = setup({
      reviews: memStore([savedReview()]),
      runGit: vi.fn(async () => {
        throw new Error('bad revision')
      })
    })
    expect(await h.openTarget(local)).toMatchObject({ saved: { newCommits: null } })
  })

  it('ask persists the new sessionId and adds chat cost to the review', async () => {
    const reviews = memStore()
    const { h, log } = setup({ reviews })
    await h.generate(target)
    await h.ask({ stepId: 's1', question: 'why?' })
    const r = reviews.get('new-id')!
    expect(r.walkthrough.sessionId).toBe('sess2')
    expect(r.costUsd).toBeCloseTo(0.6)
    expect(r.state.messages).toEqual([])
    expect(log[1].reviewId).toBe('new-id')
  })

  it('ask does not retry a failed resume once the session is known to work', async () => {
    const { h, deps, log } = setup({
      askAboutStep: vi.fn(async () => {
        throw new AgentRunError('failed', 'no session')
      })
    })
    await h.generate(target)
    expect(await h.ask({ stepId: 's1', question: 'why?' })).toHaveProperty('error')
    expect(deps.askAboutStep).toHaveBeenCalledTimes(1)
    expect(log).toHaveLength(2)
  })

  // Unreachable until Task 7: a session is unverified only after a reopen, and generate verifies it.
  it.todo('ask retries once in a fresh session when resume fails')
})
