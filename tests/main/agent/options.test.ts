import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAgentOptions,
  setClaudeExecutablePath,
  toUnpackedPath
} from '../../../src/main/agent/options'
import type { Settings } from '../../../src/shared/types'

describe('toUnpackedPath', () => {
  it('maps a path inside app.asar to app.asar.unpacked', () => {
    expect(
      toUnpackedPath('/A/Code Review Helper.app/Contents/Resources/app.asar/node_modules/x/claude')
    ).toBe('/A/Code Review Helper.app/Contents/Resources/app.asar.unpacked/node_modules/x/claude')
  })

  it('leaves other paths alone, including an already-unpacked one', () => {
    expect(toUnpackedPath('/p/node_modules/x/claude')).toBe('/p/node_modules/x/claude')
    expect(toUnpackedPath('/r/app.asar.unpacked/node_modules/x/claude')).toBe(
      '/r/app.asar.unpacked/node_modules/x/claude'
    )
  })
})

describe('buildAgentOptions executable override', () => {
  afterEach(() => setClaudeExecutablePath(undefined))
  const settings = { apiKey: 'k' } as Settings

  it('omits pathToClaudeCodeExecutable by default', () => {
    expect(buildAgentOptions(settings, '/w').pathToClaudeCodeExecutable).toBeUndefined()
  })

  it('passes the configured path through', () => {
    setClaudeExecutablePath('/u/claude')
    expect(buildAgentOptions(settings, '/w').pathToClaudeCodeExecutable).toBe('/u/claude')
  })
})

describe('buildAgentOptions env and tools', () => {
  const keys = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'ANTHROPIC_API_KEY'
  ]
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('scrubs inherited auth routing env, keeps PATH, and uses the settings key', () => {
    for (const k of keys) {
      saved[k] = process.env[k]
      process.env[k] = 'inherited'
    }
    const env = buildAgentOptions({ apiKey: 'sk-mine' } as Settings, '/w').env!
    for (const k of keys.slice(0, 4)) expect(env).not.toHaveProperty(k)
    expect(env.ANTHROPIC_API_KEY).toBe('sk-mine')
    expect(env.PATH).toBe(process.env.PATH)
    expect(process.env.ANTHROPIC_BASE_URL).toBe('inherited')
  })

  it('keeps tools read-only, pre-approves StructuredOutput, and ignores outside MCP config', () => {
    const o = buildAgentOptions({ apiKey: 'k' } as Settings, '/w')
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(o.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'StructuredOutput'])
    expect(o.permissionMode).toBe('dontAsk')
    expect(o.strictMcpConfig).toBe(true)
  })
})
