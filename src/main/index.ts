import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron'
import { createMainWindow, hardenWebContents, RENDERER_ENTRY } from './window'
import { registerBaseIpc } from './ipc'
import { loadSettings, saveSettings } from './store/settingsStore'
import { HotkeyRegistrar } from './hotkey/globalHotkey'
import { createTray } from './tray'
import { CHANNELS } from '../shared/channels'
import type { AppSettings, TabId } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let quitting = false

function loadRenderer(win: BrowserWindow): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) void win.loadURL(devServer)
  else void win.loadFile(RENDERER_ENTRY)
}

// Tests point the app at a throwaway profile so runs cannot affect each other
// or the real one.
const userDataOverride = process.env['QCLOD_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)

// The tray keeps the app alive after its window closes, which a headless test
// run cannot shut down cleanly.
const headless = process.env['QCLOD_HEADLESS'] === '1'

app.on('web-contents-created', (_e, contents) => {
  hardenWebContents(contents)
})

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  let settings: AppSettings = loadSettings(userData)

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

  mainWindow = createMainWindow()
  loadRenderer(mainWindow)

  const tray = headless
    ? null
    : (createTray({
        getWindow: () => mainWindow,
        getTabs: () => [],
        onActivateTab: (id: TabId) => {
          showWindow()
          mainWindow?.webContents.send(CHANNELS.activateTab, id)
        },
        toggleWindow
      }) as ReturnType<typeof createTray> & { rebuild: () => void })

  mainWindow.on('close', (event) => {
    if (quitting || headless || !settings.closeToTray) return
    event.preventDefault()
    mainWindow?.hide()
  })

  if (!headless) hotkey.apply(settings.globalHotkey)

  mainWindow.webContents.once('did-finish-load', () => {
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
