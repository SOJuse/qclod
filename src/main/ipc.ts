import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { checkEnvironment } from './setup/environment'
import { locateAgent } from './setup/findAgent'
import { LoginWatch, openLoginWindow, readAuthStatus } from './setup/auth'
import { detectInstallMethods, installWithFallback, InstallSlot } from './setup/install'
import { fakeInstaller, type FakeInstallConfig } from './setup/fakeInstall'
import { CHANNELS } from '../shared/channels'
import { offScreen } from './window'
import { withFault } from './testSeams/ipcFaults'
import type { AppSettings, AuthStatus } from '../shared/types'

export interface BaseIpcDeps {
  getWindow: () => BrowserWindow | null
  getSettings: () => AppSettings
  setSettings: (patch: Partial<AppSettings>) => AppSettings
  /** Called once the login watch sees the agent logged in. */
  onLoggedIn?: () => void
}

/** QCLOD_FAKE_AUTH: scripted answers of `claude auth status` (e2e only). */
interface FakeAuthConfig {
  sequence: AuthStatus[]
  pollMs?: number
  maxMs?: number
}

/**
 * Handlers that exist before there are any sessions. Session, tab and file
 * handlers register themselves from their own modules.
 */
export function registerBaseIpc(deps: BaseIpcDeps): void {
  const { getWindow } = deps
  /** The install running right now, if any — only one at a time. */
  const install = new InstallSlot()

  ipcMain.handle(CHANNELS.appVersion, () => app.getVersion())
  ipcMain.handle(CHANNELS.settingsGet, () => withFault(CHANNELS.settingsGet, () => deps.getSettings()))
  ipcMain.handle(CHANNELS.settingsSet, (_e, patch: Partial<AppSettings>) =>
    withFault(CHANNELS.settingsSet, () => {
      const next = deps.setSettings(patch)
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.settingsChanged, next)
      return next
    })
  )

  // ---------------------------------------------------------------- setup

  // Test seam: a scripted installer that spawns nothing (see fakeInstall.ts).
  const fakeInstallJson = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_INSTALL'] : undefined
  const fake = fakeInstallJson ? fakeInstaller(JSON.parse(fakeInstallJson) as FakeInstallConfig) : null

  // Test seam: scripted `claude auth status` answers, and no login window.
  // Every check — the environment's and the login watch's — takes the next
  // answer from one shared sequence; the last one repeats.
  const fakeAuthJson = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_AUTH'] : undefined
  const fakeAuth = fakeAuthJson ? (JSON.parse(fakeAuthJson) as FakeAuthConfig) : null
  let fakeAuthStep = 0
  const fakeAuthStatus = async (): Promise<AuthStatus> => {
    const sequence = fakeAuth?.sequence ?? []
    return sequence[Math.min(fakeAuthStep++, sequence.length - 1)] ?? 'unknown'
  }

  ipcMain.handle(CHANNELS.setupCheck, () =>
    withFault(CHANNELS.setupCheck, () =>
      checkEnvironment(deps.getSettings().agentPath, {
        ...(fake ? { detect: fake.detect } : {}),
        ...(fakeAuth ? { authStatus: fakeAuthStatus } : {})
      })
    )
  )

  /** The agent the login window was opened for; the watch asks about it. */
  let loginAgent = ''
  const login = new LoginWatch({
    check: () => (fakeAuth ? fakeAuthStatus() : readAuthStatus(loginAgent)),
    onProgress: (progress) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.setupLoginProgress, progress)
      if (progress === 'in') deps.onLoggedIn?.()
    },
    ...(fakeAuth?.pollMs !== undefined ? { intervalMs: fakeAuth.pollMs } : {}),
    ...(fakeAuth?.maxMs !== undefined ? { maxMs: fakeAuth.maxMs } : {})
  })

  // Logging in is `claude auth login` in a console window of its own; Qclod
  // watches `claude auth status` and notices success by itself. The command
  // is ours, never the renderer's. Without an agent nothing opens and the
  // invoke rejects with the reason.
  ipcMain.handle(CHANNELS.setupLogin, () => {
    const agent = locateAgent(deps.getSettings().agentPath, process.env)
    loginAgent = agent
    if (fakeAuth) {
      const g = globalThis as { __qclodLoginOpens?: string[] }
      ;(g.__qclodLoginOpens ??= []).push(agent)
    } else {
      openLoginWindow(agent)
    }
    login.start()
  })

  ipcMain.handle(CHANNELS.setupInstall, async () => {
    const win = getWindow()
    const say = (line: string): void => {
      if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.setupOutput, line)
    }

    const running = install.start(async (done) => {
      // Inside begin, so two quick clicks cannot both get past the detection.
      const methods = await (fake ? fake.detectMethods() : detectInstallMethods())
      return installWithFallback(methods, say, done, fake?.start)
    })
    if (!running) {
      say('Установка уже идёт.')
      return false
    }
    return running
  })

  ipcMain.handle(CHANNELS.setupCancel, () => {
    install.cancel()
  })

  // Off screen (e2e) the window stays where it is: a maximize would put it on
  // the monitor.
  ipcMain.handle(CHANNELS.windowMinimize, () => {
    if (offScreen) return
    getWindow()?.minimize()
  })

  ipcMain.handle(CHANNELS.windowMaximize, () => {
    const win = getWindow()
    if (!win || offScreen) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  // A link in an answer opens in the browser. The window itself must never
  // navigate: it is the app, and a page loaded into it would run beside the
  // preload bridge.
  ipcMain.handle(CHANNELS.openExternal, async (_e, url: unknown) => {
    if (typeof url !== 'string') return
    if (!/^https?:\/\//i.test(url)) return
    await shell.openExternal(url)
  })

  ipcMain.handle(CHANNELS.windowClose, () => {
    getWindow()?.close()
  })

  // The app menu is gone, and with it Electron's zoom and reload keys.
  ipcMain.handle(CHANNELS.windowZoom, (_e, step: unknown) => {
    const contents = getWindow()?.webContents
    if (!contents || (step !== 'in' && step !== 'out' && step !== 'reset')) return
    const level = step === 'reset' ? 0 : contents.getZoomLevel() + (step === 'in' ? 0.5 : -0.5)
    contents.setZoomLevel(Math.min(3, Math.max(-3, level)))
  })

  ipcMain.handle(CHANNELS.windowReload, () => {
    getWindow()?.webContents.reload()
  })
}
