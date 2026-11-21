// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/** xterm.js stand-in: what the drawer writes and the key handler it installs. */
const terms = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    written: string[] = []
    focused = 0
    keyHandler: ((ev: KeyboardEvent) => boolean) | null = null
    disposed = false
    constructor() {
      terms.push(this as unknown as Record<string, unknown>)
    }
    loadAddon(): void {}
    open(): void {}
    write(d: string): void {
      this.written.push(d)
    }
    writeln(d: string): void {
      this.written.push(`${d}\n`)
    }
    focus(): void {
      this.focused++
    }
    onData(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    onResize(): { dispose(): void } {
      return { dispose: () => undefined }
    }
    attachCustomKeyEventHandler(fn: (ev: KeyboardEvent) => boolean): void {
      this.keyHandler = fn
    }
    dispose(): void {
      this.disposed = true
    }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import { TerminalDrawer, terminalKeyRoute } from '../../src/renderer/components/terminal/TerminalDrawer'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import type { TabState } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe(): void {}
  disconnect(): void {}
}

const ID = '0b9a6c2e-4f1d-4a7b-9c3e-1d2f3a4b5c6d'
let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  terms.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  api = {
    terminalOpen: vi.fn(async () => ID),
    terminalAttach: vi.fn(async () => 'было\r\n'),
    terminalClose: vi.fn(async () => undefined),
    terminalResize: vi.fn(async () => undefined),
    terminalInput: vi.fn(),
    onTerminalData: vi.fn(() => () => undefined),
    onTerminalExit: vi.fn(() => () => undefined)
  }
  ;(window as unknown as { qclod: unknown }).qclod = api
  const tab = { id: 't1', cwd: '/srv', title: 'x', overrides: {}, status: 'idle', badge: false, server: { hostId: 'h1' } } as TabState
  useAppStore.setState({ tabs: [tab], terminalIdByTab: {} })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const drawer = (shown = true, extra: Record<string, unknown> = {}) =>
  createElement(TerminalDrawer, { tabId: 't1', label: 'Дом', shown, onHide: () => undefined, ...extra })

describe('терминал сервера при переключении чата (R1)', () => {
  test('размонтирование не закрывает сессию; новый монтаж подключается к ней и показывает прошлый вывод', async () => {
    act(() => root.render(drawer()))
    await flush()
    expect(api.terminalOpen).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().terminalIdByTab['t1']).toBe(ID)

    act(() => root.render(createElement('div')))
    expect(api.terminalClose).not.toHaveBeenCalled()

    act(() => root.render(drawer()))
    await flush()
    expect(api.terminalOpen).toHaveBeenCalledTimes(1)
    expect(api.terminalAttach).toHaveBeenCalledWith('t1', ID)
    expect(terms[1]!['written']).toContain('было\r\n')
  })

  test('сессия кончилась, пока чата не было на экране: «Сессия завершена», новый терминал не открывается сам', async () => {
    useAppStore.setState({ terminalIdByTab: { t1: ID } })
    api.terminalAttach!.mockResolvedValueOnce(null)
    act(() => root.render(drawer()))
    await flush()
    expect(api.terminalOpen).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="terminal-drawer"]')!.getAttribute('data-ended')).toBe('true')
    expect(useAppStore.getState().terminalIdByTab['t1']).toBeUndefined()
  })

  test('закрытие чата забывает его терминал в окне', async () => {
    useAppStore.setState({ terminalIdByTab: { t1: ID } })
    useAppStore.getState().setTabs([])
    expect(useAppStore.getState().terminalIdByTab['t1']).toBeUndefined()
  })

  test('отказ terminalOpen — понятный текст в терминале, без необработанного отказа', async () => {
    api.terminalOpen!.mockRejectedValueOnce(new Error("Error invoking remote method 'terminal:open': Error: нет связи"))
    act(() => root.render(drawer()))
    await flush()
    const out = (terms[0]!['written'] as string[]).join('')
    expect(out).toContain('Терминал не открылся: нет связи.')
    expect(out).not.toContain('Error invoking')
  })
})

const key = (code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ type: 'keydown', code, key: code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, preventDefault: () => undefined, ...mods }) as unknown as KeyboardEvent

describe('клавиши из терминала (R10)', () => {
  test('Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+1…9, Ctrl+, — окну; Ctrl+Shift+K — палитра; Ctrl+K, Ctrl+C, Ctrl+W — терминалу', () => {
    expect(terminalKeyRoute(key('Tab', { ctrlKey: true }))).toBe('window')
    expect(terminalKeyRoute(key('Tab', { ctrlKey: true, shiftKey: true }))).toBe('window')
    for (let d = 1; d <= 9; d++) expect(terminalKeyRoute(key(`Digit${d}`, { ctrlKey: true }))).toBe('window')
    expect(terminalKeyRoute(key('Comma', { ctrlKey: true }))).toBe('window')
    expect(terminalKeyRoute(key('KeyK', { ctrlKey: true, shiftKey: true }))).toBe('palette')
    expect(terminalKeyRoute(key('KeyK', { ctrlKey: true }))).toBe('terminal')
    expect(terminalKeyRoute(key('KeyC', { ctrlKey: true }))).toBe('terminal')
    expect(terminalKeyRoute(key('KeyW', { ctrlKey: true }))).toBe('terminal')
    expect(terminalKeyRoute(key('Tab'))).toBe('terminal')
    expect(terminalKeyRoute(key('Digit1'))).toBe('terminal')
  })

  test('обработчик xterm пропускает Ctrl+Tab окну, Ctrl+Shift+K открывает палитру; показ — фокус в терминал', async () => {
    const onOpenPalette = vi.fn()
    act(() => root.render(drawer(true, { onOpenPalette })))
    await flush()
    const term = terms[0]!
    const handler = term['keyHandler'] as (ev: KeyboardEvent) => boolean
    expect(handler(key('Tab', { ctrlKey: true }))).toBe(false)
    expect(handler(key('KeyK', { ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
    expect(handler(key('KeyK', { ctrlKey: true }))).toBe(true)
    expect(term['focused']).toBeGreaterThan(0)
  })

  test('«Скрыть» — onHide; скрытый терминал фокус не берёт', async () => {
    const onHide = vi.fn()
    act(() => root.render(drawer(false, { onHide })))
    await flush()
    expect(terms[0]!['focused']).toBe(0)
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="terminal-hide"]')!.click())
    expect(onHide).toHaveBeenCalled()
  })
})
