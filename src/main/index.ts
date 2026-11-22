import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  powerMonitor,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
  utilityProcess,
  webContents
} from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'

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
import { appMenuTemplate } from './menu'
import { MacUpdateNotifier, parseFakeAvailable } from './update/macNotifier'
import { loginShellPath, mergePath } from '../core/shellEnv'
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
import { cleanupRemoteFiles } from './ssh/remoteFiles'
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
import { installMediaPermissions, micAccessStatus, openMicSettings } from './voice/micAccess'
import { runAskpassClient } from './ssh/askpassClient'
import { AskpassServer } from './ssh/askpass'
import { HostStore } from './ssh/hostStore'
import { electronSecretBox } from './ssh/secretBox'
import { readUserConfigHosts } from './ssh/sshConfig'
import { findSsh, setSshContext } from './ssh/sshRun'
import { HostManager } from './ssh/hostManager'
import { RelayClient } from './ssh/relayClient'
import { createRelayDriver } from './ssh/relayDriver'
import { sshTransport } from './ssh/transport'
import { SshPromptBroker } from './ssh/promptBroker'
import { registerServerIpc } from './ssh/serverIpc'
import { TerminalHub, nodePtySpawn, type TerminalSpawn } from './ssh/terminal'
import { registerTerminalIpc } from './ssh/terminalIpc'
import { ServerLogin, pipePty } from './ssh/serverLogin'
import type { RelayManifest } from './ssh/relayInstaller'
import type { ServerEntry, SessionSummary } from '../shared/types'
import { QuitReason, sessionEnding } from './system/quitReason'
import type { AppSettings, PermissionRequest, TabId } from '../shared/types'
import { VoiceHost, type WorkerLike } from './voice/voiceHost'
import { registerVoiceIpc, voiceSnapshot } from './voice/voiceIpc'
import type { FromWorker } from './voice/protocol'
import { ModelStore } from './voice/modelStore'
import { modelsRoot } from './voice/modelsRoot'
import { cudaReady, detectNvidia, VC_REDIST_URL, vcRuntimeReady } from './voice/nvidia'

let mainWindow: BrowserWindow | null = null

/** How much of the voice process's stderr is kept for the log and for telling a crash's cause. */
const VOICE_STDERR_TAIL = 8 * 1024

/**
 * The voice process (voice/worker.ts). Its output goes to our console, marked:
 * the process has no log of its own. The end of its stderr is kept: a native
 * crash (a different onnxruntime.dll, I2) or the Whisper server's death says
 * why only there (voiceHost.ts).
 */
function forkVoiceWorker(): WorkerLike {
  const child = utilityProcess.fork(join(__dirname, 'voiceWorker.js'), [], {
    serviceName: 'Qclod voice',
    stdio: 'pipe'
  })
  let tail = ''
  let stderrEnded = child.stderr === null
  child.stdout?.on('data', (d: Buffer) => console.log('[voice]', String(d).trimEnd()))
  child.stderr?.on('data', (d: Buffer) => {
    const text = String(d)
    console.warn('[voice]', text.trimEnd())
    tail = (tail + text).slice(-VOICE_STDERR_TAIL)
  })
  child.stderr?.on('end', () => (stderrEnded = true))
  return {
    postMessage: (m) => child.postMessage(m),
    on: (e: 'message' | 'exit', f: ((m: FromWorker) => void) | ((code: number) => void)) => {
      if (e === 'message') {
        child.on('message', f as (m: FromWorker) => void)
        return
      }
      // The exit may come before the last of stderr is read: wait for its end (at most 250 ms).
      child.on('exit', (code) => {
        const done = f as (code: number) => void
        if (stderrEnded || child.stderr === null) return done(code)
        let called = false
        const once = (): void => {
          if (called) return
          called = true
          clearTimeout(timer)
          done(code)
        }
        const timer = setTimeout(once, 250)
        child.stderr.once('end', once)
      })
    },
    kill: () => child.kill(),
    stderrTail: () => tail
  } as WorkerLike
}

/** Whisper's archive for the card, unpacked by Windows' own tar by its full path (decision 13). A cancel stops tar. */
function extractZip(zip: string, dest: string, signal?: AbortSignal): Promise<void> {
  const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dest], { windowsHide: true, signal }, (err) => (err ? reject(err) : resolve()))
  })
}

async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir)
  return s.bavail * s.bsize
}

/** The card is asked once a run: nvidia-smi takes a while, and a card does not come and go. */
function nvidiaOnce(): () => Promise<{ ok: true } | { ok: false; reason: string }> {
  let answer: Promise<{ ok: true } | { ok: false; reason: string }> | null = null
  return () => (answer ??= detectNvidia().then(cudaReady, () => cudaReady(null)))
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

// Windows: ssh runs Qclod.exe itself as SSH_ASKPASS (ssh/askpass.ts). That run
// only carries one question to the running Qclod and prints the answer: it
// touches no profile, takes no instance lock (a second instance would raise
// the window and the question would get no answer) and opens no window.
const askpassMode = process.env['QCLOD_ASKPASS_PIPE'] !== undefined
if (askpassMode) {
  void runAskpassClient(process.argv.slice(1), process.env).then(
    (code) => app.exit(code),
    () => app.exit(1)
  )
}

// Tests point the app at a throwaway profile so runs cannot affect each other
// or the real one.
const userDataOverride = process.env['QCLOD_USER_DATA']
if (userDataOverride && !askpassMode) app.setPath('userData', userDataOverride)

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
const gotLock = askpassMode ? false : claimSingleInstance(app, () => {
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
// Fake microphone for e2e (stage 5): Chromium plays a WAV file instead of a device.
if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_MIC']) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env['QCLOD_FAKE_MIC'] + '%noloop')
}

app.on('web-contents-created', (_e, contents) => {
  hardenWebContents(contents)
})

if (gotLock) void app.whenReady().then(async () => {
  // No default menu on Windows: its accelerators (Close Window, Reload) would fight ours.
  // A Mac has to have one (Правка brings ⌘C/⌘V to the fields), without Close and Reload.
  const appMenu = appMenuTemplate(process.platform, {
    version: app.getVersion(),
    onAction: (id) => {
      showWindow()
      send(CHANNELS.appAction, id)
    }
  })
  Menu.setApplicationMenu(appMenu ? Menu.buildFromTemplate(appMenu) : null)
  // Started from Finder or the Dock, a Mac app has launchd's bare PATH: Claude Code in
  // ~/.local/bin would not be found. The login shell knows the person's real one.
  if (process.platform === 'darwin') {
    const home = homedir()
    process.env['PATH'] = mergePath(process.env['PATH'] ?? '', await loginShellPath({ home }), home)
  }
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
  // Server files downloaded to open with a program (stage 6).
  cleanupRemoteFiles(userData)
  setInterval(() => cleanupRemoteFiles(userData), 60 * 60 * 1000).unref()

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
    saveRules: (rules) => {
      saveRules(userData, rules)
      // The servers' relays answer by the same rules (stage 6).
      void hosts?.syncSettings()
    },
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

  // — stage 6: servers over SSH. ssh's questions go to the window (askpass), the
  // servers and their relays are HostManager's; a server chat's driver is the relay's.
  const promptBroker = new SshPromptBroker((prompt) => {
    const win = mainWindow
    if (!win || win.isDestroyed() || offScreen) return false
    showWindow()
    send(CHANNELS.serversPrompt, prompt)
    return true
  })
  const hostStore = new HostStore(userData, electronSecretBox())
  const askpass = new AskpassServer({
    platform: process.platform,
    execPath: process.execPath,
    userData,
    ask: (prompt) => promptBroker.ask(prompt),
    storedPassword: (hostId) => hostStore.password(hostId),
    onRemember: (hostId, password) => hosts?.rememberPassword(hostId, password),
    canRemember: () => hostStore.canStorePasswords(),
    askpassScript: join(__dirname, 'askpass.js'),
    log: (line) => console.log('[ssh]', line)
  })
  const askpassUp = askpass.start().catch((err: unknown) => {
    console.warn('[askpass]', err instanceof Error ? err.message : String(err))
  })
  setSshContext({
    sshPath: findSsh(),
    platform: process.platform,
    userData,
    ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {}),
    askpass
  })
  try {
    hostStore.mergeConfigHosts(readUserConfigHosts())
  } catch (err) {
    console.warn('[ssh config]', err instanceof Error ? err.message : String(err))
  }
  /** The hashes of the relay this version installs (build/relay-manifest.json, сверка F3); none in a dev run. */
  const relayManifest = ((): RelayManifest | null => {
    const file = app.isPackaged ? join(process.resourcesPath, 'relay-manifest.json') : join(app.getAppPath(), 'build', 'relay-manifest.json')
    try {
      if (!existsSync(file)) return null
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as RelayManifest
      return parsed.assets?.x64 && parsed.assets?.arm64 ? parsed : null
    } catch {
      return null
    }
  })()
  const targetOf = (e: ServerEntry) => ({
    target: e.target,
    ...(e.port !== undefined ? { port: e.port } : {}),
    ...(e.identityFile ? { identityFile: e.identityFile } : {})
  })
  let hosts: HostManager | undefined
  const relayDriverFactory = async (options: Parameters<typeof createRelayDriver>[0]) => {
    const server = options.server!
    await askpassUp
    const client = (await hosts!.client(server.hostId)) as unknown as RelayClient
    return createRelayDriver(options, {
      client,
      ...(server.relaySessionId ? { relaySessionId: server.relaySessionId } : {}),
      onSessionId: () => undefined
    })
  }

  const manager = new AgentSessionManager({
    getAgentPath: () => settings.agentPath,
    createDriver: createDriverFactory({ relay: relayDriverFactory }),
    onAlert: (id, text) => {
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
    serverHistory: (cwd, hostId) => serverHistory(cwd, hostId),
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
  // on the first press. The models live in userData (or a path sherpa can read,
  // voice/modelsRoot.ts) and come over the system's proxy (net.fetch).
  const modelStore = new ModelStore({
    root: modelsRoot(userData),
    fetch: net.fetch as unknown as typeof fetch,
    platform: process.platform,
    freeBytes,
    extractZip,
    nvidia: nvidiaOnce(),
    // Whisper's server needs the VC++ runtime from System32 (I4); asked each time — the person may install it.
    vcRuntime: () => vcRuntimeReady(process.env['SystemRoot'] ?? 'C:\\Windows')
  })
  const micAccess = (): 'granted' | 'denied' | 'unknown' => micAccessStatus(systemPreferences)
  const voiceHost = new VoiceHost({
    fork: forkVoiceWorker,
    pathsFor: (id) => modelStore.paths(id),
    settings: () => settings.voice,
    micAccess,
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
    store: {
      snapshot: () => modelStore.snapshot(),
      download: (id) => modelStore.download(id),
      cancel: (id) => modelStore.cancel(id),
      // The voice process lets the model's files go first (I3): a recording on it ends,
      // the process exits and the Whisper server is killed; another model's process stays.
      remove: (id) => modelStore.remove(id, () => voiceHost.release(id))
    },
    isOurWindow: (id) => mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.webContents.id === id,
    micAccess,
    openMicSettings: () =>
      openMicSettings(process.platform, async (url) => {
        // e2e records the page instead of opening Windows' settings (buildFlags.d.ts).
        if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
          const g = globalThis as { __qclodShellLog?: unknown[] }
          ;(g.__qclodShellLog ??= []).push({ action: 'mic-settings', path: url })
          return
        }
        await shell.openExternal(url)
      }),
    openVcRedist: async () => {
      if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
        const g = globalThis as { __qclodShellLog?: unknown[] }
        ;(g.__qclodShellLog ??= []).push({ action: 'vc-redist', path: VC_REDIST_URL })
        return
      }
      await shell.openExternal(VC_REDIST_URL)
    }
  })
  modelStore.onChange(() => {
    void voiceSnapshot(modelStore, micAccess).then((s) => send(CHANNELS.voiceModelsChanged, s))
  })

  hosts = new HostManager({
    store: hostStore,
    askpass,
    userData,
    appVersion: app.getVersion(),
    manifest: relayManifest,
    onChanged: (views) => send(CHANNELS.serversChanged, views),
    onProgress: (hostId, steps) => send(CHANNELS.serversConnectProgress, { hostId, steps }),
    openTab: (cwd, server) => controller.create(cwd, { ...settings.defaults }, undefined, undefined, server),
    rules: () => broker.rules(),
    autoAnswerMs,
    makeClient: (entry) =>
      new RelayClient({
        hostId: entry.id,
        appVersion: app.getVersion(),
        clientName: `Qclod ${process.platform} ${hostname()}`,
        transport: sshTransport(targetOf(entry), entry.id, askpass)
      }),
    ...(__QCLOD_TEST_SEAMS__ && process.env['QCLOD_RELAY_BINARY_DIR']
      ? { localRelayDir: process.env['QCLOD_RELAY_BINARY_DIR'] }
      : {}),
    log: (line) => console.log('[servers]', line)
  })
  const serverHosts = hosts
  // node-pty, loaded with the first terminal; a build without it falls back to plain pipes for the login.
  let ptySpawn: TerminalSpawn | null = null
  const loadPty = async (): Promise<TerminalSpawn | null> => {
    if (ptySpawn) return ptySpawn
    try {
      ptySpawn = await nodePtySpawn()
    } catch (err) {
      console.warn('[terminal] node-pty', err instanceof Error ? err.message : String(err))
    }
    return ptySpawn
  }
  // The server's terminal (task 26): a drawer under a server chat, ssh -tt in node-pty.
  const terminals = new TerminalHub({
    spawnPty: (file, args, o) => {
      if (!ptySpawn) throw new Error('node-pty не загружен')
      return ptySpawn(file, args, o)
    },
    send,
    sshPath: findSsh(),
    platform: process.platform,
    userData,
    ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {})
  })
  registerTerminalIpc({
    hub: terminals,
    open: async (tabId, size) => {
      const tab = controller.list().find((t) => t.id === tabId)
      if (!tab) return null
      if (!(await loadPty())) return null
      // e2e: a local shell in place of ssh; a release build has no such branch (buildFlags.d.ts).
      if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_E2E_TERMINAL']) {
        const shell = process.platform === 'win32' ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh'
        return terminals.start(tabId, shell, [], size, process.env)
      }
      const entry = tab.server ? hostStore.get(tab.server.hostId) : null
      if (!tab.server || !entry) return null
      await askpassUp
      // A saved password goes by itself; otherwise ssh's question comes to the window (SshPromptDialog).
      const ask = askpass.forSpawn(tab.server.hostId, { interactive: true })
      return terminals.open(tabId, targetOf(entry), tab.cwd, ask.env, size, () => ask.done())
    }
  })
  // «Войти» of a server's Claude account (task 23): ssh -tt … claude auth login, one per server.
  const logins = new Map<string, ServerLogin>()
  const startServerLogin = async (hostId: string): Promise<void> => {
    const entry = hostStore.get(hostId)
    if (!entry) return
    await askpassUp
    const view = serverHosts.list().find((v) => v.id === hostId)
    const claude = serverHosts.probeOf(hostId)?.claudePath ?? view?.account?.claudePath ?? 'claude'
    logins.get(hostId)?.cancel()
    const ask = askpass.forSpawn(hostId, { interactive: true })
    // A real terminal when node-pty is there (task 26), else ssh -tt over pipes.
    const pty = await loadPty()
    const login = new ServerLogin({
      spawnPty: pty ? (file, args, o) => pty(file, args, { ...o, name: 'xterm-256color' }) : pipePty,
      onProgress: (p) => {
        send(CHANNELS.serversLoginProgress, { hostId, ...p })
        if (p.state === 'done' || p.state === 'failed') ask.done()
      },
      recheck: async () =>
        (await serverHosts.refreshAccount(hostId)) ?? { loggedIn: null, claudePath: null, claudeVersion: null },
      sshPath: findSsh(),
      platform: process.platform,
      userData,
      ...(typeof process.getuid === 'function' ? { uid: process.getuid() } : {})
    })
    logins.set(hostId, login)
    login.start(targetOf(entry), claude, ask.env)
  }
  registerServerIpc({
    hosts: serverHosts,
    askpassAnswers: (answer) => promptBroker.answer(answer),
    login: { start: startServerLogin, code: (hostId, code) => logins.get(hostId)?.sendCode(code) }
  })
  /** A server project's past conversations: the relay's list (сверка F21). */
  async function serverHistory(cwd: string, hostId: string): Promise<SessionSummary[]> {
    const client = await serverHosts.client(hostId)
    return client.call<SessionSummary[]>('history.list', { cwd })
  }

  registerBaseIpc({
    getWindow: () => mainWindow,
    getSettings: () => settings,
    setSettings: (patch) => {
      const previousHotkey = settings.globalHotkey
      const previousLogin = settings.openAtLogin
      const previousVoiceModel = settings.voice.model
      const previousAnswer = settings.autoAnswerMinutes
      settings = mergeDefaults(settings, patch)
      saveSettings(userData, settings)
      // The relays count the same minutes (stage 6).
      if (settings.autoAnswerMinutes !== previousAnswer) void serverHosts.syncSettings()
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
    serverHistory,
    knownServer: (hostId) => hostStore.get(hostId) !== null,
    serverClient: (hostId) => serverHosts.client(hostId),
    onTabClosed: (id) => terminals.closeTab(id),
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
  // A Mac build only tells that a newer release exists (no signing, so no auto-update).
  // The e2e build can stand GitHub in with QCLOD_FAKE_UPDATE `{ available: '9.9.9' }`.
  const fakeAvailable = __QCLOD_TEST_SEAMS__ ? parseFakeAvailable(process.env['QCLOD_FAKE_UPDATE']) : null
  const macNotifier =
    process.platform === 'darwin' && (app.isPackaged || fakeAvailable !== null)
      ? new MacUpdateNotifier({
          fetchJson: fakeAvailable
            ? async () => ({
                tag_name: `v${fakeAvailable}`,
                html_url: `https://github.com/SOJuse/qclod/releases/tag/v${fakeAvailable}`
              })
            : async (url) => {
                const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                return res.json()
              },
          currentVersion: app.getVersion(),
          onState: (state) => send(CHANNELS.updateChanged, state),
          log: (message) => console.warn('[update]', message)
        })
      : null
  ipcMain.handle(CHANNELS.updateGet, () => macNotifier?.state ?? updates?.state ?? { kind: 'idle' })
  ipcMain.handle(CHANNELS.updateRestart, () => {
    const ready = updates?.state.kind === 'ready'
    if (ready) quitReason.markInterrupted()
    return updates?.restart() ?? false
  })

  // Microphone: audio for our own window only (voice/micAccess.ts); before the window exists.
  installMediaPermissions(session.defaultSession, (wc) => !!wc && wc === mainWindow?.webContents)
  // The page that recorded is gone (a reload, a crash, a closed window, M8): its
  // recording stops, so the microphone's last sound is not decoded for nobody for ever.
  const endVoiceWithPage = (win: BrowserWindow): void => {
    const contents = win.webContents
    const owner = contents.id
    contents.on('render-process-gone', () => voiceHost.endOwner(owner))
    contents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) voiceHost.endOwner(owner)
    })
    contents.on('destroyed', () => voiceHost.endOwner(owner))
  }

  mainWindow = createMainWindow()
  watchWindow(mainWindow, (e) => errorLog.write(e))
  endVoiceWithPage(mainWindow)
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
    // The red button on a Mac hides the window, closeToTray or not; ⌘Q quits.
    if (quitting || headless || (process.platform !== 'darwin' && !settings.closeToTray)) return
    event.preventDefault()
    mainWindow?.hide()
  })

  if (!headless) hotkey.apply(settings.globalHotkey)

  mainWindow.webContents.once('did-finish-load', () => {
    void controller.restore()
    tray?.rebuild()
    updates?.start(updateSource?.firstCheckMs)
    macNotifier?.start(fakeAvailable ? 0 : undefined)
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
    promptBroker.cancelAll()
    // A server chat's agent goes on there: it is let go of, not stopped (Review Focus 3).
    void controller
      .disposeAll()
      .finally(() => {
        terminals.closeAll()
        serverHosts.closeAll()
        return askpass.stop()
      })
      .finally(() => app.quit())
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    keepAwake.dispose()
  })

  app.on('activate', () => {
    // The Dock icon brings back a hidden window, or makes one when there is none.
    if (mainWindow && !mainWindow.isDestroyed()) showWindow()
    else if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      watchWindow(mainWindow, (e) => errorLog.write(e))
      endVoiceWithPage(mainWindow)
      loadRenderer(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  // A Mac app stays in the Dock with no windows.
  if (process.platform !== 'darwin') app.quit()
})
