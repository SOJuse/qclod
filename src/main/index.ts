import { app, BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { createMainWindow, hardenWebContents, RENDERER_ENTRY } from './window'
import { registerBaseIpc } from './ipc'
import { loadSettings, saveSettings } from './store/settingsStore'
import { wireSessions } from './sessions/wiring'
import { readUserHooks } from './store/userHooks'

let mainWindow: BrowserWindow | null = null

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

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  let settings = loadSettings(userData)

  registerBaseIpc({
    getWindow: () => mainWindow,
    getSettings: () => settings,
    setSettings: (patch) => {
      settings = { ...settings, ...patch, defaults: { ...settings.defaults, ...patch.defaults } }
      saveSettings(userData, settings)
      return settings
    }
  })

  const pipePath = `\\\\.\\pipe\\qclod-${process.pid}`
  const sessions = wireSessions(
    () => mainWindow,
    () => settings,
    () => readUserHooks(),
    pipePath,
    userData,
    homedir()
  )

  mainWindow = createMainWindow()
  loadRenderer(mainWindow)

  // Tabs come up only once the renderer can receive their output.
  void sessions.startHooks()

  mainWindow.webContents.once('did-finish-load', () => {
    sessions.tabs.restore()
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
