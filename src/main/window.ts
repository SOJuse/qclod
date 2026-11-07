import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    title: 'Qclod',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // External links open in the user's browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}
