import { describe, expect, test } from 'vitest'
import { PANE_PANEL_MIN_WIDTH, nextOverride, panelMode, panelToggle } from '../../src/renderer/app/panelVisibility'

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

describe('panelToggle: у каждой половины свой выбор (S2-R23)', () => {
  test('одна широкая панель — кнопка пишет настройку, ручного выбора нет', () => {
    expect(panelToggle({ shown: true, paneWidth: 900, split: false })).toEqual({ override: null, saveSetting: false })
    expect(panelToggle({ shown: false, paneWidth: 900, split: false })).toEqual({ override: null, saveSetting: true })
  })

  test('широкая половина сплита — свой выбор, настройка не трогается', () => {
    expect(panelToggle({ shown: true, paneWidth: 900, split: true })).toEqual({ override: 'closed' })
    expect(panelToggle({ shown: false, paneWidth: 900, split: true })).toEqual({ override: 'open' })
  })

  test('узкая панель — свой выбор, и в сплите, и одна', () => {
    expect(panelToggle({ shown: false, paneWidth: 600, split: false })).toEqual({ override: 'open' })
    expect(panelToggle({ shown: true, paneWidth: 600, split: true })).toEqual({ override: 'closed' })
  })

  test('закрытая в одной половине не закрывает другую: у той выбор не задан, она по настройке', () => {
    const left = panelToggle({ shown: true, paneWidth: 900, split: true }).override
    expect(panelMode({ setting: true, paneWidth: 900, override: left })).toBe('hidden')
    expect(panelMode({ setting: true, paneWidth: 900, override: null })).toBe('docked')
  })
})
