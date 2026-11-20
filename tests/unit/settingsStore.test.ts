import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, SETTINGS_FILE } from '@main/store/settingsStore'
import { mergeDefaults } from '@main/tabs/sanitize'
import type { AppSettings } from '@shared/types'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'qclod-settings-'))
}

describe('settingsStore', () => {
  test('bypassPermissions в settings.json читается как default', () => {
    const dir = freshDir()
    writeFileSync(
      join(dir, SETTINGS_FILE),
      JSON.stringify({ defaults: { permissionMode: 'bypassPermissions', model: 'm' } }),
      'utf8'
    )
    expect(loadSettings(dir).defaults).toEqual({ permissionMode: 'default', model: 'm' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('отсутствующий файл даёт настройки по умолчанию', () => {
    const dir = freshDir()
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
    rmSync(dir, { recursive: true, force: true })
  })

  test('повреждённый JSON даёт настройки по умолчанию и не бросает', () => {
    const dir = freshDir()
    writeFileSync(join(dir, SETTINGS_FILE), '{ this is not json', 'utf8')
    expect(() => loadSettings(dir)).not.toThrow()
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
    rmSync(dir, { recursive: true, force: true })
  })

  test('сохранение и чтение дают одно и то же', () => {
    const dir = freshDir()
    const next = { ...DEFAULT_SETTINGS, closeToTray: false, globalHotkey: 'Ctrl+Alt+Q' }
    saveSettings(dir, next)
    expect(loadSettings(dir)).toEqual(next)
    rmSync(dir, { recursive: true, force: true })
  })

  test('частично записанный файл дополняется значениями по умолчанию', () => {
    const dir = freshDir()
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ soundEnabled: false }), 'utf8')
    const loaded = loadSettings(dir)
    expect(loaded.soundEnabled).toBe(false)
    expect(loaded.globalHotkey).toBe(DEFAULT_SETTINGS.globalHotkey)
    rmSync(dir, { recursive: true, force: true })
  })

  test('старый settings.json с fontSize читается без ошибок', () => {
    const dir = freshDir()
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ fontSize: 20, closeToTray: false }), 'utf8')
    const loaded = loadSettings(dir)
    expect(loaded.closeToTray).toBe(false)
    expect(DEFAULT_SETTINGS).not.toHaveProperty('fontSize')
    rmSync(dir, { recursive: true, force: true })
  })

  test('команда редактора: по умолчанию пусто, сохранённая читается, не строка — пусто', () => {
    expect(DEFAULT_SETTINGS.editorCommand).toBe('')
    const dir = freshDir()
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ editorCommand: 'code -g {path}:{line}' }), 'utf8')
    expect(loadSettings(dir).editorCommand).toBe('code -g {path}:{line}')
    writeFileSync(join(dir, SETTINGS_FILE), JSON.stringify({ editorCommand: ['rm'] }), 'utf8')
    expect(loadSettings(dir).editorCommand).toBe('')
    rmSync(dir, { recursive: true, force: true })
  })

  // The fields are read through an allowlist (sanitizeSettingsFields): a new
  // AppSettings field left out of it would be dropped, on load and on save,
  // without a word. Typed as AppSettings, so a new field must be added here.
  const changed: AppSettings = {
    agentPath: 'C:/tools/claude.exe',
    globalHotkey: 'Control+Alt+K',
    notificationsEnabled: false,
    soundEnabled: false,
    closeToTray: false,
    panelOpen: false,
    editorCommand: 'code -g {path}:{line}',
    defaults: { permissionMode: 'plan', model: 'm' }
  }

  test('каждое поле DEFAULT_SETTINGS переживает сохранение и чтение', () => {
    const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>
    expect(Object.keys(changed).sort()).toEqual([...keys].sort())
    // Each one differs from its default, so a dropped field cannot pass for kept.
    for (const key of keys) expect(changed[key], key).not.toEqual(DEFAULT_SETTINGS[key])
    const dir = freshDir()
    saveSettings(dir, changed)
    const loaded = loadSettings(dir)
    for (const key of keys) expect(loaded[key], key).toEqual(changed[key])
    rmSync(dir, { recursive: true, force: true })
  })

  test('каждое поле DEFAULT_SETTINGS доходит через патч настроек', () => {
    const merged = mergeDefaults({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults } }, changed)
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
      expect(merged[key], key).toEqual(changed[key])
    }
  })
})
