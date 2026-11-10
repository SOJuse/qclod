import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu } from 'electron'
import { homedir } from 'node:os'
import { createMainWindow, hardenWebContents, offScreen, RENDERER_ENTRY } from './window'
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
import { loadTranscript } from './agent/transcript'
import { TabController } from './tabs/TabController'
import { pickDefaultCwd } from './tabs/defaultCwd'
import { mergeDefaults } from './tabs/sanitize'
import { notifyIfNeeded, shouldRaiseWindowForPermission } from './notifications'
import { RendererOutbox } from './rendererOutbox'
import { PathResolver } from './files/pathResolver'
import { cleanupPasteDir } from './files/imagePaste'
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
  // run rather than fail it. Honoured only in the e2e build: a release build
  // has no such branch and always shows the real dialog (buildFlags.d.ts).
  const stubbed = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_CONFIRM_BYPASS'] : undefined
  if (stubbed !== undefined) return stubbed === 'allow'
  // An off-screen run must not put a modal dialog in front of anyone.
  if (offScreen) return false
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

// Windows would report an off-screen window as covered, and Chromium would
// stop painting it (window.ts).
if (offScreen) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.on('web-contents-created', (_e, contents) => {
  hardenWebContents(contents)
})

app.whenReady().then(async () => {
  // No default menu: its accelerators (Close Window, Reload) would fight ours.
  Menu.setApplicationMenu(null)
  const userData = app.getPath('userData')
  let settings: AppSettings = loadSettings(userData)
  // Old screenshots go before new ones are added, and again every hour: the
  // app may stay open in the tray for weeks.
  cleanupPasteDir(userData)
  setInterval(() => cleanupPasteDir(userData), 60 * 60 * 1000).unref()

  const outbox = new RendererOutbox((channel, payload) => {
    const win = mainWindow
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  })
  const send = (channel: string, payload: unknown): void => outbox.send(channel, payload)

  // An off-screen run never raises, flashes or focuses the window (window.ts).
  function showWindow(): void {
    const win = mainWindow
    if (!win || offScreen) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  /**
   * A question for the agent shows the window but never takes the keyboard:
   * whatever the person is typing in another program must not land on it.
   */
  function showWindowInactive(): void {
    const win = mainWindow
    if (!win || offScreen) return
    if (win.isMinimized()) {
      win.flashFrame(true)
      return
    }
    win.showInactive()
    if (!win.isFocused()) win.flashFrame(true)
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
      if (shouldRaiseWindowForPermission(controller.activeTabId, request.tabId)) {
        showWindowInactive()
      }
      manager
        .get(request.tabId)
        ?.showPermissionCard(request.requestId, request.toolName, request.target)
    }
  })

  const manager = new AgentSessionManager({
    getAgentPath: () => settings.agentPath,
    createDriver: createDriverFactory(),
    askPermission: (request, signal) =>
      broker.request(request.tabId, request.toolName, request.input, request.requestId, signal),
    confirmBypass: () => confirmBypass(mainWindow)
  })

  // Under the fixture the past conversations come from the environment too,
  // so a history test never touches anyone's real session files: a session
  // without scripted messages is read from a transcript only when the test
  // points CLAUDE_CONFIG_DIR at a folder of its own, never from ~/.claude.
  // Only the e2e build has any of this (buildFlags.d.ts); the flag is repeated
  // at each use so the release bundle drops every branch, not just the first.
  const fakeHistory = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_HISTORY'] : undefined
  // A fixture history alone also switches the real session store off.
  const fake = (__QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_SDK'] || process.env['QCLOD_FAKE_HISTORY'] : undefined)
    ? fakeHistory
      ? (JSON.parse(fakeHistory) as {
          sessions?: Array<Record<string, unknown>>
          messages?: Record<string, unknown[]>
        })
      : {}
    : null
  const history =
    __QCLOD_TEST_SEAMS__ && fake
      ? new SessionHistory({ listSessions: async () => (fake.sessions ?? []) as never })
      : await import('./agent/sessionHistory').then((m) => m.createSessionHistory())
  const transcript = async (sessionId: string, cwd: string): Promise<unknown[]> => {
    if (!__QCLOD_TEST_SEAMS__ || !fake) return loadTranscript(sessionId, cwd)
    const scripted = fake.messages?.[sessionId]
    if (scripted) return scripted
    return process.env['CLAUDE_CONFIG_DIR'] ? loadTranscript(sessionId, cwd) : []
  }

  const controller = new TabController({
    manager,
    storeDir: userData,
    defaultCwd: pickDefaultCwd(app.isPackaged, process.cwd(), homedir()),
    // «По умолчанию» in settings means exactly that: a new tab starts with it.
    getDefaults: () => ({ ...settings.defaults }),
    history: {
      list: (cwd) => history.list(cwd),
      transcript
    },
    onChanged: (tabs) => {
      send(CHANNELS.tabsChanged, tabs)
      tray?.rebuild()
    },
    onRibbon: (event) => outbox.ribbon(event),
    onPanel: (event) => send(CHANNELS.panelChanged, event),
    onCommands: (event) => send(CHANNELS.commandsChanged, event),
    onStatus: (event) => {
      send(CHANNELS.statusChanged, event)
      const tab = controller.list().find((t) => t.id === event.tabId)
      // Nor does it show toasts.
      if (!tab || offScreen) return
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
      settings = mergeDefaults(settings, patch)
      saveSettings(userData, settings)
      if (settings.globalHotkey !== previousHotkey) hotkey.apply(settings.globalHotkey)
      return settings
    }
  })

  // e2e reads what a click on a path did from here (fileActions.ts). Only the
  // e2e build has it (buildFlags.d.ts).
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
    ;(globalThis as { __qclodShellLog?: unknown[] }).__qclodShellLog = []
  }

  registerAgentIpc({
    getWindow: () => mainWindow,
    controller,
    manager,
    broker,
    resolver: new PathResolver(),
    getEditorCommand: () => settings.editorCommand,
    userData,
    rememberDefault: (patch) => {
      settings = mergeDefaults(settings, { defaults: patch })
      saveSettings(userData, settings)
      send(CHANNELS.settingsChanged, settings)
    }
  })
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
