import { app, BrowserWindow, ipcMain } from 'electron'
import { CHANNELS } from '../shared/channels'

/**
 * Handlers that exist before there are any sessions. Session, tab, settings and
 * file handlers register themselves from their own modules in later tasks.
 */
export function registerBaseIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(CHANNELS.appVersion, () => app.getVersion())

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
