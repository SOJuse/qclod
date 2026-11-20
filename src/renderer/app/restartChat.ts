import type { TabId } from '../../shared/types'
import { useAppStore } from '../state/useAppStore'

/**
 * «Начать заново»: a new session in the same chat. Its panel replaces the old
 * one's whole — the cost and limits are not this session's; the snapshot
 * outranks them. The old conversation is a past one now, so the project's
 * history is read again, as after closing a chat (S2-R18).
 */
export function restartChat(tabId: TabId): Promise<void> {
  const cwd = useAppStore.getState().tabs.find((t) => t.id === tabId)?.cwd
  return window.qclod
    .restartTab(tabId)
    .then(() => {
      if (cwd) useAppStore.getState().loadProjectHistory(cwd, true)
      return window.qclod.panel(tabId)
    })
    .then((snapshot) => useAppStore.getState().setPanelSnapshot(tabId, snapshot))
}
