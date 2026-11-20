// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  AutonomySection,
  KEEP_AWAKE_MAC,
  KEEP_AWAKE_WINDOWS,
  installedBuild,
  keepAwakeText
} from '../../src/renderer/components/settings/AutonomySection'
import { sortedSections } from '../../src/renderer/components/settings/registry'
import type { SettingsSectionProps } from '../../src/renderer/components/settings/types'
import { DEFAULT_SETTINGS } from '../../src/main/store/settingsStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function props(patch: SettingsSectionProps['patch'] = async () => DEFAULT_SETTINGS): SettingsSectionProps {
  return { settings: { ...DEFAULT_SETTINGS, autoAnswerMinutes: 5, openAtLogin: true }, patch, models: [], version: '1.0.0' }
}

describe('раздел «Автономность»', () => {
  test('раздел autonomy в sortedSections стоит между agent (30) и permissions (40)', () => {
    const list = sortedSections()
    const at = list.findIndex((s) => s.id === 'autonomy')
    expect(list[at]).toMatchObject({ id: 'autonomy', title: 'Автономность', order: 35, Component: AutonomySection })
    expect(list[at - 1]!.id).toBe('agent')
    expect(list[at + 1]!.id).toBe('permissions')
  })

  test('раздел Автономность: все тексты выше; в dev переключатель disabled с подписью', () => {
    const html = renderToStaticMarkup(createElement(AutonomySection, props()))
    expect(html).toContain('Отвечать за меня через')
    expect(html).toContain('мин')
    expect(html).toContain(
      'Только в режиме «авто-да»: если на вопрос или план никто не ответил, Qclod выберет рекомендуемый вариант (или первый) и одобрит план.'
    )
    expect(html).toContain('Запускать Qclod при входе в систему')
    expect(html).toContain('Вкладки откроются сами, Remote Control включится снова, а прерванная работа продолжится.')
    expect(html).toContain('Работает только в установленном Qclod.')
    expect(html).toMatch(/data-testid="setting-openAtLogin"[^>]*disabled|disabled[^>]*data-testid="setting-openAtLogin"/)
    // The page under test is no installed Qclod, and no Mac.
    expect(html).toContain(KEEP_AWAKE_WINDOWS)
    expect(html).toMatch(/data-testid="setting-autoAnswerMinutes"[^>]*value="5"|value="5"[^>]*data-testid="setting-autoAnswerMinutes"/)
  })

  test('тексты «не спать» для Windows и macOS, установленная сборка — по app.asar', () => {
    expect(KEEP_AWAKE_WINDOWS).toBe(
      'Пока агент работает, ждёт вашего ответа или сброса лимита, Qclod не даёт компьютеру уснуть. ' +
        'Закрытая крышка ноутбука, кнопка питания и «Сон» в меню «Пуск» всё равно его усыпят — ' +
        'тогда работа и Remote Control встанут до пробуждения.'
    )
    expect(KEEP_AWAKE_MAC).toBe(
      'Пока агент работает, ждёт вашего ответа или сброса лимита, Qclod не даёт компьютеру уснуть. ' +
        'Закрытая крышка MacBook всё равно его усыпит — тогда работа и Remote Control встанут до пробуждения.'
    )
    expect(keepAwakeText('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Electron/39')).toBe(KEEP_AWAKE_MAC)
    expect(keepAwakeText('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/39')).toBe(KEEP_AWAKE_WINDOWS)
    expect(installedBuild('file:///C:/Program%20Files/Qclod/resources/app.asar/out/renderer/index.html')).toBe(true)
    expect(installedBuild('file:///C:/dev/qclod/out/renderer/index.html')).toBe(false)
    expect(installedBuild('http://localhost:5173/')).toBe(false)
  })

  describe('поле минут', () => {
    let host: HTMLDivElement
    let root: Root
    beforeEach(() => {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
    })
    afterEach(() => {
      act(() => root.unmount())
      host.remove()
    })

    test('поле минут не отправляет 0 и 61', () => {
      const patch = vi.fn(async () => DEFAULT_SETTINGS)
      act(() => root.render(createElement(AutonomySection, props(patch))))
      const field = host.querySelector('[data-testid="setting-autoAnswerMinutes"]') as HTMLInputElement
      const enter = (value: string): void =>
        act(() => {
          field.value = value
          field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
        })

      for (const bad of ['0', '61', '2.5', '', 'пять']) enter(bad)
      expect(patch).not.toHaveBeenCalled()
      // A refused value goes back to the one in force.
      expect(field.value).toBe('5')

      enter('1')
      enter('60')
      enter('12')
      expect(patch.mock.calls).toEqual([[{ autoAnswerMinutes: 1 }], [{ autoAnswerMinutes: 60 }], [{ autoAnswerMinutes: 12 }]])
    })
  })
})
