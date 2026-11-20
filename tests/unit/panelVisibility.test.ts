import { describe, expect, test } from 'vitest'
import { PANE_PANEL_MIN_WIDTH, nextOverride, panelMode } from '../../src/renderer/app/panelVisibility'

describe('panelMode', () => {
  test('порог — 760 px ширины панели чата', () => expect(PANE_PANEL_MIN_WIDTH).toBe(760))

  test('широкая панель чата — панель прикреплена', () =>
    expect(panelMode({ setting: true, paneWidth: 800, override: null })).toBe('docked'))

  test('узкая — панель спрятана, даже если включена', () =>
    expect(panelMode({ setting: true, paneWidth: 600, override: null })).toBe('hidden'))

  test('ручное открытие в узкой — выдвинута поверх', () =>
    expect(panelMode({ setting: true, paneWidth: 600, override: 'open' })).toBe('drawer'))

  test('выключенная настройка прячет панель', () =>
    expect(panelMode({ setting: false, paneWidth: 800, override: null })).toBe('hidden'))

  test('ручное открытие в широкой при выключенной настройке — прикреплена', () =>
    expect(panelMode({ setting: false, paneWidth: 1400, override: 'open' })).toBe('docked'))

  test('ручное закрытие побеждает настройку', () =>
    expect(panelMode({ setting: true, paneWidth: 1400, override: 'closed' })).toBe('hidden'))
})

describe('nextOverride', () => {
  test('пересечение порога сбрасывает ручной выбор', () => {
    expect(nextOverride('open', 600, 900)).toBeNull()
    expect(nextOverride('closed', 900, 600)).toBeNull()
  })

  test('изменение ширины по одну сторону порога его сохраняет', () => {
    expect(nextOverride('open', 600, 500)).toBe('open')
    expect(nextOverride('closed', 1300, 1200)).toBe('closed')
  })
})
