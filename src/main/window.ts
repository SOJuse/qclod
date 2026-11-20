import { BrowserWindow, shell, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import { join } from 'node:path'
import { WINDOW_BG } from '../shared/theme'
import { isSafeExternalUrl, makeNavigationGuard } from './security'
import type { ErrorEntry } from './system/errorLog'
import type { FallbackReason } from '../shared/fallbackReason'

export const RENDERER_ENTRY = join(__dirname, '../renderer/index.html')
/** The static page for a window that will not start: no React, no renderer bundle (fallback.html). */
export const FALLBACK_ENTRY = join(__dirname, '../renderer/fallback.html')

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
    [RENDERER_ENTRY, FALLBACK_ENTRY]
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
 * crashes on load cannot loop; the fourth ends in `onGiveUp` (the static page
 * with a way out), as does a main page that fails to load at all. `onGiveUp`
 * is called once until `reset()` (the page's «Попробовать снова»), so a crash
 * of that page itself cannot loop either. A hang is logged and given `hangMs`
 * to come back before the renderer is killed; the reload then comes from the
 * crash, through `reloadAfterHang` if given: the page it loads is told why, so
 * a draft that froze it is not put straight back into the field (task 9b).
 */
export function watchRenderer(
  contents: Pick<WebContents, 'on' | 'reload' | 'forcefullyCrashRenderer'>,
  opts: {
    log: (e: ErrorEntry) => void
    now?: () => number
    hangMs?: number
    reloadAfterHang?: () => void
    onGiveUp?: (reason: FallbackReason) => void
  }
): { reset(): void } {
  const now = opts.now ?? Date.now
  const hangMs = opts.hangMs ?? 15_000
  let reloads: number[] = []
  let hangTimer: ReturnType<typeof setTimeout> | null = null
  /** Set while the crash we forced on a hung page is on its way. */
  let killedForHang = false
  let gaveUp = false

  const note = (message: string): void => opts.log({ source: 'main', scope: 'window', message, at: now() })
  const giveUp = (reason: FallbackReason): void => {
    if (gaveUp) return
    gaveUp = true
    opts.onGiveUp?.(reason)
  }
  const disarmHang = (): void => {
    if (hangTimer) clearTimeout(hangTimer)
    hangTimer = null
  }
  const reload = (why: string, afterHang: boolean): void => {
    const t = now()
    reloads = reloads.filter((r) => t - r < RELOAD_WINDOW_MS)
    if (reloads.length >= MAX_RELOADS) {
      note(`${why}: not reloading, ${MAX_RELOADS} reloads in the last minute already; giving up`)
      giveUp('crashes')
      return
    }
    reloads.push(t)
    if (afterHang && opts.reloadAfterHang) opts.reloadAfterHang()
    else contents.reload()
  }

  contents.on('render-process-gone', (_e, details) => {
    // A hang timer left armed would kill the page that is about to load.
    disarmHang()
    const afterHang = killedForHang
    killedForHang = false
    if (details.reason === 'clean-exit') return
    note(`render-process-gone: ${details.reason}`)
    reload('render-process-gone', afterHang)
  })

  // The main page did not load at all (a missing file, a refused connection).
  // -3 is a navigation another one cut short, which is not a failure.
  contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    note(`did-fail-load: ${description} (${code}) ${url}; giving up`)
    giveUp('load')
  })

  contents.on('unresponsive', () => {
    note('renderer unresponsive')
    disarmHang()
    hangTimer = setTimeout(() => {
      hangTimer = null
      note(`renderer still unresponsive after ${hangMs} ms: forcing a restart`)
      // The crash raises render-process-gone, which logs it and reloads once.
      killedForHang = true
      contents.forcefullyCrashRenderer()
    }, hangMs)
  })

  contents.on('responsive', disarmHang)

  // A window that is gone has nothing left to kill.
  contents.on('destroyed', disarmHang)

  return {
    reset(): void {
      reloads = []
      gaveUp = false
    }
  }
}

/**
 * How long the page gets to show its first screen. A cold start of the
 * installed app, on a slow disk with a scanner looking at every file, takes a
 * few seconds; the hang watchdog above already allows a page 15 s. A bundle
 * that failed to load (a module error, a script that could not be fetched)
 * never reaches `createRoot`, so neither a crash nor a load failure is
 * raised and the boot screen of index.html would stay for ever.
 */
export const MOUNT_MS = 15_000

/** True while index.html's boot screen is still the only thing in the window. */
const BOOT_STILL_SHOWN = `document.querySelector('[data-testid="boot"]') !== null`

/**
 * Restarts a wait on every top-level navigation and, when it ends with the
 * boot screen still up, logs and gives up. The fallback page has no boot
 * screen, so loading it ends the watch by itself. A page that cannot even be
 * asked counts as one that did not start.
 */
export function watchMount(
  contents: Pick<WebContents, 'on' | 'executeJavaScript'>,
  opts: { log: (e: ErrorEntry) => void; ms?: number; onGiveUp: (reason: FallbackReason) => void }
): void {
  const ms = opts.ms ?? MOUNT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const disarm = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const stuck = (): void => {
    opts.log({
      source: 'main',
      scope: 'window',
      message: `the window did not mount within ${ms} ms; giving up`,
      at: Date.now()
    })
    opts.onGiveUp('mount')
  }

  contents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return
    disarm()
    timer = setTimeout(() => {
      timer = null
      contents.executeJavaScript(BOOT_STILL_SHOWN).then(
        (shown) => {
          if (shown === true) stuck()
        },
        () => stuck()
      )
    }, ms)
  })
  contents.on('destroyed', disarm)
}
