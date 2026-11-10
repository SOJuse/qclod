import { describe, expect, test } from 'vitest'
import { PANEL_MIN_WIDTH, nextOverride, panelVisible } from '../../src/renderer/app/panelVisibility'

describe('panelVisible', () => {
  test('порог — 1100 px', () => expect(PANEL_MIN_WIDTH).toBe(1100))

  test('узкое окно прячет панель, даже если она включена', () =>
    expect(panelVisible({ setting: true, width: 1000, override: null })).toBe(false))

  test('ручное открытие в узком окне побеждает', () =>
    expect(panelVisible({ setting: true, width: 1000, override: 'open' })).toBe(true))

  test('широкое окно показывает панель по настройке', () => {
    expect(panelVisible({ setting: true, width: 1100, override: null })).toBe(true)
    expect(panelVisible({ setting: false, width: 1400, override: null })).toBe(false)
  })

  test('ручное закрытие побеждает настройку', () =>
    expect(panelVisible({ setting: true, width: 1400, override: 'closed' })).toBe(false))
})

describe('nextOverride', () => {
  test('пересечение порога сбрасывает ручной выбор', () => {
    expect(nextOverride('open', 1000, 1200)).toBeNull()
    expect(nextOverride('closed', 1200, 1000)).toBeNull()
  })

  test('изменение ширины по одну сторону порога его сохраняет', () => {
    expect(nextOverride('open', 1000, 900)).toBe('open')
    expect(nextOverride('closed', 1300, 1200)).toBe('closed')
  })
})
