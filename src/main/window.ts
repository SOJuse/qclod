import { BrowserWindow, shell, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { join } from 'node:path'
import { WINDOW_BG } from '../shared/theme'
import { isSafeExternalUrl, makeNavigationGuard } from './security'

export const RENDERER_ENTRY = join(__dirname, '../renderer/index.html')

/**
 * e2e only: the window is real but lives off every screen, out of the taskbar,
 * and never takes the keyboard, so the suite can run while someone uses the
 * machine. Playwright drives it over CDP, which needs no OS focus. A release
 * build has no such branch (buildFlags.d.ts).
 */
export const offScreen = __QCLOD_TEST_SEAMS__ && process.env['QCLOD_E2E_INVISIBLE'] === '1'

export function mainWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: WINDOW_BG,
    title: 'Qclod',
    // Far past any monitor, and shown without being activated.
    ...(offScreen ? { x: -20000, y: -20000, skipTaskbar: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Off screen the page would count as hidden and stall its timers.
      ...(offScreen ? { backgroundThrottling: false } : {})
    }
  }
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow(mainWindowOptions())

  // Navigation hardening is registered app-wide via `web-contents-created`,
  // so every webContents gets it, not just this window.
  win.once('ready-to-show', () => (offScreen ? win.showInactive() : win.show()))

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
