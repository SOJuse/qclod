// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ServersList, removeServerQuestion } from '../../src/renderer/components/settings/ServersSection'
import type { ConnectStep, ServerView, TabState } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function server(over: Partial<ServerView> = {}): ServerView {
  return {
    id: 'h1',
    label: 'Дом',
    target: 'me@home',
    auth: 'password',
    colour: 'rose',
    recent: [],
    fromConfig: false,
    state: 'online',
    hasPassword: true,
    ...over
  }
}
const tab = (id: string, hostId?: string): TabState =>
  ({ id, cwd: '/srv', title: id, overrides: {}, status: 'idle', badge: false, ...(hostId ? { server: { hostId } } : {}) }) as TabState

let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  api = {
    removeServer: vi.fn(async () => []),
    saveServer: vi.fn(async () => [server({ id: 'h9', target: 'me@new', state: 'connecting' })]),
    connectServer: vi.fn(async () => true)
  }
  ;(window as unknown as { qclod: unknown }).qclod = api
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const byTest = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('«Удалить сервер» (R9)', () => {
  test('сначала спрашивает — с числом открытых чатов и паролем; «Отмена» ничего не удаляет', () => {
    act(() => root.render(createElement(ServersList, { servers: [server()], tabs: [tab('a', 'h1'), tab('b', 'h1'), tab('c')] })))
    act(() => byTest('server-remove').click())
    expect(api.removeServer).not.toHaveBeenCalled()
    expect(byTest('server-remove-question').textContent).toBe(
      'Удалить сервер «Дом»? Открытых чатов: 2. Сохранённый пароль тоже удалится.'
    )
    act(() => byTest('server-remove-cancel').click())
    expect(api.removeServer).not.toHaveBeenCalled()
    act(() => byTest('server-remove').click())
    act(() => byTest('server-remove-confirm').click())
    expect(api.removeServer).toHaveBeenCalledWith('h1')
  })

  test('без сохранённого пароля о нём не говорит', () => {
    expect(removeServerQuestion(server({ hasPassword: false, label: 'gw' }), 0)).toBe('Удалить сервер «gw»? Открытых чатов: 0.')
  })
})

describe('«Проверить соединение» в настройках (R3)', () => {
  test('после сохранения показывает чек-лист этого сервера', async () => {
    const steps: Record<string, ConnectStep[]> = { h9: [{ id: 'ssh', state: 'running', text: 'Связь с сервером' }] }
    act(() => root.render(createElement(ServersList, { servers: [], tabs: [], steps })))
    act(() => byTest('settings-server-add').click())
    const target = byTest('server-target') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, 'me@new')
      target.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => byTest('server-test').click())
    await flush()
    expect(api.connectServer).toHaveBeenCalledWith('h9')
    expect(byTest('connect-checklist')).not.toBeNull()
    expect(byTest('connect-checklist').querySelector('[data-step="ssh"]')!.getAttribute('data-state')).toBe('running')
  })

  test('ошибка сохранения — без «Error invoking remote method…»', async () => {
    api.saveServer!.mockRejectedValueOnce(new Error("Error invoking remote method 'servers:save': Error: хост занят"))
    act(() => root.render(createElement(ServersList, { servers: [], tabs: [] })))
    act(() => byTest('settings-server-add').click())
    const target = byTest('server-target') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, 'me@new')
      target.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => byTest('server-save').click())
    await flush()
    expect(host.querySelector('.server-error')!.textContent).toBe('хост занят')
  })
})

describe('вопрос ssh поверх настроек (R3)', () => {
  test('вопрос ssh рисуется после настроек и выше их и палитры', () => {
    const app = readFileSync('src/renderer/app/App.tsx', 'utf8')
    expect(app.lastIndexOf('<SshPromptDialog')).toBeGreaterThan(app.lastIndexOf('<SettingsScreen'))
    const css = readFileSync('src/renderer/components/servers/servers.css', 'utf8')
    const z = Number(/\.server-prompt-backdrop\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1])
    const palette = Number(/z-index:\s*(\d+)/.exec(readFileSync('src/renderer/components/CommandPalette.css', 'utf8'))?.[1])
    expect(z).toBeGreaterThan(20)
    expect(z).toBeGreaterThan(palette)
  })
})
