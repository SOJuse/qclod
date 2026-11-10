import { describe, expect, test } from 'vitest'
import { APP_ACTIONS, hint, resolveAppShortcut, tabAtTarget } from '@renderer/app/shortcuts'
import type { KeyLike } from '@renderer/input/keyPrecedence'

function key(partial: Partial<KeyLike>): KeyLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...partial
  } as KeyLike
}

describe('resolveAppShortcut', () => {
  test('Ctrl+T на русской раскладке (е) — новая вкладка', () =>
    expect(resolveAppShortcut(key({ key: 'е', code: 'KeyT', ctrlKey: true }))).toEqual({
      id: 'newTab'
    }))

  test('Ctrl+W на русской раскладке (ц) — закрыть вкладку', () =>
    expect(resolveAppShortcut(key({ key: 'ц', code: 'KeyW', ctrlKey: true }))).toEqual({
      id: 'closeTab'
    }))

  test('Ctrl+3 — третья вкладка', () =>
    expect(resolveAppShortcut(key({ key: '3', code: 'Digit3', ctrlKey: true }))).toEqual({
      id: 'tabAt',
      index: 2
    }))

  test('Ctrl+9 — индекс 8, исполнитель читает его как «последняя»', () =>
    expect(resolveAppShortcut(key({ key: '9', code: 'Digit9', ctrlKey: true }))).toEqual({
      id: 'tabAt',
      index: 8
    }))

  test('Ctrl+0 — обычный масштаб, не вкладка', () =>
    expect(resolveAppShortcut(key({ key: '0', code: 'Digit0', ctrlKey: true }))).toEqual({
      id: 'zoomReset'
    }))

  test('масштаб и перезагрузка по физической клавише, в том числе с Shift', () => {
    expect(resolveAppShortcut(key({ key: '=', code: 'Equal', ctrlKey: true }))).toEqual({ id: 'zoomIn' })
    expect(
      resolveAppShortcut(key({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }))
    ).toEqual({ id: 'zoomIn' })
    expect(resolveAppShortcut(key({ key: '-', code: 'Minus', ctrlKey: true }))).toEqual({ id: 'zoomOut' })
    expect(resolveAppShortcut(key({ key: 'к', code: 'KeyR', ctrlKey: true }))).toEqual({ id: 'reload' })
  })

  test('Ctrl+Tab — следующая, Ctrl+Shift+Tab — предыдущая', () => {
    expect(resolveAppShortcut(key({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toEqual({
      id: 'nextTab'
    })
    expect(
      resolveAppShortcut(key({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }))
    ).toEqual({ id: 'prevTab' })
  })

  test('Ctrl+K на русской раскладке (л) — палитра действий', () =>
    expect(resolveAppShortcut(key({ key: 'л', code: 'KeyK', ctrlKey: true }))).toEqual({
      id: 'actions'
    }))

  test('Ctrl+Запятая, Ctrl+H, Ctrl+Обратная косая, Ctrl+Shift+Enter', () => {
    expect(resolveAppShortcut(key({ key: 'б', code: 'Comma', ctrlKey: true }))).toEqual({
      id: 'settings'
    })
    expect(resolveAppShortcut(key({ key: 'р', code: 'KeyH', ctrlKey: true }))).toEqual({
      id: 'history'
    })
    expect(resolveAppShortcut(key({ key: 'ё', code: 'Backslash', ctrlKey: true }))).toEqual({
      id: 'togglePanel'
    })
    expect(
      resolveAppShortcut(key({ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }))
    ).toEqual({ id: 'toggleSplit' })
  })

  test('буква без Ctrl — ничего', () =>
    expect(resolveAppShortcut(key({ key: 't', code: 'KeyT' }))).toBeNull())

  test('Ctrl+Shift+T, Ctrl+Alt+T и Ctrl+Enter — не наши', () => {
    expect(resolveAppShortcut(key({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(resolveAppShortcut(key({ key: 't', code: 'KeyT', ctrlKey: true, altKey: true }))).toBeNull()
    expect(resolveAppShortcut(key({ key: 'Enter', code: 'Enter', ctrlKey: true }))).toBeNull()
  })

  test('IME собирает символ — клавиши его', () =>
    expect(
      resolveAppShortcut(key({ key: 't', code: 'KeyT', ctrlKey: true, isComposing: true }))
    ).toBeNull())
})

describe('hint', () => {
  test('подпись и сочетание', () => {
    expect(hint('Новая вкладка', 'newTab')).toBe('Новая вкладка (Ctrl+T)')
    expect(hint('Настройки', 'settings')).toBe('Настройки (Ctrl+,)')
  })
  test('без id или у действия без сочетания — просто подпись', () => {
    expect(hint('Что-то')).toBe('Что-то')
    expect(hint('Перезапустить сессию', 'restart')).toBe('Перезапустить сессию')
  })
})

describe('APP_ACTIONS', () => {
  test('каждое действие один раз, подписи по-русски', () => {
    const ids = APP_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(APP_ACTIONS.find((a) => a.id === 'closeTab')).toEqual({
      id: 'closeTab',
      label: 'Закрыть вкладку',
      keys: 'Ctrl+W'
    })
    expect(APP_ACTIONS.find((a) => a.id === 'cycleMode')?.keys).toBe('Shift+Tab')
    for (const id of ['zoomIn', 'zoomOut', 'zoomReset'] as const) {
      expect(APP_ACTIONS.some((a) => a.id === id)).toBe(true)
    }
  })
})

describe('tabAtTarget', () => {
  const ids = ['a', 'b', 'c']
  test('Ctrl+9 (индекс 8) — последняя из трёх', () => expect(tabAtTarget(ids, 8)).toBe('c'))
  test('Ctrl+2 — вторая; Ctrl+5 при трёх — ничего', () => {
    expect(tabAtTarget(ids, 1)).toBe('b')
    expect(tabAtTarget(ids, 4)).toBeNull()
  })
  test('нет вкладок — ничего', () => expect(tabAtTarget([], 8)).toBeNull())
})
