import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Settings } from '../../shared/types'

export type AgentRunErrorReason =
  'no_api_key' | 'max_turns' | 'max_budget' | 'invalid_output' | 'cancelled' | 'failed'

/** What a run had used when it ended, if the SDK reported it. */
export interface RunUsage {
  costUsd?: number
  turns?: number
  durationMs?: number
}

export class AgentRunError extends Error {
  readonly reason: AgentRunErrorReason
  readonly costUsd?: number
  readonly turns?: number
  readonly durationMs?: number

  constructor(
    reason: AgentRunErrorReason,
    message?: string,
    options?: { cause?: unknown; usage?: RunUsage }
  ) {
    super(message ?? reason, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AgentRunError'
    this.reason = reason
    const usage = options?.usage
    if (usage?.costUsd !== undefined) this.costUsd = usage.costUsd
    if (usage?.turns !== undefined) this.turns = usage.turns
    if (usage?.durationMs !== undefined) this.durationMs = usage.durationMs
  }
}

/** Env vars that would route the agent away from the reviewer's own API key. */
const SCRUBBED_ENV = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
]

function agentEnv(apiKey: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of SCRUBBED_ENV) delete env[k]
  env.ANTHROPIC_API_KEY = apiKey
  return env
}

/** The agent's only tools. This list is the safety boundary: nothing that writes, runs commands or reaches the web. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob']

let claudeExecutablePath: string | undefined

/** Set once from main (which knows about Electron) to the real, spawnable Claude Code binary. */
export function setClaudeExecutablePath(path: string | undefined): void {
  claudeExecutablePath = path
}

/** Inside a packaged app the binary is unpacked next to app.asar; a child process can't run it from within the archive. */
export function toUnpackedPath(path: string): string {
  return path.replace(/\bapp\.asar(?=[\\/])/, 'app.asar.unpacked')
}

/**
 * Options shared by every agent run (walkthrough generation and chat): read-only tools that never
 * prompt, none of the user's own settings/CLAUDE.md/skills/hooks, and the run limits from settings.
 */
export function buildAgentOptions(settings: Settings, cwd: string): Options {
  if (!settings.apiKey) throw new AgentRunError('no_api_key', 'No Anthropic API key is set.')
  return {
    cwd,
    ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
    tools: [...READ_ONLY_TOOLS],
    // StructuredOutput is the SDK's own tool for returning outputFormat JSON; it must be
    // pre-approved under dontAsk, but it is not added to `tools` (the read-only boundary).
    allowedTools: [...READ_ONLY_TOOLS, 'StructuredOutput'],
    // Pre-approved tools run; anything else is denied instead of prompting.
    permissionMode: 'dontAsk',
    settingSources: [],
    strictMcpConfig: true,
    model: settings.model,
    maxTurns: settings.maxTurns,
    maxBudgetUsd: settings.maxBudgetUsd,
    // The SDK's env replaces the subprocess environment, so keep PATH, HOME, etc.
    env: agentEnv(settings.apiKey)
  }
}

/** The error a result message ends the run with, or null for a successful result. */
export function resultError(msg: SDKResultMessage): AgentRunError | null {
  const usage = usageOf(msg)
  switch (msg.subtype) {
    case 'success':
      return msg.is_error
        ? new AgentRunError('failed', msg.result || 'The agent run failed.', { usage })
        : null
    case 'error_max_turns':
      return new AgentRunError('max_turns', 'The agent hit the turn limit.', { usage })
    case 'error_max_budget_usd':
      return new AgentRunError('max_budget', 'The agent hit the budget limit.', { usage })
    case 'error_max_structured_output_retries':
      return new AgentRunError(
        'invalid_output',
        'The agent could not produce valid structured output.',
        { usage }
      )
    default:
      return new AgentRunError('failed', msg.errors?.join('\n') || 'The agent run failed.', {
        usage
      })
  }
}

/** Cost, turns and duration from a result message (fields may be missing on fakes or crashes). */
export function usageOf(msg: SDKResultMessage): RunUsage {
  const usage: RunUsage = {}
  if (typeof msg.total_cost_usd === 'number') usage.costUsd = msg.total_cost_usd
  if (typeof msg.num_turns === 'number') usage.turns = msg.num_turns
  if (typeof msg.duration_ms === 'number') usage.durationMs = msg.duration_ms
  return usage
}
