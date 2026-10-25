import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChangedFile, ReviewTarget, Settings, TokenUsage } from '../../shared/types'
import { AgentWalkthrough, agentWalkthroughJsonSchema } from '../../shared/walkthrough'
import type { GenerateProgress } from '../../shared/progress'
import { normalizeWalkthrough, type LineCounts } from '../walkthrough/normalize'
import { AgentRunError, buildAgentOptions, resultError, usageOf } from './options'
import { ProgressTracker } from './progress'
import { buildWalkthroughPrompt, WALKTHROUGH_SYSTEM_PROMPT } from './prompt'

export interface GenerateArgs {
  target: ReviewTarget
  files: ChangedFile[]
  diffText: string
  lineCounts: LineCounts
  settings: Settings
  onProgress?: (p: GenerateProgress) => void
  /** Head-version line count for a file outside lineCounts (context on unchanged files), or null. */
  readLineCount?: (path: string) => Promise<number | null>
  /** Aborting it cancels the run with reason 'cancelled'. */
  abortController?: AbortController
  queryFn?: typeof query
}

export interface GenerateResult {
  walkthrough: AgentWalkthrough
  sessionId: string
  costUsd: number | null
  turns: number | null
  durationMs: number
  tokens: TokenUsage | null
  tokensByModel: Record<string, TokenUsage> | null
}

export async function generateWalkthrough(args: GenerateArgs): Promise<GenerateResult> {
  const { target, files, diffText, settings, onProgress, readLineCount, abortController } = args
  const queryFn = args.queryFn ?? query
  const options = {
    ...buildAgentOptions(settings, target.worktreePath),
    ...(abortController ? { abortController } : {}),
    systemPrompt: WALKTHROUGH_SYSTEM_PROMPT,
    // Stream partial output so step titles can be shown while the walkthrough is written.
    includePartialMessages: true,
    outputFormat: { type: 'json_schema' as const, schema: agentWalkthroughJsonSchema }
  }
  const started = Date.now()

  // Changed files the agent can open in the head checkout.
  const progress = new ProgressTracker(
    files.filter((f) => !f.binary && f.status !== 'deleted').map((f) => f.path),
    target.worktreePath
  )
  const report = (): void => onProgress?.(progress.snapshot())

  let final: SDKResultMessage | undefined
  try {
    // Streamed assistant messages can split one API message into several frames; count distinct ids.
    const assistantIds = new Set<string>()
    // Content block index of the StructuredOutput tool call in the message being streamed.
    let outputBlock: number | undefined
    let outputStreamed = false
    for await (const msg of queryFn({
      prompt: buildWalkthroughPrompt(target, files, diffText),
      options
    })) {
      if ('parent_tool_use_id' in msg && msg.parent_tool_use_id) continue
      if (msg.type === 'stream_event') {
        const e = msg.event
        if (e.type === 'message_start') {
          outputBlock = undefined
        } else if (
          e.type === 'content_block_start' &&
          e.content_block.type === 'tool_use' &&
          e.content_block.name === 'StructuredOutput'
        ) {
          outputBlock = e.index
          if (progress.startOutput()) report()
        } else if (
          e.type === 'content_block_delta' &&
          e.index === outputBlock &&
          e.delta.type === 'input_json_delta'
        ) {
          outputStreamed = true
          if (progress.outputDelta(e.delta.partial_json)) report()
        }
      } else if (msg.type === 'assistant') {
        if (!assistantIds.has(msg.message.id)) {
          assistantIds.add(msg.message.id)
          progress.turn()
        }
        for (const block of msg.message.content) {
          if (block.type !== 'tool_use') continue
          if (block.name === 'StructuredOutput') {
            progress.startOutput()
            // Without streamed deltas, read the titles from the finished output.
            if (!outputStreamed) progress.outputDelta(JSON.stringify(block.input))
          } else {
            progress.toolUse(block.name, (block.input ?? {}) as Record<string, unknown>)
          }
        }
        report()
      } else if (msg.type === 'result') {
        final = msg
        progress.finish()
        report()
      }
    }
  } catch (err) {
    if (err instanceof AgentRunError) throw err
    if (abortController?.signal.aborted) {
      throw new AgentRunError('cancelled', 'Generation was cancelled.', { cause: err })
    }
    throw new AgentRunError('failed', err instanceof Error ? err.message : String(err), {
      cause: err
    })
  }

  if (abortController?.signal.aborted) {
    throw new AgentRunError('cancelled', 'Generation was cancelled.')
  }
  if (!final) throw new AgentRunError('failed', 'The agent ended without a result.')
  const error = resultError(final)
  if (error) throw error
  if (final.subtype !== 'success') throw new AgentRunError('failed')

  const parsed = AgentWalkthrough.safeParse(final.structured_output)
  if (!parsed.success) {
    throw new AgentRunError('invalid_output', 'The agent returned no valid walkthrough.', {
      cause: parsed.error,
      usage: usageOf(final)
    })
  }

  const lineCounts = await withContextLineCounts(parsed.data, files, args.lineCounts, readLineCount)
  const usage = usageOf(final)
  return {
    walkthrough: normalizeWalkthrough(parsed.data, files, lineCounts),
    sessionId: final.session_id,
    costUsd: final.total_cost_usd ?? null,
    turns: final.num_turns ?? null,
    durationMs: Date.now() - started,
    tokens: usage.tokens ?? null,
    tokensByModel: usage.tokensByModel ?? null
  }
}

/** Adds head line counts for segment paths the PR didn't change, so their context segments survive normalization. */
async function withContextLineCounts(
  raw: AgentWalkthrough,
  files: ChangedFile[],
  counts: LineCounts,
  readLineCount: GenerateArgs['readLineCount']
): Promise<LineCounts> {
  if (!readLineCount) return counts
  const changed = new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))
  const known = (p: string): boolean => changed.has(p) || p in counts.head || p in counts.base
  const unknown = [
    ...new Set(raw.steps.flatMap((s) => s.segments.map((seg) => seg.path)).filter((p) => !known(p)))
  ]
  if (unknown.length === 0) return counts
  const head = { ...counts.head }
  await Promise.all(
    unknown.map(async (path) => {
      const n = await readLineCount(path).catch(() => null)
      if (n !== null) head[path] = n
    })
  )
  return { head, base: counts.base }
}
