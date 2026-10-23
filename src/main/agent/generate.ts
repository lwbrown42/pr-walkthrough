import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChangedFile, ReviewTarget, Settings } from '../../shared/types'
import { AgentWalkthrough, agentWalkthroughJsonSchema } from '../../shared/walkthrough'
import { normalizeWalkthrough, type LineCounts } from '../walkthrough/normalize'
import { AgentRunError, buildAgentOptions, resultError } from './options'
import { buildWalkthroughPrompt, WALKTHROUGH_SYSTEM_PROMPT } from './prompt'

export interface GenerateProgress {
  turns: number
  lastTool?: string
}

export interface GenerateArgs {
  target: ReviewTarget
  files: ChangedFile[]
  diffText: string
  lineCounts: LineCounts
  settings: Settings
  onProgress?: (p: GenerateProgress) => void
  queryFn?: typeof query
}

export interface GenerateResult {
  walkthrough: AgentWalkthrough
  sessionId: string
  costUsd: number | null
  turns: number | null
  durationMs: number
}

export async function generateWalkthrough(args: GenerateArgs): Promise<GenerateResult> {
  const { target, files, diffText, lineCounts, settings, onProgress, queryFn = query } = args
  const options = {
    ...buildAgentOptions(settings, target.worktreePath),
    systemPrompt: WALKTHROUGH_SYSTEM_PROMPT,
    outputFormat: { type: 'json_schema' as const, schema: agentWalkthroughJsonSchema }
  }
  const started = Date.now()

  let final: SDKResultMessage | undefined
  try {
    // Streamed assistant messages can split one API message into several frames; count distinct ids.
    const assistantIds = new Set<string>()
    for await (const msg of queryFn({
      prompt: buildWalkthroughPrompt(target, files, diffText),
      options
    })) {
      if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
        assistantIds.add(msg.message.id)
        const tools = msg.message.content.filter((b) => b.type === 'tool_use')
        const lastTool = tools.at(-1)?.name
        onProgress?.(
          lastTool ? { turns: assistantIds.size, lastTool } : { turns: assistantIds.size }
        )
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
  if (final.subtype !== 'success') throw new AgentRunError('failed')

  const parsed = AgentWalkthrough.safeParse(final.structured_output)
  if (!parsed.success) {
    throw new AgentRunError('invalid_output', 'The agent returned no valid walkthrough.', {
      cause: parsed.error
    })
  }

  return {
    walkthrough: normalizeWalkthrough(parsed.data, files, lineCounts),
    sessionId: final.session_id,
    costUsd: final.total_cost_usd ?? null,
    turns: final.num_turns ?? null,
    durationMs: Date.now() - started
  }
}
