import { app, BrowserWindow, ipcMain } from 'electron'
import { CHANNELS } from '../shared/channels'
import type { AppSettings } from '../shared/types'

export interface BaseIpcDeps {
  getWindow: () => BrowserWindow | null
  getSettings: () => AppSettings
  setSettings: (patch: Partial<AppSettings>) => AppSettings
}

/**
 * Handlers that exist before there are any sessions. Session, tab and file
 * handlers register themselves from their own modules.
 */
export function registerBaseIpc(deps: BaseIpcDeps): void {
  const { getWindow } = deps

  ipcMain.handle(CHANNELS.appVersion, () => app.getVersion())
  ipcMain.handle(CHANNELS.settingsGet, () => deps.getSettings())
  ipcMain.handle(CHANNELS.settingsSet, (_e, patch: Partial<AppSettings>) => {
    const next = deps.setSettings(patch)
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.settingsChanged, next)
    return next
  })

  ipcMain.handle(CHANNELS.windowMinimize, () => {
    getWindow()?.minimize()
  })

  ipcMain.handle(CHANNELS.windowMaximize, () => {
    const win = getWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle(CHANNELS.windowClose, () => {
    getWindow()?.close()
  })
}
