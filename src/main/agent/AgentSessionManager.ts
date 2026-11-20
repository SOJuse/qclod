import type { LaunchOverrides, PermissionAnswer, PermissionRequest, TabId } from '../../shared/types'
import { AgentSession, type SessionSeed } from './AgentSession'
import type { DriverFactory } from './driver'

export interface AgentSessionManagerOptions {
  /** Read on every create, so the setting can change without a restart. */
  getAgentPath: () => string
  resolveAgent?: (requested: string) => string
  createDriver: DriverFactory
  askPermission: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>
  confirmBypass?: () => Promise<boolean>
  confirmAutoAllow?: () => Promise<boolean>
  disposeTimeoutMs?: number
  /** The «авто-да» timer's minutes from the settings, read when its line is shown. */
  autoAnswerMinutes?: () => number
  /**
   * A tab's session was closed: «Начать заново», «Закрыть чат», a restart
   * after a crash, or the app quitting. What was allowed «до конца сессии»
   * ends here.
   */
  onClosed?: (tabId: TabId) => void
}

/**
 * One session per tab, and never two.
 *
 * Tabs come and go while sessions hold a child process; the manager is the
 * single place that knows which is which, so closing one tab can never take
 * another one's agent down with it.
 */
export class AgentSessionManager {
  private readonly sessions = new Map<TabId, AgentSession>()

  constructor(private readonly options: AgentSessionManagerOptions) {}

  /** `seed`: what the tab already shows, for the session to carry on from. */
  create(tabId: TabId, cwd: string, overrides: LaunchOverrides, seed?: SessionSeed): AgentSession {
    const existing = this.sessions.get(tabId)
    if (existing) return existing

    const session = new AgentSession({
      tabId,
      cwd,
      overrides,
      agentPath: this.options.getAgentPath(),
      ...(this.options.resolveAgent ? { resolveAgent: this.options.resolveAgent } : {}),
      createDriver: this.options.createDriver,
      askPermission: this.options.askPermission,
      ...(this.options.confirmBypass ? { confirmBypass: this.options.confirmBypass } : {}),
      ...(this.options.confirmAutoAllow ? { confirmAutoAllow: this.options.confirmAutoAllow } : {}),
      ...(this.options.autoAnswerMinutes ? { autoAnswerMinutes: this.options.autoAnswerMinutes } : {}),
      ...(this.options.disposeTimeoutMs === undefined
        ? {}
        : { disposeTimeoutMs: this.options.disposeTimeoutMs }),
      ...(seed ? { seed } : {})
    })
    this.sessions.set(tabId, session)
    return session
  }

  get(tabId: TabId): AgentSession | undefined {
    return this.sessions.get(tabId)
  }

  list(): Array<[TabId, AgentSession]> {
    return [...this.sessions.entries()]
  }

  async close(tabId: TabId): Promise<void> {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    this.options.onClosed?.(tabId)
    await session.dispose()
  }

  async disposeAll(): Promise<void> {
    const all = [...this.sessions.entries()]
    this.sessions.clear()
    for (const [tabId] of all) this.options.onClosed?.(tabId)
    await Promise.all(all.map(([, session]) => session.dispose()))
  }
}
