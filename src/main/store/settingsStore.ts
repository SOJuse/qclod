import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '../../shared/types'
import {
  sanitizeDefaults,
  sanitizeEditorCommand,
  sanitizeSettingsFields,
  sanitizeVoiceSettings
} from '../tabs/sanitize'

export const SETTINGS_FILE = 'settings.json'

export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  agentPath: 'claude',
  globalHotkey: 'Control+Shift+Space',
  notificationsEnabled: true,
  soundEnabled: true,
  closeToTray: true,
  panelOpen: true,
  editorCommand: '',
  // «Авто-да»: Qclod answers a question or a plan itself after this long.
  autoAnswerMinutes: 5,
  // Only an installed build is registered with Windows (decision 11).
  openAtLogin: true,
  // Stage 5: replacements null = the standard dictionary (decision 10).
  voice: { model: 'gigaam-v3' as const, replacements: null },
  // A new tab accepts edits without asking: the permission card for every
  // single file change is what makes the app feel like it is in the way. The
  // commands a tool runs are still asked about, and the mode is one click away
  // in the panel.
  defaults: { permissionMode: 'acceptEdits' as const }
})

function cloneDefaults(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    defaults: { ...DEFAULT_SETTINGS.defaults },
    voice: { ...DEFAULT_SETTINGS.voice }
  }
}

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
    return cloneDefaults()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return cloneDefaults()
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return cloneDefaults()
  }

  const stored = parsed as Partial<AppSettings>
  return {
    ...DEFAULT_SETTINGS,
    // A hand-edited or older file: only known fields of the right type count.
    ...sanitizeSettingsFields(stored),
    editorCommand: sanitizeEditorCommand(stored.editorCommand) ?? DEFAULT_SETTINGS.editorCommand,
    defaults: { ...DEFAULT_SETTINGS.defaults, ...sanitizeDefaults(stored.defaults) },
    voice: { ...DEFAULT_SETTINGS.voice, ...sanitizeVoiceSettings(stored.voice) }
  }
}

export function saveSettings(dir: string, settings: AppSettings): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf8')
}
