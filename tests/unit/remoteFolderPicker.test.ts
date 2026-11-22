import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { RemoteFolderView, crumbs, parentPath } from '../../src/renderer/components/servers/RemoteFolderPicker'
import type { ServerView } from '../../src/shared/types'

const noop = (): void => undefined
const server: ServerView = {
  id: 'h1',
  label: 'Дом',
  target: 'me@home',
  auth: 'key',
  colour: 'green',
  recent: ['~/projects/app', '/srv/site'],
  fromConfig: false,
  state: 'online',
  hasPassword: false
}

function view(over: Partial<Parameters<typeof RemoteFolderView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(RemoteFolderView, {
      server,
      listing: {
        path: '~/projects',
        entries: [
          { name: 'app', kind: 'dir', size: 0, mtime: 0 },
          { name: 'notes.md', kind: 'file', size: 10, mtime: 0 },
          { name: 'linked', kind: 'link', size: 0, mtime: 0 }
        ],
        truncated: false
      },
      error: null,
      loading: false,
      typed: '~/projects',
      onType: noop,
      onGo: noop,
      onOpenHere: noop,
      onCancel: noop,
      ...over
    })
  )
}

describe('выбор папки на сервере', () => {
  test('заголовок, поле пути, «Вверх», «Открыть здесь»; «Недавние» выше списка; файлы не показаны', () => {
    const html = view()
    expect(html).toContain('Папка на сервере Дом')
    expect(html).toContain('placeholder="Путь, например ~/projects/app"')
    expect(html).toContain('Вверх')
    expect(html).toContain('Открыть здесь')
    expect(html.indexOf('Недавние')).toBeGreaterThan(-1)
    expect(html.indexOf('Недавние')).toBeLessThan(html.indexOf('data-testid="remote-list"'))
    expect(html).toContain('>app<')
    expect(html).not.toContain('notes.md')
    expect(html.match(/data-testid="remote-dir"/g)).toHaveLength(2)
  })

  test('при truncated — «Показаны первые 2000»; пусто — «Папка пуста»; ошибка — «Не удалось открыть: …»', () => {
    expect(view({ listing: { path: '/', entries: [], truncated: true } })).toContain('Показаны первые 2000')
    expect(view({ listing: { path: '/empty', entries: [], truncated: false } })).toContain('Папка пуста')
    expect(view({ error: 'нет доступа', listing: null })).toContain('Не удалось открыть: нет доступа')
  })

  test('путь вверх и хлебные крошки', () => {
    expect(parentPath('~/projects/app')).toBe('~/projects')
    expect(parentPath('~/projects')).toBe('~')
    expect(parentPath('/srv')).toBe('/')
    expect(parentPath('/')).toBe('/')
    expect(crumbs('~/projects/app').map((c) => c.path)).toEqual(['~', '~/projects', '~/projects/app'])
    expect(crumbs('/srv/site').map((c) => c.name)).toEqual(['/', 'srv', 'site'])
  })
})
