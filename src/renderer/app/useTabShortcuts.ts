import { useEffect } from 'react'
import type { TabId, TabState } from '../../shared/types'

export interface TabShortcutActions {
  tabs: TabState[]
  activeTabId: TabId
  onCreate: () => void
  onClose: (id: TabId) => void
  onActivate: (id: TabId) => void
}

/**
 * Window-level tab shortcuts. They are deliberately handled in the capture
 * phase: the composer and the terminal both swallow keys, and Ctrl+T must work
 * no matter which of them has focus.
 */
export function useTabShortcuts({
  tabs,
  activeTabId,
  onCreate,
  onClose,
  onActivate
}: TabShortcutActions): void {
  useEffect(() => {
    const handler = (ev: KeyboardEvent): void => {
      if (!ev.ctrlKey || ev.altKey || ev.metaKey) return

      if (ev.key.toLowerCase() === 't' && !ev.shiftKey) {
        ev.preventDefault()
        onCreate()
        return
      }
      if (ev.key.toLowerCase() === 'w' && !ev.shiftKey) {
        ev.preventDefault()
        onClose(activeTabId)
        return
      }
      if (ev.key === 'Tab') {
        ev.preventDefault()
        if (tabs.length < 2) return
        const index = tabs.findIndex((tab) => tab.id === activeTabId)
        const step = ev.shiftKey ? -1 : 1
        const next = (index + step + tabs.length) % tabs.length
        onActivate(tabs[next].id)
        return
      }
      if (/^[1-9]$/.test(ev.key) && !ev.shiftKey) {
        const target = tabs[Number(ev.key) - 1]
        if (!target) return
        ev.preventDefault()
        onActivate(target.id)
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [activeTabId, onActivate, onClose, onCreate, tabs])
}
