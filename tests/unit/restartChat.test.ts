import { beforeEach, expect, test, vi } from 'vitest'
import { restartChat } from '../../src/renderer/app/restartChat'
import { EMPTY_PANEL, useAppStore } from '../../src/renderer/state/useAppStore'
import type { TabState } from '../../src/shared/types'

const initial = useAppStore.getState()
beforeEach(() => useAppStore.setState(initial, true))

const tab: TabState = { id: 'a', cwd: 'C:\\P', title: 'a', overrides: {}, status: 'idle', badge: false }

test('«Начать заново» перечитывает историю проекта, как закрытие чата, и берёт панель новой сессии', async () => {
  const reads: string[] = []
  const order: string[] = []
  vi.stubGlobal('window', {
    qclod: {
      restartTab: async () => void order.push('restart'),
      panel: async () => {
        order.push('panel')
        return { rev: 7, data: { ...EMPTY_PANEL, model: 'новая' } }
      },
      projectHistory: async (cwd: string) => {
        reads.push(cwd)
        order.push('history')
        return []
      }
    }
  })
  try {
    useAppStore.getState().setTabs([tab])
    // Read once already: only a forced read asks again.
    useAppStore.getState().loadProjectHistory('C:\\P')
    await vi.waitFor(() => expect(useAppStore.getState().historyByProject['c:\\p']).toEqual({ items: [] }))
    order.length = 0

    await restartChat('a')
    await vi.waitFor(() => expect(reads).toEqual(['C:\\P', 'C:\\P']))
    // Asked for once the new session is there, not before.
    expect(order.indexOf('restart')).toBe(0)
    expect(useAppStore.getState().panelByTab['a']?.model).toBe('новая')
  } finally {
    vi.unstubAllGlobals()
  }
})
