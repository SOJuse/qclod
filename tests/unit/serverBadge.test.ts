import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ServerBadge, ServerLink } from '../../src/renderer/components/servers/ServerBadge'
import { ChatHeader } from '../../src/renderer/components/ChatHeader'
import { SERVER_COLOUR_LIST } from '../../src/shared/serverColours'
import { OFFLINE_STRIP_TEXT, connectionLabel } from '../../src/shared/serverTexts'
import type { ServerView } from '../../src/shared/types'

const server: ServerView = {
  id: 'h1',
  label: 'Дом',
  target: 'me@home',
  auth: 'key',
  colour: 'amber',
  recent: [],
  fromConfig: false,
  state: 'online',
  hasPassword: false
}

describe('метка и цвет сервера', () => {
  test('бейдж содержит метку и data-colour с цветом, атрибута style нет', () => {
    const html = renderToStaticMarkup(createElement(ServerBadge, { server }))
    expect(html).toContain('>Дом<')
    expect(html).toContain('data-colour="amber"')
    expect(html).not.toContain('style=')
  })

  test('шесть цветов по порядку кружков', () => {
    expect(SERVER_COLOUR_LIST).toEqual(['blue', 'violet', 'green', 'amber', 'rose', 'cyan'])
  })

  test('индикатор — четыре текста', () => {
    expect(connectionLabel('online').text).toBe('на связи')
    expect(connectionLabel('reconnecting').text).toBe('переподключение…')
    expect(connectionLabel('offline')).toEqual({ text: 'нет связи — Повторить', action: 'retry' })
    expect(connectionLabel('needsAuth')).toEqual({ text: 'нужен пароль — Подключиться', action: 'connect' })
    const down = renderToStaticMarkup(createElement(ServerLink, { state: 'offline', onRetry: () => undefined }))
    expect(down).toMatch(/<button[^>]*>нет связи — Повторить<\/button>/)
    const up = renderToStaticMarkup(createElement(ServerLink, { state: 'online' }))
    expect(up).toMatch(/<span[^>]*>на связи<\/span>/)
    expect(OFFLINE_STRIP_TEXT).toBe('Сервер не на связи. Сообщения уйдут, когда он вернётся.')
  })

  test('шапка серверного чата — бейдж и связь; у локального их нет', () => {
    const props = { title: 'app', cwd: '/srv/app', status: 'idle' as const, split: false, panelShown: false, onTogglePanel: () => undefined }
    const remote = renderToStaticMarkup(createElement(ChatHeader, { ...props, server: { ...server, state: 'reconnecting' } }))
    expect(remote).toContain('data-testid="server-badge"')
    expect(remote).toContain('переподключение…')
    const local = renderToStaticMarkup(createElement(ChatHeader, props))
    expect(local).not.toContain('server-badge')
  })
})
