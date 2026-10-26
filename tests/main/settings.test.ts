import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsStore, type SettingsCrypto } from '../../src/main/settings'
import type { RunLogEntry } from '../../src/shared/types'

const makeCrypto = (available = true): SettingsCrypto => ({
  encrypt: (s: string) => Buffer.from(s.split('').reverse().join('')),
  decrypt: (b: Buffer) => b.toString().split('').reverse().join(''),
  available: () => available
})

const entry: RunLogEntry = {
  at: '2026-10-23T00:00:00Z',
  kind: 'generate',
  prTitle: 'T',
  changedLines: 10,
  durationMs: 100,
  costUsd: 0.1,
  turns: 3,
  outcome: 'success'
}

describe('settings store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'settings-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns defaults on a fresh store', () => {
    expect(createSettingsStore(dir, makeCrypto()).get()).toEqual({
      apiKey: null,
      model: 'claude-opus-5-5',
      chatModel: 'claude-sonnet-5-5',
      maxTurns: 60,
      maxBudgetUsd: 3
    })
  })

  it('round-trips the key through a new instance without writing plaintext', () => {
    createSettingsStore(dir, makeCrypto()).save({ apiKey: 'sk-secret-123' })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain('sk-secret-123')
    expect(createSettingsStore(dir, makeCrypto()).get().apiKey).toBe('sk-secret-123')
  })

  it('merges patches and clears the key with null', () => {
    const s = createSettingsStore(dir, makeCrypto())
    s.save({ apiKey: 'k', maxTurns: 5 })
    const r = s.save({ model: 'm' })
    expect(r).toMatchObject({ apiKey: 'k', maxTurns: 5, model: 'm' })
    expect(s.save({ apiKey: null }).apiKey).toBeNull()
    expect(createSettingsStore(dir, makeCrypto()).get().apiKey).toBeNull()
  })

  it('returns defaults when settings.json is corrupt', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'settings.json'), '{nope')
    expect(createSettingsStore(dir, makeCrypto()).get().maxTurns).toBe(60)
  })

  it('creates the dir if absent', () => {
    const nested = join(dir, 'a', 'b')
    createSettingsStore(nested, makeCrypto()).save({ maxTurns: 7 })
    expect(createSettingsStore(nested, makeCrypto()).get().maxTurns).toBe(7)
  })

  it('appends and reads run log entries', () => {
    const s = createSettingsStore(dir, makeCrypto())
    expect(s.readRunLog()).toEqual([])
    s.appendRunLog(entry)
    s.appendRunLog(entry)
    expect(s.readRunLog().length).toBe(2)
  })

  it('throws mentioning Keychain when encryption is unavailable', () => {
    const s = createSettingsStore(dir, makeCrypto(false))
    expect(() => s.save({ apiKey: 'k' })).toThrow(/Keychain/)
  })

  it('saving other settings works when Keychain is unavailable and preserves the stored key', () => {
    createSettingsStore(dir, makeCrypto()).save({ apiKey: 'k1' })
    const s = createSettingsStore(dir, makeCrypto(false))
    expect(s.save({ maxTurns: 5 }).maxTurns).toBe(5)
    expect(createSettingsStore(dir, makeCrypto()).get().apiKey).toBe('k1')
  })

  it('does not destroy the stored ciphertext when decrypt throws', () => {
    createSettingsStore(dir, makeCrypto()).save({ apiKey: 'k1' })
    const bad: SettingsCrypto = {
      ...makeCrypto(),
      decrypt: () => {
        throw new Error('boom')
      }
    }
    const s = createSettingsStore(dir, bad)
    s.save({ model: 'm' })
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(onDisk.apiKeyEncrypted).toBeTruthy()
    expect(createSettingsStore(dir, makeCrypto()).get().apiKey).toBe('k1')
  })
})
