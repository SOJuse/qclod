import { app, ipcMain, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { CHANNELS } from '../../shared/channels'
import type { AppSettings, TabId } from '../../shared/types'
import { SessionManager } from './SessionManager'
import { AgentNotFoundError } from './resolveExecutable'
import type { Session } from './Session'

export const IMPLICIT_TAB_ID = 'default'

export interface SessionWiring {
  manager: SessionManager
  startTab(tabId: TabId, cwd: string): Session
  disposeAll(): Promise<void>
}

/**
 * Tests substitute the fake agent through the environment, so the e2e suite
 * never launches the real CLI (Global Constraints).
 */
function agentFromEnv(settings: AppSettings): { path: string; prefixArgs: string[] } {
  const path = process.env['QCLOD_AGENT_PATH']
  const prefix = process.env['QCLOD_AGENT_PREFIX_ARGS']
  return {
    path: path && path.trim() !== '' ? path : settings.agentPath,
    prefixArgs: prefix ? JSON.parse(prefix) : []
  }
}

export function wireSessions(
  getWindow: () => BrowserWindow | null,
  getSettings: () => AppSettings,
  getUserHooks: () => unknown,
  pipePath: string
): SessionWiring {
  const resolved = agentFromEnv(getSettings())

  const manager = new SessionManager({
    getSettings: () => ({ ...getSettings(), agentPath: resolved.path }),
    getUserHooks,
    pipePath,
    prefixArgs: resolved.prefixArgs
  })

  function send(channel: string, payload: unknown): void {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  function startTab(tabId: TabId, cwd: string): Session {
    const session = manager.create(tabId, cwd, {})
    session.onData((chunk) => send(CHANNELS.sessionData, { tabId, chunk }))
    session.onExit((code) => send(CHANNELS.sessionExit, { tabId, code }))
    try {
      session.start()
    } catch (error) {
      const message =
        error instanceof AgentNotFoundError ? error.message : `Не удалось запустить агента: ${error}`
      send(CHANNELS.sessionExit, { tabId, code: -1, error: message })
    }
    return session
  }

  ipcMain.handle(CHANNELS.sessionWrite, (_e, tabId: TabId, data: string) => {
    manager.get(tabId)?.write(data)
  })

  ipcMain.handle(CHANNELS.sessionResize, (_e, tabId: TabId, cols: number, rows: number) => {
    manager.get(tabId)?.resize(cols, rows)
  })

  ipcMain.handle(CHANNELS.sessionRestart, async (_e, tabId: TabId) => {
    const existing = manager.get(tabId)
    const cwd = existing?.cwd ?? homedir()
    await manager.close(tabId)
    startTab(tabId, cwd)
  })

  // Quitting must never leave an agent process behind (Review Focus 4).
  app.on('before-quit', (event) => {
    if (manager.list().length === 0) return
    event.preventDefault()
    void manager.disposeAll().then(() => app.exit(0))
  })

  return { manager, startTab, disposeAll: () => manager.disposeAll() }
}
