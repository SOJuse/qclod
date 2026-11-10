import { beforeEach, describe, expect, test } from 'vitest'
import { EMPTY_PANEL, useAppStore } from '../../src/renderer/state/useAppStore'
import type { TabState } from '../../src/shared/types'

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
  }
  const keysOf = (id: string): string[] => {
    const s = useAppStore.getState()
    return [s.ribbonByTab, s.ribbonRevByTab, s.todoByTab, s.panelByTab, s.panelRevByTab, s.draftByTab, s.attachmentsByTab, s.fileIndexByTab, s.busySinceByTab]
      .map((m, i) => (id in m ? String(i) : ''))
      .filter(Boolean)
  }

  test('закрытая вкладка не оставляет ленту, панель, черновик и индекс файлов', () => {
    useAppStore.getState().setTabs([tab('A'), tab('B')])
    fill('A')
    fill('B')
    useAppStore.getState().setTabs([tab('A')])

    expect(keysOf('B')).toEqual([])
    expect(keysOf('A')).toHaveLength(8)
  })

  test('лента вкладки, ещё не пришедшей в списке, не стирается', () => {
    useAppStore.getState().setTabs([tab('A')])
    fill('C')
    useAppStore.getState().setTabs([tab('A')])

    expect(useAppStore.getState().ribbonByTab['C']).toBeDefined()
    expect(keysOf('C')).toHaveLength(8)
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

    expect(keysOf('B')).toEqual([])
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
