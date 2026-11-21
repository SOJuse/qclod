// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ChatPane } from '../../src/renderer/components/ChatPane'
import { ConnectChecklist } from '../../src/renderer/components/servers/ConnectChecklist'
import { ServerLink } from '../../src/renderer/components/servers/ServerBadge'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import { OFFLINE_STRIP_TEXT, SERVER_REMOVED_TEXT, connectionLabel } from '../../src/shared/serverTexts'
import type { ServerView, TabState } from '../../src/shared/types'

const noop = (): void => undefined
function server(over: Partial<ServerView> = {}): ServerView {
  return { id: 'h1', label: 'Дом', target: 'me@home', auth: 'key', colour: 'blue', recent: [], fromConfig: false, state: 'online', hasPassword: false, ...over }
}
const tab = { id: 't1', cwd: '/srv/app', title: 'app', overrides: {}, status: 'idle', badge: false, server: { hostId: 'h1' } } as TabState

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe(): void {}
  disconnect(): void {}
}
let host: HTMLDivElement
let root: Root
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** The pane as the window draws it, from the store (a markup render would read the store's first state). */
function pane(): string {
  act(() =>
    root.render(createElement(ChatPane, {
      tabId: 't1',
      focused: true,
      focusToken: 0,
      title: 'app',
      split: false,
      onFocus: noop,
      onOpenHistory: noop,
      onCycleMode: noop,
      onOpenSession: noop
    }))
  )
  return host.innerHTML
}

const PROBLEM = 'Ключ сервера изменился. Если сервер переустановили — удалите старый ключ: ssh-keygen -R home'

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  ;(window as unknown as { qclod: unknown }).qclod = new Proxy({}, { get: () => vi.fn(async () => undefined) })
  useAppStore.setState({ tabs: [tab], servers: [], serversLoaded: false, ribbonByTab: {}, ribbonRevByTab: {} })
})

describe('сменившийся ключ сервера — опасность (R5)', () => {
  test('шапка: «ключ сервера изменился» открывает чек-лист, без «Повторить»', () => {
    const label = connectionLabel('hostKeyChanged')
    expect(label.text).toBe('ключ сервера изменился')
    expect(label.action).toBe('checklist')
    const html = renderToStaticMarkup(createElement(ServerLink, { state: 'hostKeyChanged', onRetry: noop, onChecklist: noop }))
    expect(html).toContain('ключ сервера изменился')
    expect(html).not.toContain('Повторить')
    expect(html).toContain('data-danger="true"')
  })

  test('чек-лист: проблема — role="alert", стиль опасности и значок', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectChecklist, { steps: [], problem: PROBLEM, problemState: 'hostKeyChanged', onRetry: noop })
    )
    expect(html).toMatch(/class="server-problem is-danger"[^>]*role="alert"/)
    expect(html).toContain('<svg')
    // Other problems stay quiet.
    const quiet = renderToStaticMarkup(createElement(ConnectChecklist, { steps: [], problem: 'нет связи', problemState: 'offline', onRetry: noop }))
    expect(quiet).not.toContain('role="alert"')
    const css = readFileSync('src/renderer/components/servers/servers.css', 'utf8')
    expect(css).toMatch(/\.server-problem\.is-danger\s*\{[^}]*--status-critical/)
  })

  test('плашка над вводом — текст проблемы, а не «Сервер не на связи»', () => {
    useAppStore.setState({ servers: [server({ state: 'hostKeyChanged', problem: PROBLEM })], serversLoaded: true })
    const html = pane()
    expect(html).toContain(PROBLEM)
    expect(html).not.toContain(OFFLINE_STRIP_TEXT)
    expect(html).toMatch(/data-testid="server-key-changed"[^>]*role="alert"/)
  })
})

describe('чат удалённого сервера (R9)', () => {
  test('сервера нет в списке — «Сервер удалён», ввод неактивен', () => {
    useAppStore.setState({ servers: [], serversLoaded: true })
    const html = pane()
    expect(html).toContain(SERVER_REMOVED_TEXT)
    expect(html).toMatch(/<textarea[^>]*disabled=""/)
    expect(html).toContain('data-testid="server-removed"')
  })

  test('пока список серверов не пришёл — не «удалён»', () => {
    const html = pane()
    expect(html).not.toContain(SERVER_REMOVED_TEXT)
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/)
  })

  test('сервер на месте — ввод активен', () => {
    useAppStore.setState({ servers: [server()], serversLoaded: true })
    const html = pane()
    expect(html).not.toContain(SERVER_REMOVED_TEXT)
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/)
  })
})
