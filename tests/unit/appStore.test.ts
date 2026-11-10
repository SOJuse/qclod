import { beforeEach, describe, expect, test } from 'vitest'
import { EMPTY_PANEL, useAppStore } from '../../src/renderer/state/useAppStore'

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
