import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Settings } from '../../shared/types'

export type AgentRunErrorReason =
  'no_api_key' | 'max_turns' | 'max_budget' | 'invalid_output' | 'failed'

export class AgentRunError extends Error {
  readonly reason: AgentRunErrorReason

  constructor(reason: AgentRunErrorReason, message?: string, options?: { cause?: unknown }) {
    super(message ?? reason, options)
    this.name = 'AgentRunError'
    this.reason = reason
  }
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
    allowedTools: [...READ_ONLY_TOOLS],
    // Pre-approved tools run; anything else is denied instead of prompting.
    permissionMode: 'dontAsk',
    settingSources: [],
    model: settings.model,
    maxTurns: settings.maxTurns,
    maxBudgetUsd: settings.maxBudgetUsd,
    // The SDK's env replaces the subprocess environment, so keep PATH, HOME, etc.
    env: { ...process.env, ANTHROPIC_API_KEY: settings.apiKey }
  }
}

/** The error a result message ends the run with, or null for a successful result. */
export function resultError(msg: SDKResultMessage): AgentRunError | null {
  switch (msg.subtype) {
    case 'success':
      return msg.is_error
        ? new AgentRunError('failed', msg.result || 'The agent run failed.')
        : null
    case 'error_max_turns':
      return new AgentRunError('max_turns', 'The agent hit the turn limit.')
    case 'error_max_budget_usd':
      return new AgentRunError('max_budget', 'The agent hit the budget limit.')
    case 'error_max_structured_output_retries':
      return new AgentRunError(
        'invalid_output',
        'The agent could not produce valid structured output.'
      )
    default:
      return new AgentRunError('failed', msg.errors?.join('\n') || 'The agent run failed.')
  }
}
