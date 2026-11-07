import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { checkEnvironment } from './setup/environment'
import { detectInstallMethod, installAgent, type InstallHandle } from './setup/install'
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
  /** The install running right now, if any — only one at a time. */
  let install: InstallHandle | null = null

  ipcMain.handle(CHANNELS.appVersion, () => app.getVersion())
  ipcMain.handle(CHANNELS.settingsGet, () => deps.getSettings())
  ipcMain.handle(CHANNELS.settingsSet, (_e, patch: Partial<AppSettings>) => {
    const next = deps.setSettings(patch)
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.settingsChanged, next)
    return next
  })

  // ---------------------------------------------------------------- setup

  ipcMain.handle(CHANNELS.setupCheck, () => checkEnvironment(deps.getSettings().agentPath))

  ipcMain.handle(CHANNELS.setupInstall, async () => {
    const win = getWindow()
    const method = await detectInstallMethod()
    if (!method) {
      win?.webContents.send(
        CHANNELS.setupOutput,
        'Не нашёл, чем установить: нужен либо winget (есть в Windows 10 и 11), либо Node.js.'
      )
      return false
    }

    return new Promise<boolean>((resolve) => {
      install = installAgent(
        method,
        (line) => {
          if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.setupOutput, line)
        },
        (ok) => {
          install = null
          resolve(ok)
        }
      )
    })
  })

  ipcMain.handle(CHANNELS.setupCancel, () => {
    install?.cancel()
    install = null
  })

  // Logging in happens in a terminal, so Qclod opens one rather than leaving
  // the user to find it. The command is ours, never the renderer's.
  ipcMain.handle(CHANNELS.setupTerminal, () => {
    const agent = deps.getSettings().agentPath || 'claude'
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', agent], {
        detached: true,
        windowsHide: false
      }).unref()
      return
    }
    spawn('x-terminal-emulator', ['-e', agent], { detached: true }).unref()
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
}
