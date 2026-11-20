import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { create } from 'zustand'
import { startLayoutSync } from '../../src/renderer/state/layoutSync'
import { DEFAULT_LAYOUT, type LayoutState } from '../../src/shared/types'

interface S {
  layout: LayoutState
  tabs: { id: string }[]
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
    tabs: ['a', 'b', 'c', 'x', 'q'].map((id) => ({ id })),
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

  test('onLayoutChanged обновляет store.layout', async () => {
    const { store, push } = setup()
    await vi.advanceTimersByTimeAsync(0)
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

  test('вкладки раньше раскладки: сохранённый сплит применён, обратно ничего не пишется', async () => {
    const store = fakeStore()
    store.setState({ tabs: [{ id: 'a' }], paneTabIds: ['a'] })
    let answer: (l: LayoutState) => void = () => undefined
    const api = {
      getLayout: vi.fn(() => new Promise<LayoutState>((r) => (answer = r))),
      setLayout: vi.fn(async () => empty()),
      onLayoutChanged: vi.fn(() => () => undefined)
    }
    startLayoutSync(store as never, api as never, 300)
    await vi.advanceTimersByTimeAsync(500)
    expect(api.setLayout).not.toHaveBeenCalled()
    store.setState({ tabs: ['a', 'b'].map((id) => ({ id })) })
    answer(empty({ panes: ['a', 'b'], paneWidths: [0.3, 0.7], active: 'a' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.getState().paneTabIds).toEqual(['a', 'b'])
    expect(api.setLayout).not.toHaveBeenCalled()
  })

  test('сплит приходит частями: недостающие id не пишутся обратно', async () => {
    const store = fakeStore()
    store.setState({ tabs: [{ id: 'a' }] })
    const api = {
      getLayout: vi.fn(async () => empty({ panes: ['a', 'b'], paneWidths: [0.5, 0.5], active: 'a' })),
      setLayout: vi.fn(async () => empty()),
      onLayoutChanged: vi.fn(() => () => undefined)
    }
    startLayoutSync(store as never, api as never, 300)
    await vi.advanceTimersByTimeAsync(0)
    // The window holds only what the first list let through.
    store.setState({ paneTabIds: ['a'], paneWidths: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.setLayout).not.toHaveBeenCalled()
    store.setState({ tabs: ['a', 'b'].map((id) => ({ id })), paneTabIds: ['a', 'b'], paneWidths: [0.5, 0.5] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.setLayout).not.toHaveBeenCalled()
  })

  test('в сохранённых панелях мёртвый id: ширины, поменянные мышью, всё равно пишутся', async () => {
    const store = fakeStore()
    const api = {
      getLayout: vi.fn(async () =>
        empty({ panes: ['a', 'b', 'dead'], paneWidths: [0.3, 0.3, 0.4], active: 'a' })
      ),
      setLayout: vi.fn(async () => empty()),
      onLayoutChanged: vi.fn(() => () => undefined)
    }
    startLayoutSync(store as never, api as never, 300)
    await vi.advanceTimersByTimeAsync(0)
    // The window shows what is alive; equal shares until the person moves a splitter.
    store.setState({ paneTabIds: ['a', 'b'], paneWidths: [] })
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.setLayout).not.toHaveBeenCalled()
    store.setState({ paneWidths: [0.35, 0.65] })
    await vi.advanceTimersByTimeAsync(400)
    expect(api.setLayout).toHaveBeenCalledTimes(1)
    expect(api.setLayout).toHaveBeenCalledWith({ panes: ['a', 'b'], paneWidths: [0.35, 0.65] })
  })

  test('отказ записи: окно сверяется с main и берёт его панели', async () => {
    const { store, api, push } = setup()
    await vi.advanceTimersByTimeAsync(0)
    push(empty({ panes: ['a'], active: 'a', paneWidths: [1] }))
    api.setLayout.mockRejectedValueOnce(new Error('ipc'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    store.setState({ paneTabIds: ['a', 'b'], paneWidths: [0.5, 0.5] })
    await vi.advanceTimersByTimeAsync(400)
    expect(api.setLayout).toHaveBeenCalledTimes(1)
    expect(store.getState().paneTabIds).toEqual(['a'])
    warn.mockRestore()
  })

  test('отказ записи, но пользователь успел поменять панели: запись взводится снова', async () => {
    const { store, api, push } = setup()
    await vi.advanceTimersByTimeAsync(0)
    push(empty({ panes: ['a'], active: 'a', paneWidths: [1] }))
    let fail: (e: Error) => void = () => undefined
    api.setLayout.mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    store.setState({ paneTabIds: ['a', 'b'], paneWidths: [0.5, 0.5] })
    await vi.advanceTimersByTimeAsync(400)
    store.setState({ paneTabIds: ['a', 'b', 'c'], paneWidths: [0.2, 0.3, 0.5] })
    fail(new Error('ipc'))
    await vi.advanceTimersByTimeAsync(400)
    expect(api.setLayout).toHaveBeenCalledTimes(2)
    expect(api.setLayout).toHaveBeenLastCalledWith({ panes: ['a', 'b', 'c'], paneWidths: [0.2, 0.3, 0.5] })
    warn.mockRestore()
  })
})
