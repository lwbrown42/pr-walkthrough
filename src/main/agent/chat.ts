import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Settings, TokenUsage } from '../../shared/types'
import type { AgentWalkthrough, Step } from '../../shared/walkthrough'
import { AgentRunError, buildAgentOptions, resultError, usageOf } from './options'
import { buildChatPrompt, buildSeededChatPrompt } from './prompt'

export interface AskArgs {
  /** Null starts a fresh session, seeded from `walkthrough`. */
  sessionId: string | null
  /** Required when `sessionId` is null. */
  walkthrough?: AgentWalkthrough
  /** For a fresh session: the diff of the step's changed files. */
  stepDiff?: string
  worktreePath: string
  step: Step
  /** The label the reviewer sees, e.g. '2' or '1a'. */
  stepLabel: string
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

/** Asks a question about one step, resuming the chat's session or starting one seeded from the walkthrough. */
export async function askAboutStep(args: AskArgs): Promise<AskResult> {
  const {
    sessionId,
    worktreePath,
    step,
    stepLabel,
    question,
    walkthrough,
    stepDiff,
    settings,
    onText,
    queryFn = query
  } = args
  if (sessionId === null && !walkthrough) {
    throw new AgentRunError('failed', 'Cannot start a fresh chat without the walkthrough.')
  }
  const options = {
    ...buildAgentOptions(settings, worktreePath),
    ...(sessionId === null ? {} : { resume: sessionId }),
    includePartialMessages: true
  }
  const prompt =
    walkthrough && sessionId === null
      ? buildSeededChatPrompt(walkthrough, step, stepLabel, question, stepDiff)
      : buildChatPrompt(step, stepLabel, question)

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
      prompt,
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
