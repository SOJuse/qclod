import type { AppSettings, LaunchOverrides, TabId } from '../../shared/types'
import { buildHookSettings } from './hookSettings'
import { buildLaunchArgs } from './launchArgs'
import { Session } from './Session'

export interface SessionManagerDeps {
  getSettings: () => AppSettings
  /** The user's own hooks, so ours are merged in rather than written over. */
  getUserHooks: (cwd: string) => unknown
  pipePath: string
  /** Arguments inserted before the agent's own flags. Tests use it to run node. */
  prefixArgs?: string[]
  hookHelper?: string
}

export class SessionManager {
  private readonly sessions = new Map<TabId, Session>()

  constructor(private readonly deps: SessionManagerDeps) {}

  create(tabId: TabId, cwd: string, overrides: LaunchOverrides): Session {
    const existing = this.sessions.get(tabId)
    if (existing) return existing

    const settings = this.deps.getSettings()
    const settingsJson = buildHookSettings(
      tabId,
      this.deps.pipePath,
      this.deps.getUserHooks(cwd),
      this.deps.hookHelper
    )

    const session = new Session({
      tabId,
      cwd,
      file: settings.agentPath,
      args: [
        ...(this.deps.prefixArgs ?? []),
        ...buildLaunchArgs(settings, overrides, settingsJson)
      ]
    })

    this.sessions.set(tabId, session)
    return session
  }

  get(tabId: TabId): Session | undefined {
    return this.sessions.get(tabId)
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  async close(tabId: TabId): Promise<void> {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    await session.dispose()
  }

  /** Quitting must never leave an agent process behind (Review Focus 4). */
  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((s) => s.dispose()))
  }
}
