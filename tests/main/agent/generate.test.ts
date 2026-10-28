import { describe, expect, it, vi } from 'vitest'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { generateWalkthrough, type GenerateResult } from '../../../src/main/agent/generate'
import { AgentRunError } from '../../../src/main/agent/options'
import { buildWalkthroughPrompt, WALKTHROUGH_SYSTEM_PROMPT } from '../../../src/main/agent/prompt'
import { numberDiff } from '../../../src/main/git/diff'
import { agentWalkthroughJsonSchema, type AgentWalkthrough } from '../../../src/shared/walkthrough'
import type { ChangedFile, ReviewTarget, Settings } from '../../../src/shared/types'
import type { GenerateProgress } from '../../../src/shared/progress'

const target: ReviewTarget = {
  kind: 'github',
  repoPath: '/repo',
  worktreePath: '/tmp/wt',
  baseSha: 'b'.repeat(40),
  headSha: 'h'.repeat(40),
  title: 'Add retry to webhook delivery',
  prNumber: 482
}

const files: ChangedFile[] = [
  {
    path: 'src/webhooks/retry.ts',
    status: 'added',
    binary: false,
    additions: 10,
    deletions: 0,
    hunks: [{ id: 'src/webhooks/retry.ts#0', newStart: 1, newLines: 10, oldStart: 0, oldLines: 0 }]
  },
  {
    path: 'src/queue/job.ts',
    oldPath: 'src/queue/task.ts',
    status: 'renamed',
    binary: false,
    additions: 1,
    deletions: 1,
    hunks: [{ id: 'src/queue/job.ts#0', newStart: 3, newLines: 1, oldStart: 3, oldLines: 1 }]
  }
]

const diffText =
  'diff --git a/src/webhooks/retry.ts b/src/webhooks/retry.ts\n+export const retry = 1\n'
const lineCounts = {
  head: { 'src/webhooks/retry.ts': 10, 'src/queue/job.ts': 20 },
  base: { 'src/queue/task.ts': 20 }
}

const settings: Settings = {
  apiKey: 'sk-test',
  model: 'claude-opus-5-5',
  chatModel: 'claude-sonnet-5-5',
  maxTurns: 60,
  maxBudgetUsd: 3
}

const validOutput: AgentWalkthrough = {
  summary: 'Adds retry.',
  steps: [
    {
      id: 'retry',
      title: 'Retry policy',
      whyNext: '',
      explanation: 'Defines the retry policy.',
      segments: [{ kind: 'change', path: 'src/webhooks/retry.ts', startLine: 1, endLine: 10 }]
    },
    {
      id: 'job',
      title: 'Job',
      whyNext: 'The policy is attached to each job, so look there.',
      explanation: 'Jobs carry the policy.',
      segments: [{ kind: 'change', path: 'src/queue/job.ts', startLine: 3, endLine: 3 }]
    }
  ]
}

const assistantToolUse = (
  name: string,
  id = 'msg_1',
  input: Record<string, unknown> = {}
): SDKMessage =>
  ({
    type: 'assistant',
    message: { id, content: [{ type: 'tool_use', id: `tu_${id}`, name, input }] },
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000001',
    session_id: 's1'
  }) as unknown as SDKMessage

const result = (over: Record<string, unknown>): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's1',
    total_cost_usd: 0.42,
    num_turns: 3,
    result: '',
    ...over
  }) as unknown as SDKMessage

function fakeQuery(messages: SDKMessage[]): {
  fn: never
  calls: { prompt: unknown; options?: Options }[]
  spy: ReturnType<typeof vi.fn>
} {
  const calls: { prompt: unknown; options?: Options }[] = []
  const fn = vi.fn((params: { prompt: unknown; options?: Options }) => {
    calls.push(params)
    return (async function* () {
      for (const m of messages) yield m
    })()
  })
  return { fn: fn as never, calls, spy: fn }
}

const run = (
  queryFn: never,
  over: Partial<Settings> = {},
  onProgress?: (p: GenerateProgress) => void
): Promise<GenerateResult> =>
  generateWalkthrough({
    target,
    files,
    diffText,
    lineCounts,
    settings: { ...settings, ...over },
    onProgress,
    queryFn
  })

const rejectsWith = async (p: Promise<unknown>, reason: AgentRunError['reason']): Promise<void> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(AgentRunError)
  expect((err as AgentRunError).reason).toBe(reason)
}

describe('generateWalkthrough', () => {
  it('returns the normalized walkthrough, session, cost and turns, and reports tool progress', async () => {
    const q = fakeQuery([
      assistantToolUse('Read', 'msg_1', { file_path: '/tmp/wt/src/queue/job.ts' }),
      result({ structured_output: validOutput })
    ])
    const onProgress = vi.fn()
    const out = await run(q.fn, {}, onProgress)

    expect(out.sessionId).toBe('s1')
    expect(out.costUsd).toBe(0.42)
    expect(out.turns).toBe(3)
    expect(out.durationMs).toBeGreaterThanOrEqual(0)
    expect(out.walkthrough.steps.map((s) => s.id)).toEqual(['retry', 'job'])
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'reading',
        turns: 1,
        lookups: 1,
        filesTotal: 2,
        activity: [{ verb: 'Reading', target: 'src/queue/job.ts' }]
      })
    )
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'finishing' }))
  })

  it('normalizes the agent output (coverage fill adds Everything else)', async () => {
    const partial: AgentWalkthrough = { summary: 's', steps: [validOutput.steps[0]] }
    const q = fakeQuery([result({ structured_output: partial })])
    const out = await run(q.fn)
    const last = out.walkthrough.steps.at(-1)!
    expect(last.title).toBe('Everything else')
    expect(last.segments).toEqual([
      { kind: 'change', path: 'src/queue/job.ts', startLine: 3, endLine: 3 }
    ])
  })

  it('puts the author context in the prompt', async () => {
    const q = fakeQuery([result({ structured_output: validOutput })])
    const authorContext = { description: 'Adds retries.', commits: 'First' }
    await generateWalkthrough({
      target,
      files,
      diffText,
      lineCounts,
      settings,
      authorContext,
      queryFn: q.fn
    })
    expect(q.calls[0].prompt).toBe(buildWalkthroughPrompt(target, files, diffText, authorContext))
  })

  it('passes read-only, isolated options to the SDK', async () => {
    const q = fakeQuery([result({ structured_output: validOutput })])
    await run(q.fn)
    const { prompt, options } = q.calls[0]
    expect(prompt).toBe(buildWalkthroughPrompt(target, files, diffText))
    expect(options?.cwd).toBe('/tmp/wt')
    expect(options?.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(options?.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'StructuredOutput'])
    expect(options?.strictMcpConfig).toBe(true)
    expect(options?.settingSources).toEqual([])
    expect(options?.permissionMode).toBe('dontAsk')
    expect(options?.model).toBe('claude-opus-5-5')
    expect(options?.env?.PATH).toBe(process.env.PATH)
    expect(options?.env?.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(options?.maxTurns).toBe(settings.maxTurns)
    expect(options?.maxBudgetUsd).toBe(settings.maxBudgetUsd)
    expect(options?.outputFormat).toEqual({
      type: 'json_schema',
      schema: agentWalkthroughJsonSchema
    })
    expect(options?.systemPrompt).toBe(WALKTHROUGH_SYSTEM_PROMPT)
  })

  it('rejects with no_api_key without calling the SDK', async () => {
    const q = fakeQuery([])
    await rejectsWith(run(q.fn, { apiKey: null }), 'no_api_key')
    expect(q.spy).not.toHaveBeenCalled()
  })

  it.each([
    ['error_max_turns', 'max_turns'],
    ['error_max_budget_usd', 'max_budget'],
    ['error_max_structured_output_retries', 'invalid_output'],
    ['error_during_execution', 'failed']
  ] as const)('maps result subtype %s to %s', async (subtype, reason) => {
    const q = fakeQuery([result({ subtype, is_error: true, errors: ['boom'] })])
    await rejectsWith(run(q.fn), reason)
  })

  it('rejects invalid_output when success has no structured_output', async () => {
    await rejectsWith(run(fakeQuery([result({})]).fn), 'invalid_output')
  })

  it('rejects invalid_output when structured_output does not match the schema', async () => {
    await rejectsWith(
      run(fakeQuery([result({ structured_output: { summary: 1 } })]).fn),
      'invalid_output'
    )
  })

  it('rejects failed when success carries is_error', async () => {
    await rejectsWith(
      run(fakeQuery([result({ is_error: true, result: 'API error' })]).fn),
      'failed'
    )
  })

  it('rejects failed when the stream ends without a result', async () => {
    await rejectsWith(run(fakeQuery([assistantToolUse('Read')]).fn), 'failed')
  })

  it('carries cost, turns and duration on a failed result', async () => {
    const q = fakeQuery([
      result({
        subtype: 'error_max_turns',
        is_error: true,
        total_cost_usd: 1.5,
        num_turns: 60,
        duration_ms: 4200
      })
    ])
    const err = (await run(q.fn).catch((e: unknown) => e)) as AgentRunError
    expect(err.reason).toBe('max_turns')
    expect(err).toMatchObject({ costUsd: 1.5, turns: 60, durationMs: 4200 })
  })

  it('passes the abortController and maps an aborted run to cancelled', async () => {
    const ac = new AbortController()
    const queryFn = ((params: { options?: Options }) => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          expect(params.options?.abortController).toBe(ac)
          ac.abort()
          throw new Error('Operation aborted')
        }
      })
    })) as never
    const p = generateWalkthrough({
      target,
      files,
      diffText,
      lineCounts,
      settings,
      queryFn,
      abortController: ac
    })
    await rejectsWith(p, 'cancelled')
  })

  it('reads line counts for context segments on unchanged files only', async () => {
    const out: AgentWalkthrough = {
      summary: 's',
      steps: [
        {
          ...validOutput.steps[0],
          segments: [
            ...validOutput.steps[0].segments,
            { kind: 'context', path: 'src/types.ts', startLine: 5, endLine: 50 },
            { kind: 'context', path: 'missing.ts', startLine: 1, endLine: 2 }
          ]
        },
        validOutput.steps[1]
      ]
    }
    const readLineCount = vi.fn(async (p: string) => (p === 'src/types.ts' ? 12 : null))
    const w = await generateWalkthrough({
      target,
      files,
      diffText,
      lineCounts,
      settings,
      readLineCount,
      queryFn: fakeQuery([result({ structured_output: out })]).fn
    })
    expect(readLineCount.mock.calls.map((c) => c[0]).sort()).toEqual(['missing.ts', 'src/types.ts'])
    expect(w.walkthrough.steps[0].segments).toEqual([
      { kind: 'change', path: 'src/webhooks/retry.ts', startLine: 1, endLine: 10 },
      { kind: 'context', path: 'src/types.ts', startLine: 5, endLine: 12 }
    ])
  })

  it('wraps a thrown SDK error as failed', async () => {
    const queryFn = (() => {
      throw new Error('spawn failed')
    }) as never
    await rejectsWith(run(queryFn), 'failed')
  })
})

describe('buildWalkthroughPrompt', () => {
  it('contains the PR title, every changed path with status, and the diff', () => {
    const p = buildWalkthroughPrompt(target, files, diffText)
    expect(p).toContain('Add retry to webhook delivery')
    for (const f of files) expect(p).toContain(f.path)
    expect(p).toContain('src/queue/task.ts')
    expect(p).toContain('renamed')
    expect(p).toContain(numberDiff(diffText))
  })

  it('leaves out the author blocks when there is no author context', () => {
    for (const p of [
      buildWalkthroughPrompt(target, files, diffText),
      buildWalkthroughPrompt(target, files, diffText, { description: null, commits: null })
    ]) {
      expect(p).not.toContain('<pr_description>')
      expect(p).not.toContain('<commits')
      expect(p).not.toContain("author's own account")
    }
  })

  it('puts the description and commits before the diff', () => {
    const p = buildWalkthroughPrompt(target, files, diffText, {
      description: 'Retries failed webhooks.',
      commits: 'Add retry\n\nBackoff too.'
    })
    expect(p).toContain('<pr_description>\nRetries failed webhooks.\n</pr_description>')
    expect(p).toContain('<commits order="oldest first">\nAdd retry\n\nBackoff too.\n</commits>')
    expect(p.indexOf('<pr_description>')).toBeLessThan(p.indexOf('<diff'))
    expect(p.indexOf('<commits')).toBeLessThan(p.indexOf('<diff'))
  })

  it('includes only the block it was given', () => {
    const p = buildWalkthroughPrompt(target, files, diffText, { commits: 'Add retry' })
    expect(p).toContain('<commits')
    expect(p).not.toContain('<pr_description>')
  })
})

describe('buildWalkthroughPrompt omitted diffs', () => {
  it('marks files whose diff the prompt leaves out', () => {
    const lock: ChangedFile = {
      ...files[0],
      path: 'package-lock.json',
      status: 'modified',
      additions: 300,
      deletions: 20
    }
    const p = buildWalkthroughPrompt(target, [lock, files[0]], diffText)
    expect(p).toContain('- modified package-lock.json (+300 -20, diff omitted)')
    expect(p).not.toContain(
      `${files[0].path} (+${files[0].additions} -${files[0].deletions}, diff omitted)`
    )
  })
})

describe('WALKTHROUGH_SYSTEM_PROMPT', () => {
  it('carries the spec-fixed rules', () => {
    for (const s of [
      'core idea',
      'newcomer',
      'existing code as a context segment',
      'depth-first',
      'Separate fix:',
      'whyNext',
      'parentId',
      'one level deep',
      'kind "context"',
      'Everything else',
      '1-based',
      '1 to 3 short paragraphs',
      'separated by a blank line',
      'Only backticks are rendered',
      'diff omitted',
      'numbered diff',
      'begins partway into it'
    ])
      expect(WALKTHROUGH_SYSTEM_PROMPT).toContain(s)
  })
})

describe('token usage', () => {
  const modelUsage = {
    'claude-opus-5-5': {
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadInputTokens: 50000,
      cacheCreationInputTokens: 4000,
      webSearchRequests: 0,
      costUSD: 0.4,
      contextWindow: 200000,
      maxOutputTokens: 32000
    },
    'claude-haiku-5-5': {
      inputTokens: 300,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.02,
      contextWindow: 200000,
      maxOutputTokens: 8000
    }
  }

  it('returns token totals and a per-model breakdown from modelUsage', async () => {
    const q = fakeQuery([result({ structured_output: validOutput, modelUsage })])
    const r = await run(q.fn)
    expect(r.tokens).toEqual({ input: 1500, output: 820, cacheRead: 50000, cacheCreation: 4000 })
    expect(r.tokensByModel?.['claude-haiku-5-5']).toEqual({
      input: 300,
      output: 20,
      cacheRead: 0,
      cacheCreation: 0
    })
  })

  it('returns null tokens when the SDK reports no modelUsage', async () => {
    const q = fakeQuery([result({ structured_output: validOutput })])
    const r = await run(q.fn)
    expect(r.tokens).toBeNull()
    expect(r.tokensByModel).toBeNull()
  })

  it('carries tokens on the error when a cap is hit', async () => {
    const q = fakeQuery([result({ subtype: 'error_max_budget_usd', errors: [], modelUsage })])
    const err = (await run(q.fn).catch((e: unknown) => e)) as AgentRunError
    expect(err.reason).toBe('max_budget')
    expect(err.tokens?.output).toBe(820)
  })
})

describe('progress while the walkthrough is written', () => {
  const ev = (event: Record<string, unknown>): SDKMessage =>
    ({ type: 'stream_event', event, parent_tool_use_id: null }) as unknown as SDKMessage

  it('streams partial messages and reports step titles as they are written', async () => {
    const json = JSON.stringify(validOutput)
    const cut = json.indexOf('"title":"Job"') + 5
    const q = fakeQuery([
      ev({ type: 'message_start', message: { id: 'msg_9' } }),
      ev({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_9', name: 'StructuredOutput', input: {} }
      }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) }
      }),
      ev({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: json.slice(cut) }
      }),
      result({ structured_output: validOutput })
    ])
    const onProgress = vi.fn()
    await run(q.fn, {}, onProgress)

    expect(q.calls[0].options?.includePartialMessages).toBe(true)
    const snaps = onProgress.mock.calls.map((c) => c[0] as GenerateProgress)
    expect(snaps.find((p) => p.stage === 'writing' && p.stepTitles.length === 0)).toBeTruthy()
    expect(snaps.find((p) => p.stepTitles.join('|') === 'Retry policy')).toBeTruthy()
    expect(snaps.find((p) => p.stepTitles.join('|') === 'Retry policy|Job')).toBeTruthy()
  })

  it('falls back to the complete StructuredOutput block when nothing streamed', async () => {
    const q = fakeQuery([
      assistantToolUse(
        'StructuredOutput',
        'msg_2',
        validOutput as unknown as Record<string, unknown>
      ),
      result({ structured_output: validOutput })
    ])
    const onProgress = vi.fn()
    await run(q.fn, {}, onProgress)
    const writing = onProgress.mock.calls
      .map((c) => c[0] as GenerateProgress)
      .find((p) => p.stage === 'writing')
    expect(writing?.stepTitles).toEqual(['Retry policy', 'Job'])
  })
})
