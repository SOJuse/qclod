import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, SETTINGS_FILE } from '@main/store/settingsStore'

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
})
