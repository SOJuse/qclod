import { describe, expect, test } from 'vitest'
import { buildSidebar, chatOrder, nextPanes } from '../../src/renderer/chat/sidebarModel'
import type { ProjectEntry, SessionSummary, TabState } from '../../src/shared/types'

const tab = (id: string, cwd: string, lastSessionId?: string): TabState => ({
  id,
  cwd,
  title: id,
  overrides: {},
  status: 'idle',
  badge: false,
  ...(lastSessionId ? { lastSessionId } : {})
})
const project = (cwd: string, collapsed = false): ProjectEntry => ({ cwd, collapsed })
const session = (id: string, updatedAt: number): SessionSummary => ({ id, title: id, firstMessage: '', updatedAt })

describe('buildSidebar', () => {
  test('чаты одной папки в разной записи — один проект', () => {
    const sidebar = buildSidebar(
      [tab('a', 'C:\\Dev\\Proj'), tab('b', 'c:/dev/proj/')],
      [project('C:\\dev\\proj')],
      {}
    )
    expect(sidebar).toHaveLength(1)
    expect(sidebar[0]?.chats.map((c) => c.id)).toEqual(['a', 'b'])
    expect(sidebar[0]?.name).toBe('proj')
    expect(sidebar[0]?.cwd).toBe('C:\\dev\\proj')
  })

  test('открытая сессия не дублируется в прошлых, прошлые — по updatedAt по убыванию', () => {
    const sidebar = buildSidebar([tab('a', 'C:\\p', 's2')], [project('C:\\p')], {
      'c:\\p': { items: [session('s1', 10), session('s2', 99), session('s3', 50)] }
    })
    const past = sidebar[0]?.past
    expect(Array.isArray(past) && past.map((s) => s.id)).toEqual(['s3', 's1'])
  })

  test('проект без открытых чатов остаётся, а папка открытого чата вне списка идёт в конец', () => {
    const sidebar = buildSidebar([tab('a', 'D:\\other')], [project('C:\\p', true)], {})
    expect(sidebar.map((p) => p.name)).toEqual(['p', 'other'])
    expect(sidebar[0]).toMatchObject({ collapsed: true, chats: [], past: null })
    expect(sidebar[1]?.collapsed).toBe(false)
  })

  test('состояния прошлых: загрузка и ошибка', () => {
    const sidebar = buildSidebar([], [project('C:\\p'), project('C:\\q')], {
      'c:\\p': 'loading',
      'c:\\q': { items: [], error: 'нет доступа' }
    })
    expect(sidebar[0]?.past).toBe('loading')
    expect(sidebar[1]?.past).toEqual({ error: 'нет доступа' })
  })

  test('chatOrder идёт по проектам', () => {
    const sidebar = buildSidebar([tab('b', 'C:\\P2'), tab('a', 'C:\\P1')], [project('C:\\P1'), project('C:\\P2')], {})
    expect(chatOrder(sidebar)).toEqual(['a', 'b'])
  })
})

describe('nextPanes', () => {
  test('убирает дубли и режет до четырёх, активная остаётся, если в панелях', () => {
    expect(nextPanes({ paneTabIds: ['a'], activeTabId: 'a' }, ['a', 'b', 'a', 'c', 'd', 'e'])).toEqual({
      paneTabIds: ['a', 'b', 'c', 'd'],
      activeTabId: 'a'
    })
  })
})

describe('buildSidebar: прошлые, пока их перечитывают (S2-R18)', () => {
  test('прежний список стоит, пока идёт перечитывание', () => {
    const sidebar = buildSidebar([], [project('C:\\p')], {
      'c:\\p': { items: [session('s1', 10)], reading: true }
    })
    const past = sidebar[0]?.past
    expect(Array.isArray(past) && past.map((s) => s.id)).toEqual(['s1'])
  })

  test('«Загружаю…» — только когда показать нечего', () => {
    const sidebar = buildSidebar([tab('a', 'C:\\p', 's1')], [project('C:\\p'), project('C:\\q')], {
      // The only past one is open: nothing to show while the list is read again.
      'c:\\p': { items: [session('s1', 10)], reading: true },
      'c:\\q': { items: [], reading: true }
    })
    expect(sidebar[0]?.past).toBe('loading')
    expect(sidebar[1]?.past).toBe('loading')
  })
})
