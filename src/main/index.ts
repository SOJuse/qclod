import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  shell,
  utilityProcess,
  webContents
} from 'electron'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP_ID } from '../shared/appId'
import { AFTER_HANG, RELOAD_PARAM } from '../shared/reloadReason'
import {
  createMainWindow,
  FALLBACK_ENTRY,
  hardenWebContents,
  offScreen,
  RENDERER_ENTRY,
  watchMount,
  watchRenderer
} from './window'
import { ErrorLog, type ErrorEntry } from './system/errorLog'
import { installMainErrorHandlers } from './system/mainErrors'
import { registerFallbackIpc } from './fallbackIpc'
import { FALLBACK_PARAM, type FallbackReason } from '../shared/fallbackReason'
import { ReportThrottle } from './system/reportThrottle'
import { registerBaseIpc } from './ipc'
import { registerAgentIpc } from './agentIpc'
import { withFault } from './testSeams/ipcFaults'
import { loadSettings, saveSettings } from './store/settingsStore'
import { LayoutStore } from './store/layoutStore'
import { HotkeyRegistrar } from './hotkey/globalHotkey'
import { createTray, type TrayTone } from './tray'
import { readTaskbarLight } from './system/systemTheme'
import { CHANNELS } from '../shared/channels'
import { AgentSessionManager } from './agent/AgentSessionManager'
import { createDriverFactory } from './agent/createDriver'
import { PermissionBroker } from './agent/permissions'
import { loadRules, saveRules } from './agent/permissionStore'
import { SessionHistory } from './agent/sessionHistory'
import { loadTranscript } from './agent/transcript'
import { TabController } from './tabs/TabController'
import { pickDefaultCwd } from './tabs/defaultCwd'
import { mergeDefaults, sanitizeErrorReport } from './tabs/sanitize'
import { alertNotification, notifyIfNeeded, shouldRaiseWindowForPermission } from './notifications'
import { RendererOutbox } from './rendererOutbox'
import { PathResolver } from './files/pathResolver'
import { cleanupPasteDir } from './files/imagePaste'
import { createUpdateSource, UpdateFlow } from './update/updater'
import { openAgentTerminal, startVoiceTyping } from './system/console'
import { locateAgent } from './setup/findAgent'
import {
  electronBlocker,
  executionStateHelper,
  KeepAwake,
  USE_EXECUTION_STATE_HELPER
} from './system/keepAwake'
import { AutonomyHost } from './autonomy/autonomyHost'
import { applyOpenAtLogin } from './system/loginItem'
import { claimSingleInstance } from './system/singleInstance'
import { QuitReason, sessionEnding } from './system/quitReason'
import type { AppSettings, PermissionRequest, TabId } from '../shared/types'
import { VOICE_MODEL_IDS, VOICE_MODEL_INFO, type VoiceModelsSnapshot } from '../shared/voice'
import { VoiceHost, type WorkerLike } from './voice/voiceHost'
import { registerVoiceIpc, type ModelStoreLike } from './voice/voiceIpc'
import type { FromWorker } from './voice/protocol'

let mainWindow: BrowserWindow | null = null

/**
 * The voice process (voice/worker.ts). Its output goes to our console, marked:
 * the process has no log of its own.
 */
function forkVoiceWorker(): WorkerLike {
  const child = utilityProcess.fork(join(__dirname, 'voiceWorker.js'), [], {
    serviceName: 'Qclod voice',
    stdio: 'pipe'
  })
  child.stdout?.on('data', (d: Buffer) => console.log('[voice]', String(d).trimEnd()))
  child.stderr?.on('data', (d: Buffer) => console.warn('[voice]', String(d).trimEnd()))
  return {
    postMessage: (m) => child.postMessage(m),
    on: (e: 'message' | 'exit', f: ((m: FromWorker) => void) | ((code: number) => void)) => {
      child.on(e as 'exit', f as (code: number) => void)
    },
    kill: () => child.kill()
  } as WorkerLike
}

/** Until the models' store (task 6) is wired in (task 9): every model absent. */
const noModels: ModelStoreLike = {
  snapshot: (): VoiceModelsSnapshot => ({
    models: VOICE_MODEL_IDS.map((id) => ({
      id,
      state: { kind: 'absent' },
      available: VOICE_MODEL_INFO[id].platforms.includes(process.platform)
    })),
    micAccess: 'unknown'
  }),
  download: async () => {},
  cancel: () => {},
  remove: async () => {}
}

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

/** The same question for «авто-да»: Qclod would answer «allow» for the person. */
async function confirmAutoAllow(win: BrowserWindow | null): Promise<boolean> {
  const stubbed = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_CONFIRM_AUTO_ALLOW'] : undefined
  if (stubbed !== undefined) return stubbed === 'allow'
  if (offScreen) return false
  if (!win || win.isDestroyed()) return false

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Отмена', 'Включить'],
    defaultId: 0,
    cancelId: 0,
    title: 'Режим «авто-да»',
    message: 'Qclod будет сам разрешать агенту всё, о чём он спросит',
    detail:
      'Агент сможет менять файлы и запускать команды в этой вкладке без вашего ответа. ' +
      'Сохранённые запреты по-прежнему действуют. Если на вопрос или план никто не ответит ' +
      'за время из настроек «Автономность», Qclod ответит сам. Режим запомнится для этой ' +
      'вкладки, пока вы не выберете другой.'
  })
  return response === 1
}
let quitting = false

/** `afterHang`: the watchdog killed the hung page; the new one is told so (shared/reloadReason.ts). */
function loadRenderer(win: BrowserWindow, afterHang = false): void {
  const query: Record<string, string> = afterHang ? { [RELOAD_PARAM]: AFTER_HANG } : {}
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    const url = new URL(devServer)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    void win.loadURL(url.toString())
  } else void win.loadFile(RENDERER_ENTRY, afterHang ? { query } : undefined)
}

/**
 * The static page for a window that will not start (fallback.html): no React,
 * so it does not depend on the bundle that failed. The dev server serves it
 * from the renderer root; a build has it next to index.html.
 */
function loadFallback(win: BrowserWindow, reason: FallbackReason): void {
  if (win.isDestroyed()) return
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) {
    const url = new URL('fallback.html', devServer.endsWith('/') ? devServer : devServer + '/')
    url.searchParams.set(FALLBACK_PARAM, reason)
    void win.loadURL(url.toString())
  } else void win.loadFile(FALLBACK_ENTRY, { query: { [FALLBACK_PARAM]: reason } })
}

/** The watchdog of the current window; «Попробовать снова» clears its reload count. */
let rendererWatch: { reset(): void } | null = null

/**
 * The renderer watchdogs for this window (window.ts): a page that crashes
 * three times in a minute, fails to load, or never shows its first screen ends
 * on the static page. e2e only: QCLOD_HANG_MS shortens the wait before a hung
 * page is killed, QCLOD_MOUNT_MS the wait for the first screen.
 */
function watchWindow(win: BrowserWindow, log: (e: ErrorEntry) => void): void {
  const hangMs = __QCLOD_TEST_SEAMS__ ? Number(process.env['QCLOD_HANG_MS']) || undefined : undefined
  const mountMs = __QCLOD_TEST_SEAMS__ ? Number(process.env['QCLOD_MOUNT_MS']) || undefined : undefined
  const onGiveUp = (reason: FallbackReason): void => loadFallback(win, reason)
  rendererWatch = watchRenderer(win.webContents, {
    log,
    hangMs,
    reloadAfterHang: () => loadRenderer(win, true),
    onGiveUp
  })
  watchMount(win.webContents, { log, ms: mountMs, onGiveUp })
}

// The start of this file has one permanent order. Each stage puts its piece in
// its own place and moves nobody else's (tests/unit/startupOrder.test.ts):
//   1. the askpass client and its exit               (stage 6, runAskpassClient)
//   2. the userData override                         (app.setPath('userData', …))
//   3. ErrorLog and installMainErrorHandlers         (below)
//   4. the single-instance lock                      (stage 3, claimSingleInstance)
//   5. command-line switches                         (stage 5, app.commandLine.appendSwitch)
// and then app.whenReady().

// Tests point the app at a throwaway profile so runs cannot affect each other
// or the real one.
const userDataOverride = process.env['QCLOD_USER_DATA']
if (userDataOverride) app.setPath('userData', userDataOverride)

// What broke, for whoever has to find out why (system/errorLog.ts). Errors the
// main process throws are written down as well as printed, from here on: one
// thrown before the app is ready is the one nobody would otherwise see.
const errorLog = new ErrorLog(join(app.getPath('userData'), 'logs'))
installMainErrorHandlers(process, (e) => errorLog.write(e))

// One Qclod per profile (system/singleInstance.ts). A second one only raises the
// window of the first and quits; it must start nothing, so everything below that
// needs the app ready is behind gotLock. The first one may still be starting when
// the second arrives: the raise waits for the window.
let onSecondInstance: (() => void) | null = null
let secondPending = false
const gotLock = claimSingleInstance(app, () => {
  if (onSecondInstance) onSecondInstance()
  else secondPending = true
})
// The tray keeps the app alive after its window closes, which a headless test
// run cannot shut down cleanly.
const headless = process.env['QCLOD_HEADLESS'] === '1'

// Matches the AUMID of the NSIS shortcut, so Windows notifications are tied to it.
app.setAppUserModelId(APP_ID)

// Windows would report an off-screen window as covered, and Chromium would
// stop painting it (window.ts).
if (offScreen) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

app.on('web-contents-created', (_e, contents) => {
  hardenWebContents(contents)
})

if (gotLock) void app.whenReady().then(async () => {
  // No default menu: its accelerators (Close Window, Reload) would fight ours.
  Menu.setApplicationMenu(null)
  const userData = app.getPath('userData')
  let settings: AppSettings = loadSettings(userData)
  // Start at login: an installed build only, and never from an e2e run.
  const syncLoginItem = (): void => {
    if (!__QCLOD_TEST_SEAMS__) applyOpenAtLogin(app, settings.openAtLogin)
  }
  syncLoginItem()
  // Why Qclod ends: a session end or an update restart leaves the tabs marked
  // as working for the next start (system/quitReason.ts); before-quit hands it to the host.
  const quitReason = new QuitReason()
  powerMonitor.on('shutdown', () => sessionEnding(quitReason, autonomy))

  // A repeating or hostile sender must not push the first, most useful error
  // out of the log (system/reportThrottle.ts).
  const reportGate = new ReportThrottle()
  ipcMain.on(CHANNELS.rendererError, (e, raw: unknown) => {
    const report = sanitizeErrorReport(raw)
    if (!report) return
    const stack = [report.stack, report.componentStack].filter(Boolean).join('\n')
    const verdict = reportGate.check(e.sender.id, [report.scope, report.message, stack].join('\n'))
    if (!verdict.admit) return
    if (verdict.dropped > 0) {
      errorLog.write({
        source: 'renderer',
        scope: report.scope,
        message: `${verdict.dropped} отчётов об ошибках пропущено`,
        at: Date.now()
      })
    }
    errorLog.write({
      source: 'renderer',
      scope: report.scope,
      message: report.message,
      stack: stack || undefined,
      at: Date.now()
    })
  })
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

  // The machine stays awake while an agent works or waits for the person
  // (system/keepAwake.ts). An off-screen test run holds nothing.
  const keepAwake = new KeepAwake(
    offScreen || headless
      ? []
      : [
          electronBlocker(powerSaveBlocker),
          ...(process.platform === 'win32' && USE_EXECUTION_STATE_HELPER
            ? [executionStateHelper(spawn, process.pid)]
            : [])
        ]
  )
  keepAwake.onChange(() => tray?.rebuild())

  // The «авто-да» timer, read on every use so the setting applies to new cards
  // at once. e2e shortens it to milliseconds and takes the jitter out
  // (buildFlags.d.ts); the ribbon line and the core both read this one.
  const autoAnswerMs = (): number => {
    const seam = __QCLOD_TEST_SEAMS__ ? Number(process.env['QCLOD_AUTO_ANSWER_MS']) : 0
    return seam > 0 ? seam : settings.autoAnswerMinutes * 60_000
  }

  // One autonomy core per tab (autonomy/autonomyHost.ts). The controller does
  // not exist yet, so the host reaches it through these.
  const autonomy = new AutonomyHost({
    controller: {
      list: () => controller.list(),
      revive: (id) => controller.revive(id),
      notice: (id, text, tone) => controller.notice(id, text, tone),
      setAutonomyRecord: (id, record) => controller.setAutonomyRecord(id, record)
    },
    manager: { get: (id) => manager.get(id) },
    autoAnswerMs,
    alert: (id, text) => {
      const tab = controller.list().find((t) => t.id === id)
      if (!tab || offScreen) return
      alertNotification({
        settings,
        title: tab.title,
        body: text,
        onActivate: () => {
          showWindow()
          send(CHANNELS.activateTab, id)
        }
      })
    },
    onAwakeChange: (needed) => keepAwake.set(needed),
    ...(__QCLOD_TEST_SEAMS__ && process.env['QCLOD_AUTONOMY_NO_JITTER'] === '1' ? { random: () => 0 } : {})
  })
  powerMonitor.on('resume', () => autonomy.systemResumed())

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
      broker.request(
        request.tabId,
        request.toolName,
        request.input,
        request.requestId,
        signal,
        request.auto === true
      ),
    confirmBypass: () => confirmBypass(mainWindow),
    confirmAutoAllow: () => confirmAutoAllow(mainWindow),
    // The same length the core counts down; under the e2e seam a fraction.
    autoAnswerMinutes: () => autoAnswerMs() / 60_000,
    onClosed: (id) => broker.clearSession(id)
  })
  // e2e asks whether a chat still holds its agent session (stage2.spec.ts).
  // Only the e2e build has it (buildFlags.d.ts).
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SDK']) {
    ;(globalThis as { __qclodHasSession?: (id: TabId) => boolean }).__qclodHasSession = (id) =>
      manager.get(id) !== undefined
  }

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

  // userData/layout.json: the split, the active chat, the projects. The
  // controller and the IPC share it; every change reaches the window.
  const layout = new LayoutStore(userData, (l) => send(CHANNELS.layoutChanged, l))

  const controller: TabController = new TabController({
    manager,
    autonomy,
    storeDir: userData,
    layout,
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
      tray?.refresh()
    },
    onRibbon: (event) => outbox.ribbon(event),
    onPanel: (event) => send(CHANNELS.panelChanged, event),
    onCommands: (event) => send(CHANNELS.commandsChanged, event),
    onStatus: (event) => {
      send(CHANNELS.statusChanged, event)
      tray?.refresh()
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

  // Voice input on a local model (voice/voiceHost.ts): the voice process starts
  // on the first press. Models, the microphone and its settings page are stubs
  // until task 9 wires the models' store and micAccess in.
  const voiceHost = new VoiceHost({
    fork: forkVoiceWorker,
    pathsFor: () => null,
    settings: () => settings.voice,
    micAccess: () => 'unknown',
    emit: (owner, e) => {
      const contents = webContents.fromId(owner)
      if (contents && !contents.isDestroyed()) contents.send(CHANNELS.voiceEvent, e)
    },
    log: (e) => errorLog.write(e),
    killPid: (pid) => {
      try {
        process.kill(pid)
      } catch {
        // Already gone.
      }
    }
  })
  // e2e of the packaged app (tests/e2e/packaged.spec.ts): the voice process
  // loads sherpa-onnx-node and makes a VAD from the given silero_vad.onnx.
  const voiceSelftest = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_VOICE_SELFTEST'] : undefined
  if (__QCLOD_TEST_SEAMS__ && voiceSelftest) {
    const g = globalThis as { __qclodVoiceSelftest?: { ok: boolean; error?: string } }
    const probe = forkVoiceWorker()
    probe.on('message', (m) => {
      if (m.type !== 'selftest') return
      g.__qclodVoiceSelftest = m.error === undefined ? { ok: m.ok } : { ok: m.ok, error: m.error }
      console.log('[voice] selftest', JSON.stringify(g.__qclodVoiceSelftest))
      probe.kill()
    })
    probe.on('exit', (code) => {
      g.__qclodVoiceSelftest ??= { ok: false, error: `voice process exited with code ${code}` }
    })
    probe.postMessage({ type: 'selftest', vad: voiceSelftest })
  }
  registerVoiceIpc({
    host: voiceHost,
    store: noModels,
    isOurWindow: (id) => mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.webContents.id === id,
    openMicSettings: async () => {}
  })

  registerBaseIpc({
    getWindow: () => mainWindow,
    getSettings: () => settings,
    setSettings: (patch) => {
      const previousHotkey = settings.globalHotkey
      const previousLogin = settings.openAtLogin
      const previousVoiceModel = settings.voice.model
      settings = mergeDefaults(settings, patch)
      saveSettings(userData, settings)
      if (settings.globalHotkey !== previousHotkey) hotkey.apply(settings.globalHotkey)
      if (settings.openAtLogin !== previousLogin) syncLoginItem()
      if (settings.voice.model !== previousVoiceModel) voiceHost.modelChanged()
      return settings
    },
    // Tabs that stopped for want of a login carry on by themselves.
    onLoggedIn: () => void controller.afterLogin()
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
    layout,
    history,
    resolver: new PathResolver(),
    getEditorCommand: () => settings.editorCommand,
    autonomy,
    userData,
    openTerminal: (cwd) => {
      // e2e records the call instead of opening a console (buildFlags.d.ts).
      if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
        const g = globalThis as { __qclodTerminalOpens?: string[] }
        ;(g.__qclodTerminalOpens ??= []).push(cwd)
        return
      }
      if (offScreen) return
      try {
        openAgentTerminal(locateAgent(settings.agentPath, process.env), cwd)
      } catch (err) {
        console.warn('[terminal]', err instanceof Error ? err.message : String(err))
      }
    },
    rememberDefault: (patch) => {
      settings = mergeDefaults(settings, { defaults: patch })
      saveSettings(userData, settings)
      send(CHANNELS.settingsChanged, settings)
    }
  })
  ipcMain.handle(CHANNELS.hotkeyStatus, () => withFault(CHANNELS.hotkeyStatus, () => hotkey.status))

  // Voice input is Windows' own (Win+H), pressed for the person: the input
  // line has the focus already, and the dictation lands in it.
  ipcMain.handle(CHANNELS.voiceStart, () => {
    if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
      const g = globalThis as { __qclodVoiceStarts?: number }
      g.__qclodVoiceStarts = (g.__qclodVoiceStarts ?? 0) + 1
      return
    }
    if (offScreen || process.platform !== 'win32') return
    startVoiceTyping()
  })

  // Updates come from GitHub releases and install on restart or on quit. A
  // failed check is a console line only (updater.ts). quitAndInstall ends in
  // app.quit(), so the before-quit below sets `quitting` and the window's
  // close-to-tray does not catch that exit.
  const updateSource = createUpdateSource(app.isPackaged)
  const updates = updateSource
    ? new UpdateFlow({
        source: updateSource,
        onState: (state) => send(CHANNELS.updateChanged, state),
        log: (message) => console.warn('[update]', message)
      })
    : null
  ipcMain.handle(CHANNELS.updateGet, () => updates?.state ?? { kind: 'idle' })
  ipcMain.handle(CHANNELS.updateRestart, () => {
    const ready = updates?.state.kind === 'ready'
    if (ready) quitReason.markInterrupted()
    return updates?.restart() ?? false
  })

  mainWindow = createMainWindow()
  watchWindow(mainWindow, (e) => errorLog.write(e))
  mainWindow.on('session-end', () => sessionEnding(quitReason, autonomy))
  loadRenderer(mainWindow)
  onSecondInstance = showWindow
  if (secondPending) showWindow()

  // The static page's ways out. The retry starts the count of reloads afresh.
  registerFallbackIpc({
    ipcMain,
    openPath: (path) => shell.openPath(path),
    userData,
    resetWatch: () => rendererWatch?.reset(),
    reload: () => {
      if (mainWindow && !mainWindow.isDestroyed()) loadRenderer(mainWindow)
    }
  })

  // The glyph's tone follows the taskbar, not the apps' theme (decision 13):
  // the registry first, the apps' theme until it answers or when it cannot.
  let taskbarLight: boolean | null = null
  const trayTone = (): TrayTone =>
    taskbarLight === null ? (nativeTheme.shouldUseDarkColors ? 'light' : 'dark') : taskbarLight ? 'dark' : 'light'
  const tray = headless
    ? null
    : (createTray({
        getWindow: () => mainWindow,
        getTabs: () => controller.list(),
        onActivateTab: (id: TabId) => {
          showWindow()
          send(CHANNELS.activateTab, id)
        },
        toggleWindow,
        getTone: trayTone,
        isKeepingAwake: () => keepAwake.active
      }))

  const rereadTaskbarTheme = (): void => {
    void readTaskbarLight().then((light) => {
      taskbarLight = light
      tray?.refresh()
    })
  }
  if (tray) {
    rereadTaskbarTheme()
    nativeTheme.on('updated', rereadTaskbarTheme)
  }

  mainWindow.on('close', (event) => {
    if (quitting || headless || !settings.closeToTray) return
    event.preventDefault()
    mainWindow?.hide()
  })

  if (!headless) hotkey.apply(settings.globalHotkey)

  mainWindow.webContents.once('did-finish-load', () => {
    void controller.restore()
    tray?.rebuild()
    updates?.start(updateSource?.firstCheckMs)
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    hotkey.release()
    voiceHost.dispose()
    // Before the sessions go down: their ending is no crash and no idle to write down.
    autonomy.quitting(quitReason.deliberate)
    broker.cancelAll()
    void controller.disposeAll().finally(() => app.quit())
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    keepAwake.dispose()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      watchWindow(mainWindow, (e) => errorLog.write(e))
      loadRenderer(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
