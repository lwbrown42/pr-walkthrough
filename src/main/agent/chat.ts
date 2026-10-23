import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Settings, TokenUsage } from '../../shared/types'
import type { Step } from '../../shared/walkthrough'
import { AgentRunError, buildAgentOptions, resultError, usageOf } from './options'
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
  turns: number | null
  durationMs: number | null
  tokens: TokenUsage | null
  tokensByModel: Record<string, TokenUsage> | null
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

  // Text of each top-level assistant message, in order; turns are joined with a blank line.
  const turns = new Map<string, string>()
  let sawDelta = false
  let streamedText = false
  let pendingSeparator = false
  const emit = (text: string): void => {
    if (pendingSeparator && streamedText) onText?.('\n\n')
    pendingSeparator = false
    streamedText = true
    onText?.(text)
  }
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
        if (e.type === 'message_start') {
          pendingSeparator = true
        } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
          sawDelta = true
          emit(e.delta.text)
        }
      } else if (msg.type === 'assistant') {
        const id = msg.message.id
        for (const block of msg.message.content) {
          if (block.type !== 'text') continue
          // Without partial deltas, surface whole text blocks so the UI still updates.
          if (!sawDelta) {
            if (!turns.has(id)) pendingSeparator = true
            emit(block.text)
          }
          turns.set(id, (turns.get(id) ?? '') + block.text)
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

  // The success result carries the final assistant text; fall back to the collected turns.
  const fromResult = final.subtype === 'success' ? final.result : ''
  const answer = fromResult || [...turns.values()].filter((t) => t !== '').join('\n\n')
  const usage = usageOf(final)
  return {
    answer,
    sessionId: final.session_id,
    costUsd: usage.costUsd ?? null,
    turns: usage.turns ?? null,
    durationMs: usage.durationMs ?? null,
    tokens: usage.tokens ?? null,
    tokensByModel: usage.tokensByModel ?? null
  }
}
