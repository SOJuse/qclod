import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { createMainWindow } from './window'

let mainWindow: BrowserWindow | null = null

function loadRenderer(win: BrowserWindow): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    void win.loadURL(devServer)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  mainWindow = createMainWindow()
  loadRenderer(mainWindow)

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
