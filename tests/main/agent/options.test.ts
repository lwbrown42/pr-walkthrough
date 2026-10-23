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
