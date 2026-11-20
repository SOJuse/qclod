import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import { openAndPlace, whenTabKnown } from '../../src/renderer/app/dropSession'
import { dropOnPane } from '../../src/renderer/app/paneOps'
import type { TabState } from '../../src/shared/types'

const t = (id: string): TabState => ({ id, cwd: '/p', title: id, overrides: {}, status: 'idle', badge: false })

const initial = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState(initial, true)
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

/** What App does with a dropped chat: into the row as it was at the drop, and active. */
function placer(before: string[], index: number, where: 'before' | 'after' | 'replace') {
  return vi.fn((id: string) => {
    const store = useAppStore.getState()
    store.setPanes(dropOnPane(before, id, index, where))
    store.focusPane(id)
  })
}

describe('прошлая сессия, брошенная в ряд, встаёт туда, куда бросили', () => {
  test('список вкладок раньше ответа: ставится сразу', async () => {
    const store = useAppStore.getState()
    store.setTabs([t('a'), t('b')])
    store.setPanes(['a'])
    const before = useAppStore.getState().paneTabIds
    const place = placer(before, 0, 'after')
    const result = openAndPlace({
      store: useAppStore,
      open: async () => {
        // Main pushes the list with the new chat before it answers.
        useAppStore.getState().setTabs([t('a'), t('b'), t('n')])
        return t('n')
      },
      place
    })
    await expect(result).resolves.toBe('placed')
    expect(useAppStore.getState().paneTabIds).toEqual(['a', 'n'])
    expect(useAppStore.getState().activeTabId).toBe('n')
  })

  test('ответ раньше списка: ждёт, пока чат появится в списке, и не теряется от старого списка', async () => {
    const store = useAppStore.getState()
    store.setTabs([t('a'), t('b')])
    store.setPanes(['a'])
    const before = useAppStore.getState().paneTabIds
    const place = placer(before, 0, 'after')
    const result = openAndPlace({ store: useAppStore, open: async () => t('n'), place })
    await vi.advanceTimersByTimeAsync(0)
    // Not placed yet: the chat is not in the list.
    expect(place).not.toHaveBeenCalled()
    // A list sent before the opening (a status change) still lacks it; then the one with it.
    useAppStore.getState().setTabs([t('a'), { ...t('b'), status: 'busy' }])
    await vi.advanceTimersByTimeAsync(10)
    expect(place).not.toHaveBeenCalled()
    useAppStore.getState().setTabs([t('a'), { ...t('b'), status: 'busy' }, t('n')])
    await expect(result).resolves.toBe('placed')
    expect(place).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().paneTabIds).toEqual(['a', 'n'])
    expect(useAppStore.getState().activeTabId).toBe('n')
  })

  test('чат так и не появился — в ряд ничего не ставится', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    useAppStore.getState().setTabs([t('a')])
    const place = vi.fn()
    const result = openAndPlace({ store: useAppStore, open: async () => t('n'), place, waitMs: 1000 })
    await vi.advanceTimersByTimeAsync(1001)
    await expect(result).resolves.toBe('lost')
    expect(place).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('открытие упало — без необработанного отказа, причина в журнале', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const place = vi.fn()
    const result = openAndPlace({
      store: useAppStore,
      open: () => Promise.reject(new Error('нет такой сессии')),
      place
    })
    await expect(result).resolves.toBe('failed')
    expect(place).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.join(' '))).toContain('нет такой сессии')
    warn.mockRestore()
  })

  test('main ничего не открыл — ничего', async () => {
    await expect(openAndPlace({ store: useAppStore, open: async () => null, place: vi.fn() })).resolves.toBe('none')
  })

  test('whenTabKnown снимает подписку и по приходу, и по пределу', async () => {
    const unsub = vi.fn()
    let listener: (s: { tabs: TabState[] }) => void = () => undefined
    const fake = {
      getState: () => ({ tabs: [] as TabState[] }),
      subscribe: (l: (s: { tabs: TabState[] }) => void) => {
        listener = l
        return unsub
      }
    }
    const late = whenTabKnown(fake, 'x', 500)
    await vi.advanceTimersByTimeAsync(501)
    await expect(late).resolves.toBe(false)
    expect(unsub).toHaveBeenCalledTimes(1)
    const soon = whenTabKnown(fake, 'x', 500)
    listener({ tabs: [t('x')] })
    await expect(soon).resolves.toBe(true)
    expect(unsub).toHaveBeenCalledTimes(2)
  })
})
