import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EMPTY_PANEL, MAX_PANES, MISSING_TTL_MS, pathSettled, useAppStore } from '../../src/renderer/state/useAppStore'
import type { LayoutState, RibbonItem, TabState } from '../../src/shared/types'
import { nextPanes } from '../../src/renderer/chat/sidebarModel'

// One store per process: every test starts from the state it was created with.
const initial = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState(initial, true)
})

describe('useAppStore: панель', () => {
  test('старый снимок не затирает более свежий патч', () => {
    const store = useAppStore.getState()
    store.applyPanel('a', { model: 'x' }, 5)
    store.setPanelSnapshot('a', { rev: 3, data: { ...EMPTY_PANEL, model: 'old' } })

    const state = useAppStore.getState()
    expect(state.panelByTab['a']?.model).toBe('x')
    expect(state.panelRevByTab['a']).toBe(5)
  })

  test('снимок новее — заменяет всё', () => {
    const store = useAppStore.getState()
    store.applyPanel('a', { model: 'x', effort: 'high' }, 5)
    store.setPanelSnapshot('a', {
      rev: 9,
      data: { ...EMPTY_PANEL, model: 'claude-opus-5', mcp: [{ name: 'unity', status: 'connected' }] }
    })

    const state = useAppStore.getState()
    expect(state.panelByTab['a']).toEqual({
      ...EMPTY_PANEL,
      model: 'claude-opus-5',
      mcp: [{ name: 'unity', status: 'connected' }]
    })
    // Replaced, not merged: the snapshot is the whole truth at rev 9.
    expect(state.panelByTab['a']?.effort).toBeNull()
    expect(state.panelRevByTab['a']).toBe(9)
  })

  test('снимок с той же ревизией принимается, а у новой вкладки — любой', () => {
    const store = useAppStore.getState()
    // A tab the window has heard nothing about takes even a rev-0 snapshot.
    store.setPanelSnapshot('b', { rev: 0, data: { ...EMPTY_PANEL, model: 'm0' } })
    expect(useAppStore.getState().panelByTab['b']?.model).toBe('m0')

    store.applyPanel('a', { model: 'x' }, 4)
    store.setPanelSnapshot('a', { rev: 4, data: { ...EMPTY_PANEL, model: 'x', effort: 'low' } })
    expect(useAppStore.getState().panelByTab['a']?.effort).toBe('low')
  })

  test('патч применяется поверх, ревизия запоминается только большая', () => {
    const store = useAppStore.getState()
    store.applyPanel('a', { model: 'x' }, 7)
    store.applyPanel('a', { effort: 'high' }, 8)

    const state = useAppStore.getState()
    expect(state.panelByTab['a']).toMatchObject({ model: 'x', effort: 'high' })
    expect(state.panelRevByTab['a']).toBe(8)

    store.applyPanel('a', { model: 'z' }, 6)
    expect(useAppStore.getState().panelByTab['a']?.model).toBe('z')
    expect(useAppStore.getState().panelRevByTab['a']).toBe(8)
  })

  test('вкладки не делят ревизии', () => {
    const store = useAppStore.getState()
    store.applyPanel('a', { model: 'x' }, 10)
    store.setPanelSnapshot('b', { rev: 2, data: { ...EMPTY_PANEL, model: 'y' } })

    expect(useAppStore.getState().panelByTab['b']?.model).toBe('y')
    expect(useAppStore.getState().panelByTab['a']?.model).toBe('x')
  })
})

describe('useAppStore: лента и ревизии', () => {
  const notice = (id: string, text = id) =>
    ({ kind: 'notice', id, text, tone: 'info' }) as const
  const append = (id: string, text = id) => ({ kind: 'append' as const, item: notice(id, text) })
  const ids = (tab: string): string[] =>
    (useAppStore.getState().ribbonByTab[tab] ?? []).map((i) => i.id)

  test('снимок, затем запоздавшее событие из него же — без повторов', () => {
    const store = useAppStore.getState()
    // The snapshot already holds r1..r3; the event carrying r3 was still in the batch.
    store.setRibbon('a', { rev: 3, items: [notice('r1'), notice('r2'), notice('r3')], todo: null })
    store.applyRibbon('a', [append('r3')], 3)

    expect(ids('a')).toEqual(['r1', 'r2', 'r3'])
  })

  test('событие раньше снимка — снимок всё равно ставит всю историю', () => {
    const store = useAppStore.getState()
    // A live change lands before the snapshot was answered.
    store.applyRibbon('a', [append('r4')], 4)
    store.setRibbon('a', {
      rev: 4,
      items: [notice('r1'), notice('r2'), notice('r3'), notice('r4')],
      todo: null
    })

    expect(ids('a')).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  test('события новее снимка ложатся поверх него', () => {
    const store = useAppStore.getState()
    store.setRibbon('a', { rev: 2, items: [notice('r1'), notice('r2')], todo: null })
    store.applyRibbon('a', [append('r3'), { kind: 'update', id: 'r1', patch: { text: 'новое' } }], 5)

    expect(ids('a')).toEqual(['r1', 'r2', 'r3'])
    expect(useAppStore.getState().ribbonByTab['a']?.[0]).toMatchObject({ text: 'новое' })
    expect(useAppStore.getState().ribbonRevByTab['a']).toBe(5)
  })

  test('событие с ревизией не новее текущей отбрасывается', () => {
    const store = useAppStore.getState()
    store.applyRibbon('a', [append('r1')], 5)
    store.applyRibbon('a', [append('r0')], 4)
    store.applyRibbon('a', [{ kind: 'update', id: 'r1', patch: { text: 'старое' } }], 5)

    expect(ids('a')).toEqual(['r1'])
    expect(useAppStore.getState().ribbonByTab['a']?.[0]).toMatchObject({ text: 'r1' })
  })

  test('старый снимок не затирает ленту новее себя', () => {
    const store = useAppStore.getState()
    store.setRibbon('a', { rev: 6, items: [notice('r1'), notice('r2')], todo: null })
    store.setRibbon('a', { rev: 5, items: [notice('r1')], todo: null })

    expect(ids('a')).toEqual(['r1', 'r2'])
  })

  test('повторное добавление того же id заменяет элемент, а не дублирует', () => {
    const store = useAppStore.getState()
    store.applyRibbon('a', [append('r1', 'первый')], 1)
    store.applyRibbon('a', [append('r1', 'второй'), append('r2')], 2)

    expect(ids('a')).toEqual(['r1', 'r2'])
    expect(useAppStore.getState().ribbonByTab['a']?.[0]).toMatchObject({ text: 'второй' })
  })

  test('снимок приносит и список задач', () => {
    const store = useAppStore.getState()
    store.setRibbon('a', {
      rev: 1,
      items: [],
      todo: [{ content: 'разобрать ленту', status: 'in_progress' }]
    })

    expect(useAppStore.getState().todoByTab['a']).toEqual([
      { content: 'разобрать ленту', status: 'in_progress' }
    ])
  })
})

describe('useAppStore: закрытые вкладки', () => {
  const tab = (id: string): TabState => ({
    id,
    cwd: 'C:\p',
    title: id,
    overrides: {},
    status: 'idle',
    badge: false
  })
  const fill = (id: string): void => {
    const store = useAppStore.getState()
    store.applyRibbon(id, [{ kind: 'append', item: { kind: 'notice', id: 'r1', text: 't', tone: 'info' } }], 1)
    store.setRibbon(id, { rev: 2, items: [], todo: [{ content: 'x', status: 'pending' }] })
    store.applyPanel(id, { model: 'm' }, 3)
    store.setDraft(id, 'черновик')
    store.setAttachments(id, [])
    store.setFileIndex(id, ['a'])
    store.setPaths(id, [['src/a.ts', null]])
  }
  const keysOf = (id: string): string[] => {
    const s = useAppStore.getState()
    return [s.ribbonByTab, s.ribbonRevByTab, s.todoByTab, s.panelByTab, s.panelRevByTab, s.draftByTab, s.attachmentsByTab, s.fileIndexByTab, s.busySinceByTab, s.pathsByTab]
      .map((m, i) => (id in m ? String(i) : ''))
      .filter(Boolean)
  }

  test('закрытая вкладка не оставляет ленту, панель, черновик и индекс файлов', () => {
    useAppStore.getState().setTabs([tab('A'), tab('B')])
    fill('A')
    fill('B')
    useAppStore.getState().setTabs([tab('A')])

    expect(keysOf('B')).toEqual([])
    expect(keysOf('A')).toHaveLength(9)
  })

  test('лента вкладки, ещё не пришедшей в списке, не стирается', () => {
    useAppStore.getState().setTabs([tab('A')])
    fill('C')
    useAppStore.getState().setTabs([tab('A')])

    expect(useAppStore.getState().ribbonByTab['C']).toBeDefined()
    expect(keysOf('C')).toHaveLength(9)
  })

  test('запоздавшие записи для только что закрытой вкладки ничего не оставляют', () => {
    const store = useAppStore.getState()
    store.setTabs([tab('A'), tab('B')])
    store.setTabs([tab('A')])

    store.applyRibbon('B', [{ kind: 'append', item: { kind: 'notice', id: 'r1', text: 't', tone: 'info' } }], 1)
    store.setRibbon('B', { rev: 2, items: [], todo: [{ content: 'x', status: 'pending' }] })
    store.applyPanel('B', { model: 'm' }, 3)
    store.setPanelSnapshot('B', { rev: 4, data: EMPTY_PANEL })
    store.setDraft('B', 'x')
    store.setAttachments('B', [])
    store.setFileIndex('B', ['a'])
    store.setPaths('B', [['src/a.ts', null]])

    expect(keysOf('B')).toEqual([])
  })
})

describe('useAppStore: пути', () => {
  test('ответы о путях копятся по вкладке, в том числе «нет такого»', () => {
    const store = useAppStore.getState()
    const hit = { raw: 'src/a.ts', absPath: 'C:\\p\\src\\a.ts', isDir: false }
    store.setPaths('P', [['src/a.ts', hit]])
    store.setPaths('P', [['src/нет.ts', null]])
    const known = useAppStore.getState().pathsByTab['P']!
    expect(known.get('src/a.ts')?.target).toEqual(hit)
    expect(known.has('src/нет.ts')).toBe(true)
    expect(known.get('src/нет.ts')?.target).toBeNull()
    expect(useAppStore.getState().pathsByTab['Q']).toBeUndefined()
  })
})

describe('useAppStore: «нет такого файла» не навсегда', () => {
  const hit = { raw: 'src/a.ts', absPath: 'C:\\p\\src\\a.ts', isDir: false }
  const tool = (name: string, state: 'running' | 'done'): RibbonItem =>
    ({ kind: 'tool', id: `t-${name}`, toolUseId: `u-${name}`, name, target: '', summary: '', detail: '', state }) as RibbonItem

  test('ответ «нет» устаревает через 10 секунд, «есть» — нет', () => {
    expect(pathSettled({ target: null, at: 1000 }, 1000 + MISSING_TTL_MS - 1)).toBe(true)
    expect(pathSettled({ target: null, at: 1000 }, 1000 + MISSING_TTL_MS)).toBe(false)
    expect(pathSettled({ target: hit, at: 1000 }, 1000 + 10 * MISSING_TTL_MS)).toBe(true)
    expect(pathSettled(undefined, 0)).toBe(false)
  })

  test('результат Write, Edit, NotebookEdit или Bash стирает «нет» вкладки, «есть» остаются', () => {
    for (const name of ['Write', 'Edit', 'NotebookEdit', 'Bash']) {
      const id = `W-${name}`
      const store = useAppStore.getState()
      store.setPaths(id, [['src/a.ts', hit], ['src/b.ts', null]])
      store.applyRibbon(id, [{ kind: 'append', item: tool(name, 'running') }], 1)
      // Still running: nothing has been written yet.
      expect(useAppStore.getState().pathsByTab[id]!.has('src/b.ts')).toBe(true)
      store.applyRibbon(id, [{ kind: 'update', id: `t-${name}`, patch: { state: 'done' } as never }], 2)
      const known = useAppStore.getState().pathsByTab[id]!
      expect(known.has('src/b.ts')).toBe(false)
      expect(known.get('src/a.ts')?.target).toEqual(hit)
    }
  })

  test('чтение файла «нет» не стирает', () => {
    const store = useAppStore.getState()
    store.setPaths('R', [['src/b.ts', null]])
    store.applyRibbon('R', [{ kind: 'append', item: tool('Read', 'done') }], 1)
    expect(useAppStore.getState().pathsByTab['R']!.has('src/b.ts')).toBe(true)
  })
})

describe('useAppStore: команды', () => {
  test('недавние команды — до шести, свежая сверху, без повторов', () => {
    const store = useAppStore.getState()
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'b']) store.noteCommand(name)
    expect(useAppStore.getState().recentCommands).toEqual(['b', 'g', 'f', 'e', 'd', 'c'])
  })

  test('команды хранятся по вкладкам и уходят вместе с закрытой вкладкой', () => {
    const tab = (id: string): TabState => ({
      id,
      cwd: 'C:\p',
      title: id,
      overrides: {},
      status: 'idle',
      badge: false
    })
    const store = useAppStore.getState()
    store.setTabs([tab('A'), tab('B')])
    store.setCommands('A', [{ name: 'compact', description: '', argumentHint: '' }])
    store.setCommands('B', [{ name: 'clear', description: '', argumentHint: '' }])
    useAppStore.getState().setTabs([tab('A')])

    expect(useAppStore.getState().commandsByTab['A']?.[0]?.name).toBe('compact')
    expect(useAppStore.getState().commandsByTab['B']).toBeUndefined()
    // A late answer for the closed tab is dropped.
    useAppStore.getState().setCommands('B', [])
    expect(useAppStore.getState().commandsByTab['B']).toBeUndefined()
  })
})

describe('useAppStore: панели', () => {
  const t = (id: string): TabState => ({ id, cwd: 'C:\p', title: id, overrides: {}, status: 'idle', badge: false })

  test('focusPane делает панель активной и не меняет порядок', () => {
    const store = useAppStore.getState()
    store.setTabs([t('A'), t('B')])
    store.setPanes(['A', 'B'])
    store.focusPane('B')
    expect(useAppStore.getState().activeTabId).toBe('B')
    expect(useAppStore.getState().paneTabIds).toEqual(['A', 'B'])
  })

  test('setPanes убирает дубли и обрезает до 4', () => {
    const store = useAppStore.getState()
    store.setPanes(['A', 'B', 'A', 'C', 'D', 'E', 'F'])
    expect(MAX_PANES).toBe(4)
    expect(useAppStore.getState().paneTabIds).toEqual(['A', 'B', 'C', 'D'])
  })

  test('закрытая вкладка уходит из paneTabIds, активной становится соседняя', () => {
    const store = useAppStore.getState()
    store.setTabs([t('A'), t('B'), t('C')])
    store.setPanes(['A', 'B', 'C'])
    store.focusPane('B')
    store.setTabs([t('A'), t('C')])
    const state = useAppStore.getState()
    expect(state.paneTabIds).toEqual(['A', 'C'])
    expect(state.activeTabId).toBe('C')
  })

  test('setTabs без изменений в панелях (только статус) оставляет тот же массив', () => {
    const store = useAppStore.getState()
    store.setTabs([t('A'), t('B')])
    store.setPanes(['A', 'B'])
    const before = useAppStore.getState().paneTabIds
    store.setTabs([t('A'), { ...t('B'), status: 'busy' }])
    expect(useAppStore.getState().paneTabIds).toBe(before)
  })

  test('закрытая вкладка панели даёт новый массив', () => {
    const store = useAppStore.getState()
    store.setTabs([t('A'), t('B')])
    store.setPanes(['A', 'B'])
    const before = useAppStore.getState().paneTabIds
    store.setTabs([t('A')])
    const after = useAppStore.getState().paneTabIds
    expect(after).not.toBe(before)
    expect(after).toEqual(['A'])
  })
})

describe('useAppStore: раскладка из main и хвосты сплита', () => {
  const t = (id: string, status: TabState['status'] = 'idle'): TabState => ({
    id,
    cwd: '/p',
    title: id,
    overrides: {},
    status,
    badge: false
  })
  const layout = (over: Partial<LayoutState>): LayoutState => ({
    panes: [],
    active: null,
    paneWidths: [],
    sidebarCollapsed: false,
    projects: [],
    ...over
  })

  test('setActiveTabId чата вне панелей заменяет активный слот', () => {
    const store = useAppStore.getState()
    store.setTabs([t('a'), t('b'), t('c')])
    store.setPanes(['a', 'b'])
    store.focusPane('b')
    store.setActiveTabId('c')
    const state = useAppStore.getState()
    expect(state.paneTabIds).toEqual(['a', 'c'])
    expect(state.activeTabId).toBe('c')
  })

  test('активная вне полного ряда не выталкивает правую панель', () => {
    const store = useAppStore.getState()
    const all = ['a', 'b', 'c', 'd', 'e'].map((id) => t(id))
    store.setTabs(all)
    store.setPanes(['a', 'b', 'c', 'd'])
    store.focusPane('b')
    // The active chat is outside the full row (it came in by the layout).
    store.setLayout(layout({ panes: ['a', 'b', 'c', 'd'], active: 'e' }))
    const state = useAppStore.getState()
    expect(state.paneTabIds).toEqual(['a', 'e', 'c', 'd'])
    expect(state.activeTabId).toBe('e')
    // And a plain list change with that state keeps it.
    store.setTabs(all)
    expect(useAppStore.getState().paneTabIds).toEqual(['a', 'e', 'c', 'd'])
  })

  test('setTabs: активная вне полного ряда заменяет слот, а не выталкивает четвёртую', () => {
    const store = useAppStore.getState()
    const all = ['a', 'b', 'c', 'd', 'e'].map((id) => t(id))
    store.setTabs(all)
    store.setPanes(['a', 'b', 'c', 'd'])
    useAppStore.setState({ activeTabId: 'e' })
    store.setTabs(all)
    const state = useAppStore.getState()
    expect(state.paneTabIds).toHaveLength(4)
    expect(state.paneTabIds).toContain('e')
    expect(state.paneTabIds).toContain('d')
    expect(state.activeTabId).toBe('e')
  })

  test('setTabs без смены статусов оставляет busySinceByTab тем же объектом', () => {
    const store = useAppStore.getState()
    store.setTabs([t('a', 'busy'), t('b')])
    const before = useAppStore.getState().busySinceByTab
    store.setTabs([t('a', 'busy'), t('b')])
    expect(useAppStore.getState().busySinceByTab).toBe(before)
    store.setTabs([t('a'), t('b')])
    expect(useAppStore.getState().busySinceByTab).not.toBe(before)
  })

  test('nextPanes сообщает о смене активной', () => {
    expect(nextPanes({ paneTabIds: ['a', 'b'], activeTabId: 'b' }, ['a'])).toEqual({
      paneTabIds: ['a'],
      activeTabId: 'a',
      activate: 'a'
    })
    expect(nextPanes({ paneTabIds: ['a', 'b'], activeTabId: 'a' }, ['a']).activate).toBeUndefined()
  })

  test('layout пришёл раньше вкладок: после setTabs панели, активная и ширины применены', () => {
    const store = useAppStore.getState()
    store.setLayout(layout({ panes: ['a', 'b'], active: 'b', paneWidths: [0.3, 0.7] }))
    expect(useAppStore.getState().layout.panes).toEqual(['a', 'b'])
    expect(useAppStore.getState().paneTabIds).toEqual([])
    store.setTabs([t('a'), t('b'), t('c')])
    const state = useAppStore.getState()
    expect(state.paneTabIds).toEqual(['a', 'b'])
    expect(state.activeTabId).toBe('b')
    expect(state.paneWidths).toEqual([0.3, 0.7])
  })

  test('layout после вкладок применяется сразу, и следующий setTabs его не затирает', () => {
    const store = useAppStore.getState()
    store.setTabs([t('a'), t('b')])
    store.setLayout(layout({ panes: ['a', 'b'], active: 'a', paneWidths: [0.5, 0.5] }))
    expect(useAppStore.getState().paneTabIds).toEqual(['a', 'b'])
    store.setPanes(['a'])
    store.setTabs([t('a', 'busy'), t('b')])
    expect(useAppStore.getState().paneTabIds).toEqual(['a'])
  })

  test('setPaneWidths, и loadProjectHistory спрашивает одну папку один раз', async () => {
    const calls: string[] = []
    vi.stubGlobal('window', {
      qclod: {
        projectHistory: async (cwd: string) => {
          calls.push(cwd)
          return [{ id: 's', title: 'T', firstMessage: '', updatedAt: 1 }]
        }
      }
    })
    try {
      const store = useAppStore.getState()
      store.setPaneWidths([0.4, 0.6])
      expect(useAppStore.getState().paneWidths).toEqual([0.4, 0.6])
      store.loadProjectHistory('/home/u/Proj')
      expect(useAppStore.getState().historyByProject['/home/u/Proj']).toBe('loading')
      await vi.waitFor(() => expect(useAppStore.getState().historyByProject['/home/u/Proj']).not.toBe('loading'))
      store.loadProjectHistory('/home/u/Proj/')
      expect(calls).toEqual(['/home/u/Proj'])
      expect(useAppStore.getState().historyByProject['/home/u/Proj']).toEqual({
        items: [{ id: 's', title: 'T', firstMessage: '', updatedAt: 1 }]
      })
      store.loadProjectHistory('/home/u/Proj/', true)
      expect(calls).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('layout с новой активной, когда окно её уже знает, не добавляет вторую панель', () => {
    const store = useAppStore.getState()
    store.setTabs([t('a'), t('b')])
    store.setLayout(layout({ panes: ['a'], active: 'a' }))
    // The window heard of the activation first, then main's layout still names the old pane.
    store.setActiveTabId('b')
    store.setLayout(layout({ panes: ['a'], active: 'b' }))
    expect(useAppStore.getState().paneTabIds).toEqual(['b'])
    expect(useAppStore.getState().activeTabId).toBe('b')
  })

  test('новая вкладка: layout и активация раньше списка не дают второй панели', () => {
    const store = useAppStore.getState()
    store.setTabs([t('a')])
    store.setLayout(layout({ panes: ['a'], active: 'a' }))
    // Main's layout names a chat the list does not hold yet; the activation follows, then the list.
    store.setLayout(layout({ panes: ['a'], active: 'b' }))
    store.setActiveTabId('b')
    store.setTabs([t('a'), t('b')])
    expect(useAppStore.getState().paneTabIds).toEqual(['b'])
    expect(useAppStore.getState().activeTabId).toBe('b')
  })

  test('вкладки приходят частями: сохранённый сплит собирается, когда пришли все', () => {
    const store = useAppStore.getState()
    store.setLayout(layout({ panes: ['a', 'b', 'c'], active: 'a', paneWidths: [0.2, 0.3, 0.5] }))
    store.setTabs([t('a')])
    expect(useAppStore.getState().paneTabIds).toEqual(['a'])
    store.setTabs([t('a'), t('b')])
    expect(useAppStore.getState().paneTabIds).toEqual(['a', 'b'])
    store.setTabs([t('a'), t('b'), t('c')])
    const state = useAppStore.getState()
    expect(state.paneTabIds).toEqual(['a', 'b', 'c'])
    expect(state.paneWidths).toEqual([0.2, 0.3, 0.5])
    expect(state.activeTabId).toBe('a')
  })

  test('вкладки частями, но пользователь уже поменял панели: сохранённое их не затирает', () => {
    const store = useAppStore.getState()
    store.setLayout(layout({ panes: ['a', 'b'], active: 'a' }))
    store.setTabs([t('a'), t('c')])
    store.setPanes(['a', 'c'])
    store.setTabs([t('a'), t('b'), t('c')])
    expect(useAppStore.getState().paneTabIds).toEqual(['a', 'c'])
  })
})
