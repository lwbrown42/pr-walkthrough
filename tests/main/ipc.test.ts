import { describe, expect, it, vi } from 'vitest'
import { createHandlers, type HandlerDeps } from '../../src/main/ipc'
import { AgentRunError } from '../../src/main/agent/options'
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
      appendRunLog: (e) => void log.push(e)
    },
    generateWalkthrough: vi.fn(async (args) => {
      args.onProgress?.({ turns: 1, lastTool: 'Read' })
      return {
        walkthrough: { summary: 's', steps: [step] },
        sessionId: 'sess1',
        costUsd: 0.5,
        turns: 4,
        durationMs: 99
      }
    }),
    askAboutStep: vi.fn(async () => ({ answer: 'yes', sessionId: 'sess2', costUsd: 0.1 })),
    resolveLocalBranch: vi.fn(async () => target),
    resolveGithubPr: vi.fn(async () => target),
    getChangedFiles: vi.fn(async () => files),
    countChangedLines: vi.fn(() => changed),
    readFileAt: vi.fn(async () => 'l1\nl2\nl3\n'),
    runGit: vi.fn(async () => 'DIFF'),
    worktreesDir: '/wts',
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
    expect(res).toMatchObject({ sessionId: 'sess1', changedLines: 10, summary: 's' })
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
      turns: 1,
      lastTool: 'Read',
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
    expect(log[0]).toMatchObject({ outcome: 'max_budget', costUsd: 3.1, turns: 22, durationMs: 5000 })
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
    expect(await p).toEqual({ error: { message: 'Generation was cancelled.', reason: 'cancelled' } })
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
    expect(calls[0][0]).toMatchObject({ sessionId: 'sess1', stepIndex: 0, worktreePath: '/wt' })
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
    const segs = (res as { steps: Step[] }).steps[0].segments
    expect(segs).toContainEqual({ kind: 'context', path: 'lib/util.ts', startLine: 2, endLine: 4 })
    expect(readFileAt).toHaveBeenCalledWith('/wt', 'head', 'lib/util.ts')
  })
})
