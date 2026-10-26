import { describe, expect, it, vi } from 'vitest'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { askAboutStep, type AskResult } from '../../../src/main/agent/chat'
import { AgentRunError } from '../../../src/main/agent/options'
import { buildChatPrompt, buildSeededChatPrompt } from '../../../src/main/agent/prompt'
import type { Settings } from '../../../src/shared/types'
import type { AgentWalkthrough, Step } from '../../../src/shared/walkthrough'

const settings: Settings = {
  apiKey: 'sk-test',
  model: 'claude-opus-5-5',
  maxTurns: 60,
  maxBudgetUsd: 3
}

const step: Step = {
  id: 'job',
  title: 'Job carries the policy',
  whyNext: 'x',
  explanation: 'Jobs carry the policy.',
  segments: [{ kind: 'change', path: 'src/queue/job.ts', startLine: 3, endLine: 5 }]
}

const delta = (text: string, parent: string | null = null): SDKMessage =>
  ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: parent,
    uuid: 'u',
    session_id: 's1'
  }) as unknown as SDKMessage

const assistantText = (text: string, id = 'm1', parent: string | null = null): SDKMessage =>
  ({
    type: 'assistant',
    message: { id, content: [{ type: 'text', text }] },
    parent_tool_use_id: parent,
    uuid: 'u',
    session_id: 's1'
  }) as unknown as SDKMessage

const result = (over: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's2',
    total_cost_usd: 0.1,
    result: '',
    ...over
  }) as unknown as SDKMessage

function fakeQuery(messages: SDKMessage[]): {
  fn: never
  calls: { prompt: unknown; options?: Options }[]
} {
  const calls: { prompt: unknown; options?: Options }[] = []
  const fn = vi.fn((params: { prompt: unknown; options?: Options }) => {
    calls.push(params)
    return (async function* () {
      for (const m of messages) yield m
    })()
  })
  return { fn: fn as never, calls }
}

const ask = (
  queryFn: never,
  onText?: (c: string) => void,
  over: Partial<Settings> = {}
): Promise<AskResult> =>
  askAboutStep({
    sessionId: 's1',
    worktreePath: '/tmp/wt',
    step,
    stepLabel: '1a',
    question: 'Why here?',
    settings: { ...settings, ...over },
    onText,
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

describe('buildChatPrompt', () => {
  it('names the step label and title and carries the question', () => {
    const p = buildChatPrompt(step, '1a', 'Why here?')
    expect(p).toContain('step 1a')
    expect(p).toContain('Job carries the policy')
    expect(p).toContain('Why here?')
    expect(p).toContain('path:line')
  })
})

describe('askAboutStep', () => {
  it('resumes the session, has no outputFormat, and stays read-only', async () => {
    const q = fakeQuery([assistantText('Hi'), result()])
    await ask(q.fn)
    const o = q.calls[0].options!
    expect(o.resume).toBe('s1')
    expect(o).not.toHaveProperty('outputFormat')
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(o.cwd).toBe('/tmp/wt')
    expect(q.calls[0].prompt).toBe(buildChatPrompt(step, '1a', 'Why here?'))
  })

  it('streams text deltas in order, ignores subagent output, and returns answer, session and cost', async () => {
    const onText = vi.fn()
    const q = fakeQuery([
      delta('Because '),
      delta('ignored', 'tu_x'),
      delta('it is.'),
      assistantText('Because it is.'),
      assistantText('sub', 'm2', 'tu_x'),
      result()
    ])
    const out = await ask(q.fn, onText)
    expect(onText.mock.calls.map((c) => c[0])).toEqual(['Because ', 'it is.'])
    expect(out).toMatchObject({ answer: 'Because it is.', sessionId: 's2', costUsd: 0.1 })
  })

  it('falls back to assistant text blocks when no deltas arrive, separating turns', async () => {
    const onText = vi.fn()
    const q = fakeQuery([assistantText('One.', 'm1'), assistantText('Two.', 'm2'), result()])
    const out = await ask(q.fn, onText)
    expect(onText.mock.calls.map((c) => c[0])).toEqual(['One.', '\n\n', 'Two.'])
    expect(out.answer).toBe('One.\n\nTwo.')
  })

  it('separates streamed turns around a tool use and answers with the result text', async () => {
    const onText = vi.fn()
    const start = (id: string): SDKMessage =>
      ({
        type: 'stream_event',
        event: { type: 'message_start', message: { id } },
        parent_tool_use_id: null,
        uuid: 'u',
        session_id: 's1'
      }) as unknown as SDKMessage
    const toolTurn = {
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }
        ]
      },
      parent_tool_use_id: null,
      uuid: 'u',
      session_id: 's1'
    } as unknown as SDKMessage
    const q = fakeQuery([
      start('m1'),
      delta('Let me check.'),
      toolTurn,
      start('m2'),
      delta('It retries '),
      delta('three times.'),
      assistantText('It retries three times.', 'm2'),
      result({ result: 'It retries three times.' })
    ])
    const out = await ask(q.fn, onText)
    expect(onText.mock.calls.map((c) => c[0]).join('')).toBe(
      'Let me check.\n\nIt retries three times.'
    )
    expect(out.answer).toBe('It retries three times.')
  })

  it('maps result errors and SDK throws to AgentRunError', async () => {
    await rejectsWith(ask(fakeQuery([result({ subtype: 'error_max_turns' })]).fn), 'max_turns')
    await rejectsWith(
      ask(fakeQuery([result({ subtype: 'error_max_budget_usd' })]).fn),
      'max_budget'
    )
    await rejectsWith(
      ask(fakeQuery([result({ subtype: 'error_during_execution', errors: ['x'] })]).fn),
      'failed'
    )
    await rejectsWith(ask(fakeQuery([]).fn), 'failed')
    await rejectsWith(ask(fakeQuery([]).fn, undefined, { apiKey: null }), 'no_api_key')
    const boom = (() => {
      throw new Error('boom')
    }) as never
    await rejectsWith(ask(boom), 'failed')
  })
})

describe('usage', () => {
  it('returns turns, duration and token totals from the result', async () => {
    const q = fakeQuery([
      assistantText('Because.'),
      result({
        num_turns: 2,
        duration_ms: 1500,
        modelUsage: {
          'claude-opus-5-5': {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 900,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 32000
          }
        }
      })
    ])
    const r = await ask(q.fn)
    expect(r).toMatchObject({ turns: 2, durationMs: 1500 })
    expect(r.tokens).toEqual({ input: 10, output: 5, cacheRead: 900, cacheCreation: 0 })
  })
})

describe('buildChatPrompt pane listing', () => {
  it('lists what the code pane shows, marking context segments', () => {
    const p = buildChatPrompt(
      {
        ...step,
        segments: [
          { kind: 'change', path: 'src/queue/job.ts', startLine: 3, endLine: 5 },
          { kind: 'context', path: 'src/queue/run.ts', startLine: 10, endLine: 20 }
        ]
      },
      '2',
      'Why?'
    )
    expect(p).toContain('- src/queue/job.ts:3-5\n')
    expect(p).toContain('- src/queue/run.ts:10-20 (context)')
    expect(p).toContain('<question>\nWhy?\n</question>')
  })
})

const detour: Step = {
  id: 'helper',
  title: 'Helper detour',
  parentId: 'job',
  whyNext: 'y',
  explanation: 'Line one.\nLine two.',
  segments: []
}
const walkthrough: AgentWalkthrough = { summary: 'Adds retry policy.', steps: [step, detour] }

describe('buildSeededChatPrompt', () => {
  it('labels detours and wraps the chat prompt', () => {
    const p = buildSeededChatPrompt(walkthrough, detour, '1a', 'Why?')
    expect(p.startsWith('You are the author of this pull request.')).toBe(true)
    expect(p).toContain('<walkthrough_summary>\nAdds retry policy.\n</walkthrough_summary>')
    expect(p).toContain('1. Job carries the policy: Jobs carry the policy.')
    expect(p).toContain('1a. Helper detour: Line one. Line two.')
    expect(p).toContain(buildChatPrompt(detour, '1a', 'Why?'))
    expect(p).not.toContain('<step_diff>')
  })

  it("includes the step's diff when given", () => {
    const p = buildSeededChatPrompt(walkthrough, step, '1', 'Why?', 'diff --git a/x b/x')
    expect(p).toContain('<step_diff>\ndiff --git a/x b/x\n</step_diff>')
    expect(p.indexOf('<step_diff>')).toBeLessThan(p.indexOf('<question>'))
  })
})

describe('askAboutStep without a session', () => {
  const askFresh = (q: never, w?: AgentWalkthrough): Promise<AskResult> =>
    askAboutStep({
      sessionId: null,
      walkthrough: w,
      worktreePath: '/tmp/wt',
      step,
      stepLabel: '1',
      question: 'Why here?',
      settings,
      queryFn: q
    })

  it('omits resume and sends the seeded prompt', async () => {
    const q = fakeQuery([assistantText('Hi'), result()])
    await askFresh(q.fn, walkthrough)
    expect(q.calls[0].options!.resume).toBeUndefined()
    const prompt = q.calls[0].prompt as string
    expect(prompt).toContain('<walkthrough_summary>')
    expect(prompt).toContain('Job carries the policy')
    expect(prompt).toContain('Helper detour')
    expect(prompt).toContain('<question>')
  })

  it('passes the step diff into the seeded prompt', async () => {
    const q = fakeQuery([assistantText('Hi'), result()])
    await askAboutStep({
      sessionId: null,
      walkthrough,
      stepDiff: 'STEP DIFF',
      worktreePath: '/tmp/wt',
      step,
      stepLabel: '1',
      question: 'Why here?',
      settings,
      queryFn: q.fn
    })
    expect(q.calls[0].prompt).toContain('<step_diff>\nSTEP DIFF\n</step_diff>')
  })

  it('fails without the walkthrough', async () => {
    await rejectsWith(askFresh(fakeQuery([]).fn), 'failed')
  })
})
