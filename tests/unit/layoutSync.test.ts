import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { create } from 'zustand'
import { startLayoutSync } from '../../src/renderer/state/layoutSync'
import { DEFAULT_LAYOUT, type LayoutState } from '../../src/shared/types'

interface S {
  layout: LayoutState
  paneTabIds: string[]
  paneWidths: number[]
  setLayout(l: LayoutState): void
}

const empty = (over: Partial<LayoutState> = {}): LayoutState => ({
  ...DEFAULT_LAYOUT,
  panes: [],
  paneWidths: [],
  projects: [],
  ...over
})

function fakeStore() {
  return create<S>((set) => ({
    layout: empty(),
    paneTabIds: [],
    paneWidths: [],
    setLayout: (layout) => set({ layout, paneTabIds: layout.panes, paneWidths: layout.paneWidths })
  }))
}

describe('startLayoutSync', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const store = fakeStore()
    let push: (l: LayoutState) => void = () => undefined
    const api = {
      getLayout: vi.fn(async () => empty()),
      setLayout: vi.fn(async () => store.getState().layout),
      onLayoutChanged: vi.fn((cb: (l: LayoutState) => void) => {
        push = cb
        return () => undefined
      })
    }
    const stop = startLayoutSync(store as never, api as never, 300)
    return { store, api, stop, push: (l: LayoutState) => push(l) }
  }

  test('три смены panes за 100 мс — один setLayout с последними панелями и ширинами', async () => {
    const { store, api } = setup()
    await vi.advanceTimersByTimeAsync(0)
    store.setState({ paneTabIds: ['a'] })
    await vi.advanceTimersByTimeAsync(40)
    store.setState({ paneTabIds: ['a', 'b'], paneWidths: [0.4, 0.6] })
    await vi.advanceTimersByTimeAsync(40)
    store.setState({ paneTabIds: ['a', 'b', 'c'], paneWidths: [0.2, 0.3, 0.5] })
    await vi.advanceTimersByTimeAsync(20)
    expect(api.setLayout).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(api.setLayout).toHaveBeenCalledTimes(1)
    expect(api.setLayout).toHaveBeenCalledWith({ panes: ['a', 'b', 'c'], paneWidths: [0.2, 0.3, 0.5] })
  })

  test('onLayoutChanged обновляет store.layout', () => {
    const { store, push } = setup()
    push(empty({ panes: ['x'], active: 'x', paneWidths: [1], projects: [{ cwd: 'C:\\p', collapsed: false }] }))
    expect(store.getState().layout.projects).toHaveLength(1)
    expect(store.getState().paneTabIds).toEqual(['x'])
  })

  test('события от своей же записи не зацикливают запись', async () => {
    const { store, api, push } = setup()
    await vi.advanceTimersByTimeAsync(0)
    store.setState({ paneTabIds: ['a', 'b'], paneWidths: [0.5, 0.5] })
    await vi.advanceTimersByTimeAsync(400)
    expect(api.setLayout).toHaveBeenCalledTimes(1)
    push(empty({ panes: ['a', 'b'], paneWidths: [0.5, 0.5] }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.setLayout).toHaveBeenCalledTimes(1)
  })

  test('первый ответ getLayout кладётся в store и не пишется обратно', async () => {
    const store = fakeStore()
    const api = {
      getLayout: vi.fn(async () => empty({ panes: ['q'], paneWidths: [1], active: 'q' })),
      setLayout: vi.fn(async () => empty()),
      onLayoutChanged: vi.fn(() => () => undefined)
    }
    startLayoutSync(store as never, api as never, 300)
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.getState().paneTabIds).toEqual(['q'])
    expect(api.setLayout).not.toHaveBeenCalled()
  })

  test('stop снимает подписки и таймер', async () => {
    const { store, api, stop } = setup()
    store.setState({ paneTabIds: ['a'] })
    stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.setLayout).not.toHaveBeenCalled()
  })

  test('событие main, пока своя запись ждёт, не стирает локальные панели', async () => {
    const { store, api, push } = setup()
    await vi.advanceTimersByTimeAsync(0)
    store.setState({ paneTabIds: ['a', 'b'], paneWidths: [] })
    // Main reports an activation, still with the old panes.
    push(empty({ panes: ['a'], active: 'b' }))
    expect(store.getState().paneTabIds).toEqual(['a', 'b'])
    expect(store.getState().layout.active).toBe('b')
    await vi.advanceTimersByTimeAsync(400)
    expect(api.setLayout).toHaveBeenCalledTimes(1)
    expect(api.setLayout).toHaveBeenCalledWith({ panes: ['a', 'b'], paneWidths: [] })
  })
})
