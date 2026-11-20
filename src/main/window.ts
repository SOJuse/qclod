import { BrowserWindow, shell, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { join } from 'node:path'
import { WINDOW_BG } from '../shared/theme'
import { isSafeExternalUrl, makeNavigationGuard } from './security'
import type { ErrorEntry } from './system/errorLog'

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
      // e2e only: tells the preload to make the first pane throw.
      ...(__QCLOD_TEST_SEAMS__ && process.env['QCLOD_E2E_THROW_IN_PANE'] === '1'
        ? { additionalArguments: ['--QCLOD_E2E_THROW_IN_PANE'] }
        : {}),
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

const RELOAD_WINDOW_MS = 60_000
const MAX_RELOADS = 3

/**
 * A renderer that dies or hangs must not leave the window grey. A crash is
 * logged and the page reloaded, at most three times a minute so a page that
 * crashes on load cannot loop. A hang is logged and given `hangMs` to come
 * back before the renderer is killed; the reload then comes from the crash,
 * through `reloadAfterHang` if given: the page it loads is told why, so a
 * draft that froze it is not put straight back into the field (task 9b).
 */
export function watchRenderer(
  contents: Pick<WebContents, 'on' | 'reload' | 'forcefullyCrashRenderer'>,
  opts: { log: (e: ErrorEntry) => void; now?: () => number; hangMs?: number; reloadAfterHang?: () => void }
): void {
  const now = opts.now ?? Date.now
  const hangMs = opts.hangMs ?? 15_000
  let reloads: number[] = []
  let hangTimer: ReturnType<typeof setTimeout> | null = null
  /** Set while the crash we forced on a hung page is on its way. */
  let killedForHang = false

  const note = (message: string): void => opts.log({ source: 'main', scope: 'window', message, at: now() })
  const reload = (why: string, afterHang: boolean): void => {
    const t = now()
    reloads = reloads.filter((r) => t - r < RELOAD_WINDOW_MS)
    if (reloads.length >= MAX_RELOADS) {
      note(`${why}: not reloading, ${MAX_RELOADS} reloads in the last minute already`)
      return
    }
    reloads.push(t)
    if (afterHang && opts.reloadAfterHang) opts.reloadAfterHang()
    else contents.reload()
  }

  contents.on('render-process-gone', (_e, details) => {
    // A hang timer left armed would kill the page that is about to load.
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = null
    const afterHang = killedForHang
    killedForHang = false
    if (details.reason === 'clean-exit') return
    note(`render-process-gone: ${details.reason}`)
    reload('render-process-gone', afterHang)
  })

  contents.on('unresponsive', () => {
    note('renderer unresponsive')
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = setTimeout(() => {
      hangTimer = null
      note(`renderer still unresponsive after ${hangMs} ms: forcing a restart`)
      // The crash raises render-process-gone, which logs it and reloads once.
      killedForHang = true
      contents.forcefullyCrashRenderer()
    }, hangMs)
  })

  contents.on('responsive', () => {
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = null
  })
}
