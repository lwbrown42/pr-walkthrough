import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChangedFile, ReviewTarget, Settings } from '../../shared/types'
import { AgentWalkthrough, agentWalkthroughJsonSchema } from '../../shared/walkthrough'
import { normalizeWalkthrough, type LineCounts } from '../walkthrough/normalize'
import { AgentRunError, buildAgentOptions, resultError, usageOf } from './options'
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
}

export async function generateWalkthrough(args: GenerateArgs): Promise<GenerateResult> {
  const { target, files, diffText, settings, onProgress, readLineCount, abortController } = args
  const queryFn = args.queryFn ?? query
  const options = {
    ...buildAgentOptions(settings, target.worktreePath),
    ...(abortController ? { abortController } : {}),
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
  return {
    walkthrough: normalizeWalkthrough(parsed.data, files, lineCounts),
    sessionId: final.session_id,
    costUsd: final.total_cost_usd ?? null,
    turns: final.num_turns ?? null,
    durationMs: Date.now() - started
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
