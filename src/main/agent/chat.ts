import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Settings } from '../../shared/types'
import type { Step } from '../../shared/walkthrough'
import { AgentRunError, buildAgentOptions, resultError } from './options'
import { buildChatPrompt } from './prompt'

export interface AskArgs {
  sessionId: string
  worktreePath: string
  step: Step
  stepIndex: number
  question: string
  settings: Settings
  onText?: (chunk: string) => void
  queryFn?: typeof query
}

export interface AskResult {
  answer: string
  sessionId: string
  costUsd: number | null
}

/** Asks the walkthrough's agent session a question about one step; resumes that session. */
export async function askAboutStep(args: AskArgs): Promise<AskResult> {
  const {
    sessionId,
    worktreePath,
    step,
    stepIndex,
    question,
    settings,
    onText,
    queryFn = query
  } = args
  const options = {
    ...buildAgentOptions(settings, worktreePath),
    resume: sessionId,
    includePartialMessages: true
  }

  let answer = ''
  let sawDelta = false
  let final: SDKResultMessage | undefined
  try {
    for await (const msg of queryFn({
      prompt: buildChatPrompt(step, stepIndex, question),
      options
    })) {
      // Subagent output is not part of the answer.
      if ('parent_tool_use_id' in msg && msg.parent_tool_use_id) continue
      if (msg.type === 'stream_event') {
        const e = msg.event
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
          sawDelta = true
          onText?.(e.delta.text)
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type !== 'text') continue
          answer += block.text
          // Without partial deltas, surface whole text blocks so the UI still updates.
          if (!sawDelta) onText?.(block.text)
        }
      } else if (msg.type === 'result') {
        final = msg
      }
    }
  } catch (err) {
    if (err instanceof AgentRunError) throw err
    throw new AgentRunError('failed', err instanceof Error ? err.message : String(err), {
      cause: err
    })
  }

  if (!final) throw new AgentRunError('failed', 'The agent ended without a result.')
  const error = resultError(final)
  if (error) throw error

  return { answer, sessionId: final.session_id, costUsd: final.total_cost_usd ?? null }
}
