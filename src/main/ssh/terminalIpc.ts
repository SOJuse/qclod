import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/channels'
import type { TabId } from '../../shared/types'
import { sanitizeTerminalId, sanitizeTerminalInput } from '../tabs/sanitize'
import { termSize, type TerminalHub } from './terminal'

export interface TerminalIpcDeps {
  hub: Pick<TerminalHub, 'input' | 'resize' | 'close' | 'attach'>
  /** A terminal on the tab's server in the tab's folder; null when the tab has none. */
  open: (tabId: TabId, size: { cols: number; rows: number }) => Promise<string | null>
}

/**
 * The server terminal's channels (stage 6, task 26). Everything from the
 * window is checked here: a tab id, a size within 2…500 × 2…200, a terminal id
 * the hub handed out, at most 64 KiB of keys at once. Anything else is nothing.
 */
export function registerTerminalIpc(deps: TerminalIpcDeps): void {
  ipcMain.handle(CHANNELS.terminalOpen, async (_e, tabId: unknown, cols: unknown, rows: unknown) => {
    const size = termSize(cols, rows)
    if (typeof tabId !== 'string' || tabId === '' || tabId.length > 200 || !size) return null
    return deps.open(tabId, size)
  })
  // R1: a drawer back on screen takes up its terminal again, with what it printed meanwhile.
  ipcMain.handle(CHANNELS.terminalAttach, (_e, tabId: unknown, termId: unknown) => {
    const id = sanitizeTerminalId(termId)
    if (typeof tabId !== 'string' || tabId === '' || tabId.length > 200 || !id) return null
    return deps.hub.attach(tabId, id)
  })
  ipcMain.handle(CHANNELS.terminalResize, (_e, termId: unknown, cols: unknown, rows: unknown) => {
    const id = sanitizeTerminalId(termId)
    if (!id || typeof cols !== 'number' || typeof rows !== 'number') return
    deps.hub.resize(id, cols, rows)
  })
  ipcMain.handle(CHANNELS.terminalClose, (_e, termId: unknown) => {
    const id = sanitizeTerminalId(termId)
    if (id) deps.hub.close(id)
  })
  ipcMain.on(CHANNELS.terminalInput, (_e, termId: unknown, data: unknown) => {
    const id = sanitizeTerminalId(termId)
    const keys = sanitizeTerminalInput(data)
    if (id && keys !== null) deps.hub.input(id, keys)
  })
}
