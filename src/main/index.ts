import { app, BrowserWindow, globalShortcut, ipcMain, Notification, type Tray } from 'electron'
import { homedir } from 'node:os'
import { createMainWindow, hardenWebContents, RENDERER_ENTRY } from './window'
import { registerBaseIpc } from './ipc'
import { loadSettings, saveSettings } from './store/settingsStore'
import { wireSessions } from './sessions/wiring'
import { collectHooks } from './store/userHooks'
import { HotkeyRegistrar } from './hotkey/globalHotkey'
import { notificationFor } from './notifications'
import { createTray } from './tray'
import { CHANNELS } from '../shared/channels'
import type { TabId } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let quitting = false

function loadRenderer(win: BrowserWindow): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void win.loadURL(devServer)
  } else {
    void win.loadFile(RENDERER_ENTRY)
  }
}

// Tests point the app at a throwaway profile so runs cannot affect each other
// or the real one.
const userDataOverride = process.env['QCLOD_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)

// Any webContents created later inherits the same navigation gate.
app.on('web-contents-created', (_e, contents) => {
  hardenWebContents(contents)
})

// The tray keeps the app alive after the window closes, which a headless
// test run cannot shut down cleanly. Tray behaviour is OS-level and is
// verified by the release checklist instead.
const headless = process.env['QCLOD_HEADLESS'] === '1'

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  let settings = loadSettings(userData)

  function showWindow(): void {
    const win = mainWindow
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  function toggleWindow(): void {
    const win = mainWindow
    if (!win) return
    if (win.isVisible() && win.isFocused()) win.hide()
    else showWindow()
  }

  const hotkey = new HotkeyRegistrar(
    {
      register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
      isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator)
    },
    toggleWindow
  )

  registerBaseIpc({
    getWindow: () => mainWindow,
    getSettings: () => settings,
    setSettings: (patch) => {
      const previousHotkey = settings.globalHotkey
      settings = { ...settings, ...patch, defaults: { ...settings.defaults, ...patch.defaults } }
      saveSettings(userData, settings)
      if (settings.globalHotkey !== previousHotkey) hotkey.apply(settings.globalHotkey)
      return settings
    }
  })

  ipcMain.handle(CHANNELS.hotkeyStatus, () => hotkey.status)

  const pipePath = `\\\\.\\pipe\\qclod-${process.pid}`
  const sessions = wireSessions(
    () => mainWindow,
    () => settings,
    (cwd) => collectHooks(cwd),
    pipePath,
    userData,
    homedir(),
    (tabId, state, tabTitle) => {
      const plan = notificationFor({
        state,
        tabTitle,
        isWindowFocused: mainWindow?.isFocused() ?? false,
        settings
      })
      if (!plan || !Notification.isSupported()) return

      const note = new Notification({ title: plan.title, body: plan.body, silent: plan.silent })
      note.on('click', () => {
        showWindow()
        mainWindow?.webContents.send(CHANNELS.activateTab, tabId)
      })
      note.show()
    }
  )

  mainWindow = createMainWindow()
  loadRenderer(mainWindow)

  const tray = headless
    ? null
    : (createTray({
    getWindow: () => mainWindow,
    getTabs: () => sessions.tabs.list(),
    onActivateTab: (id: TabId) => {
      showWindow()
      sessions.tabs.activate(id)
      mainWindow?.webContents.send(CHANNELS.activateTab, id)
    },
      toggleWindow
      }) as Tray & { rebuild: () => void })

  // Closing the window hides it; the app keeps running for the global hotkey.
  mainWindow.on('close', (event) => {
    if (quitting || headless || !settings.closeToTray) return
    event.preventDefault()
    mainWindow?.hide()
  })

  if (!headless) hotkey.apply(settings.globalHotkey)
  void sessions.startHooks()

  mainWindow.webContents.once('did-finish-load', () => {
    sessions.tabs.restore()
    tray?.rebuild()
  })

  app.on('before-quit', () => {
    quitting = true
    hotkey.release()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      loadRenderer(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
