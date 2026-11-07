import { app, clipboard, dialog, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { CHANNELS } from '../../shared/channels'
import type { AppSettings, TabId, TabState } from '../../shared/types'
import { SessionManager } from './SessionManager'
import { TabController } from '../tabs/TabController'
import { sanitizeOverrides, sanitizeTabPatch } from '../tabs/sanitize'
import { buildFileIndex } from '../files/fileIndex'
import { cleanupPasteDir, saveImageBuffer } from '../files/imagePaste'
import { startHookServer, type HookServer } from './hookServer'
import { unpackedPath, writeHookLauncher } from './hookLauncher'
import { BUSY_TIMEOUT_MS, reduceStatus, mayNotify, type StatusState } from './sessionStatus'

export interface SessionWiring {
  manager: SessionManager
  tabs: TabController
  startHooks: () => Promise<void>
  disposeAll: () => Promise<void>
}

const CARRIAGE_RETURN = String.fromCharCode(13)

export type NotifyFn = (tabId: TabId, state: StatusState, tabTitle: string) => void

/**
 * Tests substitute the fake agent through the environment, so the e2e suite
 * never launches the real CLI (Global Constraints).
 */
function agentFromEnv(settings: AppSettings): { path: string; prefixArgs: string[] } {
  const path = process.env['QCLOD_AGENT_PATH']
  const prefix = process.env['QCLOD_AGENT_PREFIX_ARGS']
  return {
    path: path && path.trim() !== '' ? path : settings.agentPath,
    prefixArgs: prefix ? (JSON.parse(prefix) as string[]) : []
  }
}

export function wireSessions(
  getWindow: () => BrowserWindow | null,
  getSettings: () => AppSettings,
  getUserHooks: () => unknown,
  pipePath: string,
  storeDir: string,
  defaultCwd: string,
  notify: NotifyFn = () => undefined
): SessionWiring {
  const resolved = agentFromEnv(getSettings())

  const hookLauncher = writeHookLauncher(
    storeDir,
    process.execPath,
    unpackedPath(join(app.getAppPath(), 'bin', 'qclod-hook.js'))
  )

  const manager = new SessionManager({
    getSettings: () => ({ ...getSettings(), agentPath: resolved.path }),
    getUserHooks,
    pipePath,
    prefixArgs: resolved.prefixArgs,
    hookHelper: hookLauncher
  })

  function send(channel: string, payload: unknown): void {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  const tabs = new TabController({
    manager,
    storeDir,
    defaultCwd,
    onData: (tabId, chunk) => send(CHANNELS.sessionData, { tabId, chunk }),
    onExit: (tabId, code) => send(CHANNELS.sessionExit, { tabId, code }),
    onChanged: (list: TabState[]) => send(CHANNELS.tabsChanged, list)
  })

  // ---- per-tab status, driven by hooks (spec 6.9) ----
  const statuses = new Map<TabId, StatusState>()
  const timers = new Map<TabId, ReturnType<typeof setTimeout>>()

  function applyStatus(tabId: TabId, input: Parameters<typeof reduceStatus>[1]): void {
    const current = statuses.get(tabId) ?? { status: 'idle' as const, degraded: false }
    const next = reduceStatus(current, input)
    if (next.status === current.status && next.degraded === current.degraded) return

    statuses.set(tabId, next)
    tabs.setStatus(tabId, next.status, next.degraded)
    send(CHANNELS.sessionStatus, { tabId, status: next.status, degraded: next.degraded })

    clearTimeout(timers.get(tabId))
    if (next.status === 'busy') {
      // If no hook arrives in time, fall back to guessing rather than lying.
      timers.set(
        tabId,
        setTimeout(() => applyStatus(tabId, { kind: 'timeout' }), BUSY_TIMEOUT_MS)
      )
    }

    const title = tabs.list().find((t) => t.id === tabId)?.title ?? ''
    if (mayNotify(next)) notify(tabId, next, title)
  }

  let hooks: HookServer | undefined
  async function startHooks(): Promise<void> {
    try {
      hooks = await startHookServer(pipePath, (event) => {
        if (event.tabId) applyStatus(event.tabId, { kind: 'hook', event })
      })
    } catch {
      // Without the pipe every tab simply runs in the degraded mode of 6.9.
    }
  }

  ipcMain.handle(CHANNELS.tabsList, () => tabs.list())
  ipcMain.handle(CHANNELS.tabsCreate, (_e, cwd: unknown, overrides: unknown) =>
    typeof cwd === 'string' && cwd !== '' ? tabs.create(cwd, sanitizeOverrides(overrides)) : null
  )
  ipcMain.handle(CHANNELS.tabsClose, (_e, tabId: TabId) => tabs.close(tabId))
  ipcMain.handle(CHANNELS.tabsActivate, (_e, tabId: TabId) => tabs.activate(tabId))
  ipcMain.handle(CHANNELS.tabsUpdate, (_e, tabId: TabId, patch: unknown) =>
    tabs.update(tabId, sanitizeTabPatch(patch))
  )

  ipcMain.handle(CHANNELS.sessionWrite, (_e, tabId: TabId, data: string) => {
    manager.get(tabId)?.write(data)
    // A submitted line is the one moment we know work started without a hook.
    if (data.includes(CARRIAGE_RETURN)) applyStatus(tabId, { kind: 'sent' })
  })
  ipcMain.handle(CHANNELS.sessionResize, (_e, tabId: TabId, cols: number, rows: number) => {
    manager.get(tabId)?.resize(cols, rows)
  })
  ipcMain.handle(CHANNELS.sessionRestart, (_e, tabId: TabId) => tabs.restart(tabId))

  // Built once per tab and reused: walking a big tree on every keystroke
  // would stall the main process.
  const indexCache = new Map<TabId, string[]>()
  ipcMain.handle(CHANNELS.filesIndex, async (_e, tabId: TabId) => {
    const cached = indexCache.get(tabId)
    if (cached) return cached
    const tab = tabs.list().find((t) => t.id === tabId)
    if (!tab) return []
    const index = await buildFileIndex(tab.cwd)
    indexCache.set(tabId, index)
    return index
  })

  // Screenshot-heavy use would otherwise fill the disk over time.
  cleanupPasteDir(storeDir)

  ipcMain.handle(CHANNELS.clipboardImage, () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    return saveImageBuffer(storeDir, image.toPNG())
  })

  ipcMain.handle(CHANNELS.dialogPickFolder, async () => {
    // Tests cannot click a native dialog, so they name the folder up front.
    const scripted = process.env['QCLOD_PICK_FOLDER']
    if (scripted) return scripted
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // Quitting must never leave an agent process behind (Review Focus 4).
  app.on('before-quit', (event) => {
    if (manager.list().length === 0) return
    event.preventDefault()
    void manager.disposeAll().then(() => app.exit(0))
  })

  return {
    manager,
    tabs,
    startHooks,
    disposeAll: async () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      await hooks?.close()
      await manager.disposeAll()
    }
  }
}
