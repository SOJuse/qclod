import type { LaunchOverrides, PermissionAnswer, PermissionRequest, TabId, TabServer } from '../../shared/types'
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
  /** Stage 6: a server chat's relay asks for a system notification. */
  onAlert?: (tabId: TabId, text: string) => void
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
  /** `server` (stage 6): the chat runs on that server, through its relay. */
  create(tabId: TabId, cwd: string, overrides: LaunchOverrides, seed?: SessionSeed, server?: TabServer): AgentSession {
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
      ...(seed ? { seed } : {}),
      ...(server ? { server: { ...server } } : {}),
      ...(this.options.onAlert ? { onAlert: (text: string) => this.options.onAlert!(tabId, text) } : {})
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

  /** `detachOnly` (stage 6): a server chat's agent is let go of, not stopped. */
  async close(tabId: TabId, opts?: { detachOnly?: boolean }): Promise<void> {
    const session = this.sessions.get(tabId)
    if (!session) return
    this.sessions.delete(tabId)
    this.options.onClosed?.(tabId)
    await (opts ? session.dispose(opts) : session.dispose())
  }

  /**
   * Quitting: `detachOnly` lets go of the server chats' agents, which go on
   * there (Review Focus 3); local ones stop as always.
   */
  async disposeAll(opts?: { detachOnly?: boolean }): Promise<void> {
    const all = [...this.sessions.entries()]
    this.sessions.clear()
    for (const [tabId] of all) this.options.onClosed?.(tabId)
    await Promise.all(all.map(([, session]) => (opts ? session.dispose(opts) : session.dispose())))
  }
}
