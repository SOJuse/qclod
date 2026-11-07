import { BrowserWindow, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { isSafeExternalUrl, makeNavigationGuard } from './security'

export const RENDERER_ENTRY = join(__dirname, '../renderer/index.html')

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

  // Navigation hardening is registered app-wide via `web-contents-created`,
  // so every webContents gets it, not just this window.
  win.once('ready-to-show', () => win.show())

  return win
}

export function hardenWebContents(contents: WebContents): void {
  const mayNavigateTo = makeNavigationGuard(
    process.env['ELECTRON_RENDERER_URL'],
    RENDERER_ENTRY
  )

  // External links open in the user's browser — and only if they are plain web
  // URLs. Anything else (file:, javascript:, a registered protocol handler)
  // is dropped rather than handed to the OS.
  contents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Every way a navigation can start, gated by the same predicate. Fail closed.
  const gate = (e: Electron.Event, url: string): void => {
    if (!mayNavigateTo(url)) e.preventDefault()
  }
  contents.on('will-navigate', gate)
  contents.on('will-redirect', gate)
  contents.on('will-frame-navigate', (e) => gate(e, e.url))

  contents.on('will-attach-webview', (e) => {
    e.preventDefault()
  })
}
