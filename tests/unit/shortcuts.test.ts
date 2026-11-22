import { describe, expect, test } from 'vitest'
import { APP_ACTIONS, actionKeys, formatKeys, hint, resolveAppShortcut, tabAtTarget } from '@renderer/app/shortcuts'
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

  test('Ctrl+B на русской раскладке (и) — показать или скрыть боковую панель', () => {
    expect(resolveAppShortcut(key({ key: 'и', code: 'KeyB', ctrlKey: true }))).toEqual({ id: 'toggleSidebar' })
    expect(resolveAppShortcut(key({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }))).toBeNull()
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
    expect(hint('Новый чат', 'newTab')).toBe('Новый чат (Ctrl+T)')
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
      label: 'Закрыть чат',
      keys: 'Mod+W'
    })
    expect(APP_ACTIONS.find((a) => a.id === 'cycleMode')?.keys).toBe('Shift+Tab')
    for (const id of ['zoomIn', 'zoomOut', 'zoomReset'] as const) {
      expect(APP_ACTIONS.some((a) => a.id === id)).toBe(true)
    }
  })
})

describe('APP_ACTIONS: чаты, история, боковая панель и сплит', () => {
  test('подписи и клавиши — строками плана', () => {
    const row = (id: string) => {
      const found = APP_ACTIONS.find((a) => a.id === id)
      return found && { label: found.label, keys: found.keys }
    }
    expect(row('newTab')).toEqual({ label: 'Новый чат', keys: 'Mod+T' })
    expect(row('closeTab')).toEqual({ label: 'Закрыть чат', keys: 'Mod+W' })
    expect(row('nextTab')).toEqual({ label: 'Следующий чат', keys: 'Ctrl+Tab' })
    expect(row('prevTab')).toEqual({ label: 'Предыдущий чат', keys: 'Ctrl+Shift+Tab' })
    expect(row('history')).toEqual({ label: 'Прошлые разговоры', keys: 'Mod+H' })
    expect(row('toggleSidebar')).toEqual({ label: 'Показать или скрыть боковую панель', keys: 'Mod+B' })
    expect(row('toggleSplit')).toEqual({ label: 'Сплит: открыть рядом или закрыть', keys: 'Mod+Shift+Enter' })
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

describe('formatKeys', () => {
  test('Mac: глифы без плюсов; Windows: как раньше', () => {
    expect(formatKeys('Mod+T', 'darwin')).toBe('⌘T')
    expect(formatKeys('Mod+T', 'win32')).toBe('Ctrl+T')
    expect(formatKeys('Mod+Shift+Enter', 'darwin')).toBe('⌘⇧↩')
    expect(formatKeys('Mod+Shift+Enter', 'win32')).toBe('Ctrl+Shift+Enter')
    expect(formatKeys('Ctrl+Tab', 'darwin')).toBe('⌃Tab')
    expect(formatKeys('Ctrl+Tab', 'win32')).toBe('Ctrl+Tab')
    expect(formatKeys('Shift+Tab', 'darwin')).toBe('⇧Tab')
    expect(formatKeys('Mod+=', 'darwin')).toBe('⌘=')
  })
  test('подсказки и история на Mac', () => {
    expect(hint('Новый чат', 'newTab', 'darwin')).toBe('Новый чат (⌘T)')
    expect(actionKeys('history', 'darwin')).toBe('⌘Y')
    expect(actionKeys('history', 'win32')).toBe('Ctrl+H')
  })
})

describe('resolveAppShortcut на Mac', () => {
  test('⌘T — новая вкладка, на Windows тот же ввод — ничего', () => {
    const ev = key({ key: 't', code: 'KeyT', metaKey: true })
    expect(resolveAppShortcut(ev, 'darwin')).toEqual({ id: 'newTab' })
    expect(resolveAppShortcut(ev, 'win32')).toBeNull()
  })
  test('⌃T на Mac не наше', () =>
    expect(resolveAppShortcut(key({ key: 't', code: 'KeyT', ctrlKey: true }), 'darwin')).toBeNull())
  test('⌘H скрывает приложение, ⌘Y — история', () => {
    expect(resolveAppShortcut(key({ key: 'h', code: 'KeyH', metaKey: true }), 'darwin')).toBeNull()
    expect(resolveAppShortcut(key({ key: 'y', code: 'KeyY', metaKey: true }), 'darwin')).toEqual({ id: 'history' })
    expect(resolveAppShortcut(key({ key: 'y', code: 'KeyY', ctrlKey: true }), 'win32')).toBeNull()
  })
  test('⌃Tab — следующий чат, ⌘Tab — нет', () => {
    expect(resolveAppShortcut(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), 'darwin')).toEqual({ id: 'nextTab' })
    expect(resolveAppShortcut(key({ key: 'Tab', code: 'Tab', metaKey: true }), 'darwin')).toBeNull()
  })
  test('русская раскладка: ⌘Л — палитра', () =>
    expect(resolveAppShortcut(key({ key: 'л', code: 'KeyK', metaKey: true }), 'darwin')).toEqual({ id: 'actions' }))
  test('⌘⇧↩ — сплит, ⌘9 — последняя вкладка', () => {
    expect(resolveAppShortcut(key({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true }), 'darwin')).toEqual({ id: 'toggleSplit' })
    expect(resolveAppShortcut(key({ key: '9', code: 'Digit9', metaKey: true }), 'darwin')).toEqual({ id: 'tabAt', index: 8 })
  })
})
