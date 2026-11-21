// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const spy = vi.hoisted(() => ({
  press: vi.fn(),
  release: vi.fn(),
  stop: vi.fn(),
  blur: vi.fn(),
  hide: vi.fn(),
  session: null as unknown
}))
vi.mock('../../src/renderer/voice/voiceStore', () => ({
  pressVoice: spy.press,
  releaseVoice: spy.release,
  stopVoice: spy.stop,
  blurVoice: spy.blur,
  hideVoice: spy.hide,
  setVoiceHooks: () => {},
  startVoiceSync: () => () => {},
  useVoice: { getState: () => ({ session: spy.session }) }
}))

import { useAppStore } from '../../src/renderer/state/useAppStore'
import { useVoiceHotkey } from '../../src/renderer/voice/useVoiceHotkey'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function Probe(): null {
  useVoiceHotkey({ openSettings: () => {}, focusField: () => {} })
  return null
}

beforeEach(() => {
  for (const f of [spy.press, spy.release, spy.stop, spy.blur, spy.hide]) f.mockClear()
  spy.session = null
  useAppStore.setState({ activeTabId: 'A' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(createElement(Probe)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.querySelectorAll('[aria-modal]').forEach((n) => n.remove())
})

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  document.body.dispatchEvent(ev)
  return ev
}

describe('useVoiceHotkey', () => {
  test('Ctrl+Пробел — нажатие на активной панели, без действия по умолчанию; отпускание — release', () => {
    const down = key('keydown', { code: 'Space', key: ' ', ctrlKey: true })
    expect(down.defaultPrevented).toBe(true)
    expect(spy.press).toHaveBeenCalledWith('A', 'key')
    key('keyup', { code: 'Space', key: ' ', ctrlKey: true })
    expect(spy.release).toHaveBeenCalledTimes(1)
  })

  test('Ctrl отпущен раньше пробела — тоже конец удержания', () => {
    key('keydown', { code: 'Space', key: ' ', ctrlKey: true })
    key('keyup', { code: 'ControlLeft', key: 'Control' })
    key('keyup', { code: 'Space', key: ' ' })
    expect(spy.release).toHaveBeenCalledTimes(1)
  })

  test('автоповтор и Ctrl+Shift+Пробел не нажимают', () => {
    key('keydown', { code: 'Space', key: ' ', ctrlKey: true, repeat: true })
    key('keydown', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true })
    expect(spy.press).not.toHaveBeenCalled()
  })

  test('открыт модальный слой — клавиша не работает', () => {
    const modal = document.createElement('div')
    modal.setAttribute('aria-modal', 'true')
    document.body.appendChild(modal)
    key('keydown', { code: 'Space', key: ' ', ctrlKey: true })
    expect(spy.press).not.toHaveBeenCalled()
  })

  test('Esc во время записи — стоп голоса, дальше событие не идёт', () => {
    spy.session = { id: 's', tabId: 'A' }
    const field = document.createElement('textarea')
    document.body.appendChild(field)
    const seen = vi.fn()
    field.addEventListener('keydown', seen)
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    field.dispatchEvent(ev)
    expect(spy.stop).toHaveBeenCalledTimes(1)
    expect(seen).not.toHaveBeenCalled()
    field.remove()
  })

  test('Esc без записи — как раньше', () => {
    key('keydown', { key: 'Escape' })
    expect(spy.stop).not.toHaveBeenCalled()
  })

  test('потеря фокуса — blur; скрытие окна — hide', () => {
    window.dispatchEvent(new Event('blur'))
    expect(spy.blur).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(spy.hide).toHaveBeenCalledTimes(1)
  })
})
