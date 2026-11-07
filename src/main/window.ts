import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { isSafeExternalUrl } from './security'

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
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())
  hardenWebContents(win)

  return win
}

function hardenWebContents(win: BrowserWindow): void {
  // External links open in the user's browser — and only if they are plain web
  // URLs. Anything else (file:, javascript:, a registered protocol handler)
  // is dropped rather than handed to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The window must only ever show our own renderer. Fail closed.
  win.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    const allowed = devServer ? url.startsWith(devServer) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
