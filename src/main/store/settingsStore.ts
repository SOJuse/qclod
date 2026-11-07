import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '../../shared/types'

export const SETTINGS_FILE = 'settings.json'

export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  agentPath: 'claude',
  globalHotkey: 'Control+Shift+Space',
  notificationsEnabled: true,
  soundEnabled: true,
  fontSize: 13,
  closeToTray: true,
  panelOpen: true,
  defaults: {}
})

/**
 * Settings are a convenience, never a gate: an unreadable or half-written file
 * must never stop the app from starting, so anything unparseable falls back to
 * defaults and anything missing is filled in.
 */
export function loadSettings(dir: string): AppSettings {
  let raw: string
  try {
    raw = readFileSync(join(dir, SETTINGS_FILE), 'utf8')
  } catch {
    return { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults } }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults } }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults } }
  }

  const stored = parsed as Partial<AppSettings>
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(stored.defaults ?? {}) }
  }
}

export function saveSettings(dir: string, settings: AppSettings): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf8')
}
