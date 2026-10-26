import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunLogEntry, Settings } from '../shared/types'

export interface SettingsCrypto {
  encrypt(s: string): Buffer
  decrypt(b: Buffer): string
  available(): boolean
}

export interface SettingsStore {
  get(): Settings
  save(patch: Partial<Settings>): Settings
  appendRunLog(e: RunLogEntry): void
  readRunLog(): RunLogEntry[]
}

type Stored = Omit<Settings, 'apiKey'> & { apiKeyEncrypted?: string | null }

const DEFAULTS: Omit<Settings, 'apiKey'> = {
  model: 'claude-opus-5-5',
  chatModel: 'claude-sonnet-5-5',
  maxTurns: 60,
  maxBudgetUsd: 3
}

export function createSettingsStore(dir: string, crypto: SettingsCrypto): SettingsStore {
  const settingsPath = join(dir, 'settings.json')
  const logPath = join(dir, 'runs.log')
  const ensureDir = (): void => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  const readStored = (): Partial<Stored> => {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const decryptKey = (b64: string | null | undefined): string | null => {
    if (!b64) return null
    try {
      return crypto.decrypt(Buffer.from(b64, 'base64'))
    } catch {
      return null
    }
  }

  const get = (): Settings => {
    const { apiKeyEncrypted, ...rest } = readStored()
    return { ...DEFAULTS, ...rest, apiKey: decryptKey(apiKeyEncrypted) }
  }

  const save = (patch: Partial<Settings>): Settings => {
    const stored = readStored()
    const rest: Partial<Settings> = { ...patch }
    delete rest.apiKey
    let apiKeyEncrypted = stored.apiKeyEncrypted ?? null
    if ('apiKey' in patch) {
      if (patch.apiKey) {
        if (!crypto.available()) {
          throw new Error('Secure storage (Keychain) is unavailable; cannot store the API key')
        }
        apiKeyEncrypted = crypto.encrypt(patch.apiKey).toString('base64')
      } else {
        apiKeyEncrypted = null
      }
    }
    const storedRest: Partial<Stored> = { ...stored }
    delete storedRest.apiKeyEncrypted
    ensureDir()
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...DEFAULTS, ...storedRest, ...rest, apiKeyEncrypted }, null, 2)
    )
    return get()
  }

  const appendRunLog = (e: RunLogEntry): void => {
    ensureDir()
    appendFileSync(logPath, JSON.stringify(e) + '\n')
  }

  const readRunLog = (): RunLogEntry[] => {
    if (!existsSync(logPath)) return []
    const out: RunLogEntry[] = []
    for (const line of readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // skip corrupt line
      }
    }
    return out
  }

  return { get, save, appendRunLog, readRunLog }
}
