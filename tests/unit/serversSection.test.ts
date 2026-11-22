import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, test } from 'vitest'
import { ServersList, ServersSection } from '../../src/renderer/components/settings/ServersSection'
import { sortedSections } from '../../src/renderer/components/settings/registry'
import type { SettingsSectionProps } from '../../src/renderer/components/settings/types'
import { DEFAULT_SETTINGS } from '../../src/main/store/settingsStore'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import type { ServerView } from '../../src/shared/types'

const props: SettingsSectionProps = { settings: DEFAULT_SETTINGS, patch: async () => DEFAULT_SETTINGS, models: [], version: '1.0.0' }

function server(over: Partial<ServerView>): ServerView {
  return {
    id: 'h1',
    label: 'Дом',
    target: 'me@home',
    auth: 'password',
    colour: 'rose',
    recent: [],
    fromConfig: false,
    state: 'online',
    hasPassword: false,
    ...over
  }
}

beforeEach(() => {
  useAppStore.setState({ servers: [], tabs: [] })
})

describe('раздел «Серверы»', () => {
  test('раздел servers стоит после voice (50) и перед about (90)', () => {
    const list = sortedSections()
    const at = list.findIndex((s) => s.id === 'servers')
    expect(list[at]).toMatchObject({ id: 'servers', title: 'Серверы', order: 60, Component: ServersSection })
    expect(list.slice(0, at).every((s) => s.order < 60)).toBe(true)
    expect(list.slice(0, at).map((s) => s.id)).toContain('permissions')
    expect(list[at + 1]!.id).toBe('about')
  })

  test('«Забыть» видно только при hasPassword; метка, цвета, хост, посредник и удаление', () => {
    const servers = [
        server({ id: 'h1', hasPassword: true, info: { hostname: 'box', user: 'me', home: '/home/me', arch: 'x64', relay: '1.0.0', supervisor: 'systemd', linger: 'yes', claudeVersion: '2.1.317' }, relayUpdate: 'pending' }),
        server({ id: 'h2', label: 'Работа', target: 'me@work', hasPassword: false })
      ]
    const html = renderToStaticMarkup(createElement(ServersList, { servers, tabs: [] }))
    // The section itself renders the same list from the store.
    expect(renderToStaticMarkup(createElement(ServersSection, props))).toContain('data-testid="settings-servers"')
    const cards = html.split('data-testid="server-card"').slice(1)
    expect(cards).toHaveLength(2)
    expect(cards[0]).toContain('Пароль сохранён')
    expect(cards[0]).toContain('Забыть')
    expect(cards[1]).not.toContain('Забыть')
    expect(cards[0]).toContain('Посредник 1.0.0')
    expect(cards[0]).toContain('Обновить посредник')
    expect(cards[1]).not.toContain('Обновить посредник')
    expect(cards[0]!.match(/class="server-colour"/g)).toHaveLength(6)
    expect(cards[0]).toContain('me@home')
    expect(html).toContain('Удалить сервер')
    expect(html).toContain('Добавить сервер')
    expect(html).not.toContain('style=')
  })
})
