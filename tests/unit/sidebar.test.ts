import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Sidebar, type SidebarProps } from '../../src/renderer/components/sidebar/Sidebar'
import type { SidebarProject } from '../../src/renderer/chat/sidebarModel'
import type { SessionSummary, TabState } from '../../src/shared/types'

const chat = (id: string, cwd: string, patch: Partial<TabState> = {}): TabState => ({
  id,
  cwd,
  title: `чат ${id}`,
  overrides: {},
  status: 'idle',
  badge: false,
  ...patch
})

const session = (n: number): SessionSummary => ({
  id: `s${n}`,
  title: `разговор ${n}`,
  firstMessage: `первое сообщение ${n}`,
  updatedAt: 1_700_000_000_000 - n * 60_000
})

const project = (cwd: string, patch: Partial<SidebarProject> = {}): SidebarProject => ({
  key: cwd.toLowerCase(),
  cwd,
  name: cwd.split('\\').pop() ?? cwd,
  collapsed: false,
  chats: [],
  past: [],
  ...patch
})

const noop = (): void => undefined
const render = (projects: SidebarProject[], patch: Partial<SidebarProps> = {}): string =>
  renderToStaticMarkup(
    createElement(Sidebar, {
      projects,
      activeTabId: 'a',
      paneTabIds: ['a'],
      onActivate: noop,
      onClose: noop,
      onNewChat: noop,
      onOpenPast: noop,
      onToggleProject: noop,
      onForget: noop,
      onRetryPast: noop,
      ...patch
    })
  )

/** The markup of one project, from its row to the next project's. */
const projectHtml = (html: string, key: string): string => {
  const start = html.indexOf(`data-key="${key}"`)
  const next = html.indexOf('data-testid="project"', start + 1)
  return html.slice(start, next < 0 ? undefined : next)
}
const count = (html: string, testId: string): number => html.split(`data-testid="${testId}"`).length - 1

describe('Sidebar', () => {
  test('два проекта — две строки проекта, чаты внутри своих', () => {
    const html = render([
      project('C:\\a', { chats: [chat('a', 'C:\\a'), chat('b', 'C:\\a')] }),
      project('C:\\b', { chats: [chat('c', 'C:\\b')] })
    ])
    expect(count(html, 'project')).toBe(2)
    const first = projectHtml(html, 'c:\\a')
    const second = projectHtml(html, 'c:\\b')
    expect(count(first, 'tab')).toBe(2)
    expect(first).toContain('чат a')
    expect(first).toContain('чат b')
    expect(count(second, 'tab')).toBe(1)
    expect(second).toContain('чат c')
    // Name in the row, the whole path in its tooltip.
    expect(first).toMatch(/title="C:\\a"/)
  })

  test('у активного чата .is-active, у других нет', () => {
    const html = render([project('C:\\a', { chats: [chat('a', 'C:\\a'), chat('b', 'C:\\a', { status: 'busy' })] })], {
      activeTabId: 'b'
    })
    const rows = html.match(/<div[^>]*data-testid="tab"[^>]*>/g) ?? []
    expect(rows).toHaveLength(2)
    expect(rows[0]).not.toContain('is-active')
    expect(rows[1]).toContain('is-active')
    expect(html).toContain('tab-status is-busy')
    expect(html).toContain('class="tab-title"')
    expect(html).toContain('aria-label="Закрыть чат чат b"')
    expect(html).toContain('title="Закрыть чат (Ctrl+W)"')
  })

  test('у проекта без чатов есть «Убрать из списка», у проекта с чатом — нет', () => {
    const html = render([project('C:\\a', { chats: [chat('a', 'C:\\a')] }), project('C:\\b')])
    expect(projectHtml(html, 'c:\\a')).not.toContain('project-forget')
    expect(projectHtml(html, 'c:\\a')).not.toContain('project-menu')
    expect(projectHtml(html, 'c:\\b')).toContain('data-testid="project-forget"')
    expect(projectHtml(html, 'c:\\b')).toContain('Убрать из списка')
  })

  test('свёрнутый проект не рисует строк, шеврон говорит aria-expanded="false"', () => {
    const html = render([
      project('C:\\a', { collapsed: true, chats: [chat('a', 'C:\\a')], past: [session(1), session(2)] })
    ])
    expect(count(html, 'tab')).toBe(0)
    expect(count(html, 'sidebar-session')).toBe(0)
    expect(html).not.toContain('sidebar-past-head')
    expect(html).toMatch(/data-testid="project-toggle"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*data-testid="project-toggle"/)
    expect(html).toContain('aria-label="Развернуть a"')
    // The project row itself stays, with its «+».
    expect(html).toContain('aria-label="Новый чат в a"')
  })

  test('развёрнутый проект: aria-expanded="true" и «Свернуть <имя>»', () => {
    const html = render([project('C:\\a', { chats: [chat('a', 'C:\\a')] })])
    expect(html).toMatch(/aria-expanded="true"/)
    expect(html).toContain('aria-label="Свернуть a"')
  })

  test('прошлых семь — видно пять и «Показать ещё»', () => {
    const past = [1, 2, 3, 4, 5, 6, 7].map(session)
    const html = render([project('C:\\a', { chats: [chat('a', 'C:\\a')], past })])
    expect(html).toContain('data-testid="sidebar-past-head"')
    expect(html).toContain('Прошлые')
    expect(count(html, 'sidebar-session')).toBe(5)
    expect(html).toContain('разговор 5')
    expect(html).not.toContain('разговор 6')
    expect(html).toContain('data-testid="sidebar-more"')
    expect(html).toContain('Показать ещё')
  })

  test('пять прошлых — без «Показать ещё»; нет прошлых — нет и подзаголовка', () => {
    const five = render([project('C:\\a', { past: [1, 2, 3, 4, 5].map(session) })])
    expect(count(five, 'sidebar-session')).toBe(5)
    expect(five).not.toContain('sidebar-more')
    const none = render([project('C:\\a', { past: [] })])
    expect(none).not.toContain('sidebar-past-head')
  })

  test('без заголовка строка прошлого — первые 60 символов первого сообщения', () => {
    const long = 'а'.repeat(70)
    const html = render([project('C:\\a', { past: [{ ...session(1), title: '', firstMessage: long }] })])
    expect(html).toContain(`>${'а'.repeat(60)}<`)
    expect(html).not.toContain('а'.repeat(61))
  })

  test('история читается — «Загружаю…»', () => {
    const html = render([project('C:\\a', { past: 'loading' })])
    expect(html).toContain('Загружаю…')
    expect(count(html, 'sidebar-session')).toBe(0)
  })

  test('история не прочиталась — причина по-русски и «Повторить»', () => {
    const html = render([project('C:\\a', { past: { error: 'нет доступа' } })])
    expect(html).toContain('Не удалось прочитать историю')
    expect(html).toContain('Повторить')
  })

  test('над списком — «Новый чат» с подсказкой Ctrl+T', () => {
    const html = render([project('C:\\a')])
    expect(html).toMatch(/data-testid="tab-new"/)
    expect(html).toContain('title="Новый чат в другой папке (Ctrl+T)"')
  })

  test('проект на сервере — чип с меткой, цвет атрибутом, без style', () => {
    const html = render([project('C:\\a', { remote: { hostId: 'h1', label: 'сервер', color: 'blue' } })])
    expect(html).toContain('data-testid="project-remote"')
    expect(html).toContain('data-color="blue"')
    expect(html).not.toContain('data-colour')
    expect(html).toContain('>сервер<')
    expect(html).not.toContain('style=')
  })

  test('строки чатов и прошлых сессий перетаскиваются сами (П10)', () => {
    const html = render([project('C:\\a', { chats: [chat('a', 'C:\\a')], past: [session(1)] })])
    expect(html).toMatch(/<div[^>]*data-testid="tab"[^>]*draggable="true"|<div[^>]*draggable="true"[^>]*data-testid="tab"/)
    expect(html).toMatch(/<button[^>]*draggable="true"[^>]*data-testid="sidebar-session"|<button[^>]*data-testid="sidebar-session"[^>]*draggable="true"/)
  })
})
