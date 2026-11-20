import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { SettingsScreen } from '../../src/renderer/components/SettingsScreen'
import { SETTINGS_SECTIONS, sortedSections } from '../../src/renderer/components/settings/registry'
import type { SettingsSectionDef } from '../../src/renderer/components/settings/types'
import { DEFAULT_SETTINGS } from '../../src/main/store/settingsStore'

const stub = (id: string, title: string, order: number): SettingsSectionDef => ({
  id,
  title,
  order,
  Component: () => createElement('div')
})

const render = (props: { focusField?: 'agentPath' } = {}): string =>
  renderToStaticMarkup(
    createElement(SettingsScreen, {
      settings: DEFAULT_SETTINGS,
      version: '1.0.0',
      models: [],
      onPatch: async () => DEFAULT_SETTINGS,
      onClose: () => undefined,
      ...props
    })
  )

describe('settings sections', () => {
  // The sheet notes what had focus when it opened; there is no page here, only a stand-in for it.
  beforeAll(() => {
    const body = {}
    vi.stubGlobal('document', { body, activeElement: body })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  test('the registry carries the six sections in their order (stage 3 adds «Автономность» at 35)', () => {
    expect(sortedSections().map((s) => [s.id, s.title, s.order])).toEqual([
      ['window', 'Окно', 10],
      ['notifications', 'Уведомления', 20],
      ['agent', 'Запуск агента', 30],
      ['autonomy', 'Автономность', 35],
      ['permissions', 'Разрешения', 40],
      ['about', 'О программе', 90]
    ])
  })

  test('sortedSections goes by order; a section with order 25 lands between notifications and the agent', () => {
    const list = sortedSections([...SETTINGS_SECTIONS, stub('extra', 'Свой', 25)])
    expect(list.map((s) => s.id)).toEqual([
      'window',
      'notifications',
      'extra',
      'agent',
      'autonomy',
      'permissions',
      'about'
    ])
  })

  test('equal order falls back to the title; the given list is left alone', () => {
    const given = [stub('b', 'Б', 5), stub('a', 'А', 5)]
    expect(sortedSections(given).map((s) => s.id)).toEqual(['a', 'b'])
    expect(given.map((s) => s.id)).toEqual(['b', 'a'])
  })

  test('every id is unique', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('the screen opens on the first section, with its nav marked as current', () => {
    const html = render()
    expect(html).toContain('data-testid="setting-globalHotkey"')
    expect(html).not.toContain('data-testid="setting-agentPath"')
    expect(html).toMatch(/data-testid="settings-nav-window"[^>]*aria-current="page"|aria-current="page"[^>]*data-testid="settings-nav-window"/)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    for (const s of SETTINGS_SECTIONS) expect(html).toContain(`data-testid="settings-nav-${s.id}"`)
  })

  test("focusField 'agentPath' draws the agent section", () => {
    const html = render({ focusField: 'agentPath' })
    expect(html).toContain('data-testid="setting-agentPath"')
    expect(html).not.toContain('data-testid="setting-globalHotkey"')
    expect(html).toMatch(/data-testid="settings-nav-agent"[^>]*aria-current="page"|aria-current="page"[^>]*data-testid="settings-nav-agent"/)
  })
})
