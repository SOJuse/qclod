import { app, BrowserWindow, dialog, globalShortcut, ipcMain } from 'electron'
import { homedir } from 'node:os'
import { createMainWindow, hardenWebContents, RENDERER_ENTRY } from './window'
import { registerBaseIpc } from './ipc'
import { registerAgentIpc } from './agentIpc'
import { loadSettings, saveSettings } from './store/settingsStore'
import { HotkeyRegistrar } from './hotkey/globalHotkey'
import { createTray } from './tray'
import { CHANNELS } from '../shared/channels'
import { AgentSessionManager } from './agent/AgentSessionManager'
import { createDriverFactory } from './agent/createDriver'
import { PermissionBroker } from './agent/permissions'
import { loadRules, saveRules } from './agent/permissionStore'
import { SessionHistory } from './agent/sessionHistory'
import { TabController } from './tabs/TabController'
import { notifyIfNeeded } from './notifications'
import { RibbonBatcher } from './ribbonBatcher'
import type { AppSettings, PermissionRequest, TabId } from '../shared/types'

let mainWindow: BrowserWindow | null = null

/**
 * Asks, in a window the renderer cannot script, whether the user really means
 * to let the agent act without being asked again.
 *
 * Every other permission mode still asks about something; this one asks about
 * nothing, so arriving in it by a stray click, a stale tabs.json or a bug in
 * the window is the failure worth preventing. Choosing it deliberately still
 * works.
 */
async function confirmBypass(win: BrowserWindow | null): Promise<boolean> {
  // An e2e run cannot click a native dialog, and a modal one would hang the
  // run rather than fail it. Honoured only in a development build: a packaged
  // install always shows the real dialog.
  const stubbed = process.env['QCLOD_CONFIRM_BYPASS']
  if (stubbed !== undefined && !app.isPackaged) return stubbed === 'allow'
  if (!win || win.isDestroyed()) return false

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Отмена', 'Включить'],
    defaultId: 0,
    cancelId: 0,
    title: 'Режим без проверок',
    message: 'Агент перестанет спрашивать разрешение на инструменты',
    detail:
      'Он сможет менять файлы и запускать команды в этой папке без вопросов, ' +
      'пока вы не вернёте другой режим.'
  })
  return response === 1
}
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

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  let settings: AppSettings = loadSettings(userData)

  function send(channel: string, payload: unknown): void {
    const win = mainWindow
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

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

  // The question is put in the tab's own ribbon and answered from there.
  // A window that is gone cannot answer, so the broker denies rather than
  // leaving the agent waiting forever.
  const broker = new PermissionBroker({
    loadRules: () => loadRules(userData),
    saveRules: (rules) => saveRules(userData, rules),
    ask: (request: PermissionRequest) => {
      const win = mainWindow
      if (!win || win.isDestroyed()) {
        broker.answer(request.requestId, { behavior: 'deny' })
        return
      }
      showWindow()
      manager
        .get(request.tabId)
        ?.showPermissionCard(request.requestId, request.toolName, request.target)
    }
  })

  const manager = new AgentSessionManager({
    getAgentPath: () => settings.agentPath,
    createDriver: createDriverFactory(),
    askPermission: (request) =>
      broker.request(request.tabId, request.toolName, request.input, request.requestId),
    confirmBypass: () => confirmBypass(mainWindow)
  })

  // Under the fixture the past conversations come from the environment too,
  // so a history test never touches anyone's real session files.
  const fakeHistory = process.env['QCLOD_FAKE_HISTORY']
  const history = process.env['QCLOD_FAKE_SDK']
    ? (() => {
        const script = fakeHistory
          ? (JSON.parse(fakeHistory) as {
              sessions?: Array<Record<string, unknown>>
              messages?: Record<string, unknown[]>
            })
          : {}
        return new SessionHistory({
          listSessions: async () => (script.sessions ?? []) as never,
          getSessionMessages: async (id: string) => script.messages?.[id] ?? []
        })
      })()
    : await import('./agent/sessionHistory').then((m) => m.createSessionHistory())

  const ribbonBatcher = new RibbonBatcher((event) => send(CHANNELS.ribbonChanged, event))

  const controller = new TabController({
    manager,
    storeDir: userData,
    defaultCwd: process.cwd() || homedir(),
    // «По умолчанию» in settings means exactly that: a new tab starts with it.
    getDefaults: () => ({ ...settings.defaults }),
    history: {
      list: (cwd) => history.list(cwd),
      messages: (sessionId) => history.messages(sessionId)
    },
    onChanged: (tabs) => {
      send(CHANNELS.tabsChanged, tabs)
      tray?.rebuild()
    },
    onRibbon: (event) => ribbonBatcher.push(event),
    onPanel: (event) => send(CHANNELS.panelChanged, event),
    onCommands: (event) => send(CHANNELS.commandsChanged, event),
    onStatus: (event) => {
      send(CHANNELS.statusChanged, event)
      const tab = controller.list().find((t) => t.id === event.tabId)
      if (!tab) return
      if (!event.finished && event.status !== 'waiting' && event.status !== 'error') return
      notifyIfNeeded({
        settings,
        tab,
        status: event.status,
        isActive: controller.activeTabId === event.tabId && (mainWindow?.isFocused() ?? false),
        onActivate: () => {
          showWindow()
          send(CHANNELS.activateTab, event.tabId)
        }
      })
    }
  })

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

  registerAgentIpc({ getWindow: () => mainWindow, controller, manager, broker })
  ipcMain.handle(CHANNELS.hotkeyStatus, () => hotkey.status)

  mainWindow = createMainWindow()
  loadRenderer(mainWindow)

  const tray = headless
    ? null
    : (createTray({
        getWindow: () => mainWindow,
        getTabs: () => controller.list(),
        onActivateTab: (id: TabId) => {
          showWindow()
          send(CHANNELS.activateTab, id)
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
    void controller.restore()
    tray?.rebuild()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    hotkey.release()
    broker.cancelAll()
    void controller.disposeAll().finally(() => app.quit())
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
