import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  CommandInfo,
  LaunchOverrides,
  PanelEvent,
  RibbonEvent,
  RibbonItem,
  SessionStatus,
  SessionSummary,
  StatusEvent,
  TabId,
  TabState
} from '../../shared/types'
import { isDirectory, loadTabs, saveTabs, type LoadedTab } from '../store/tabsStore'
import type { AgentSession } from '../agent/AgentSession'
import type { AgentSessionManager } from '../agent/AgentSessionManager'

export interface TabHistory {
  list: (cwd: string) => Promise<SessionSummary[]>
  /** A past conversation, read from its transcript in the folder it ran in. */
  transcript: (sessionId: string, cwd: string) => Promise<unknown[]>
}

export interface TabControllerDeps {
  manager: AgentSessionManager
  storeDir: string
  /** Where a tab lands when nothing else is known. */
  defaultCwd: string
  /** Launch options a new tab starts with, from settings. */
  getDefaults: () => LaunchOverrides
  history: TabHistory
  onChanged: (tabs: TabState[]) => void
  onRibbon: (event: RibbonEvent) => void
  onPanel: (event: PanelEvent) => void
  onStatus: (event: StatusEvent) => void
  onCommands: (event: { tabId: TabId; commands: CommandInfo[] }) => void
}

/**
 * Owns the list of tabs and keeps each one's agent in step with it.
 *
 * Two decisions from the spec live here. Only the active tab starts its agent
 * (6.12) — starting every restored tab's would spawn a process per tab at
 * launch, which is what made v1 feel heavy. And a tab remembers which
 * conversation it was in, so reopening the app picks it back up instead of
 * losing it (6.9); what is remembered is the id, never the words.
 */
export class TabController {
  private tabs: TabState[] = []
  private activeId: TabId | null = null
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lastStatus = new Map<TabId, SessionStatus>()

  constructor(private readonly deps: TabControllerDeps) {}

  list(): TabState[] {
    return this.tabs.map((tab) => ({ ...tab }))
  }

  get activeTabId(): TabId | null {
    return this.activeId
  }

  itemsOf(id: TabId): RibbonItem[] {
    return this.deps.manager.get(id)?.items ?? []
  }

  sessionIdOf(id: TabId): string | null {
    return this.deps.manager.get(id)?.sessionId ?? null
  }

  /** Lets a caller — a test, or shutdown — wait for in-flight starts. */
  async whenSettled(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]).catch(() => undefined)
    }
    for (const tab of this.tabs) {
      await this.deps.manager.get(tab.id)?.whenIdle()
    }
  }

  async restore(): Promise<TabState[]> {
    const stored: LoadedTab[] = loadTabs(this.deps.storeDir)
    if (stored.length === 0) {
      this.create(this.deps.defaultCwd)
      return this.list()
    }

    for (const tab of stored) {
      this.tabs.push({
        id: tab.id,
        cwd: tab.cwd,
        title: tab.title,
        overrides: tab.overrides,
        ...(tab.lastSessionId ? { lastSessionId: tab.lastSessionId } : {}),
        status: 'stopped',
        badge: false,
        missingCwd: tab.missingCwd
      })
    }

    this.activeId = this.tabs[0]?.id ?? null
    this.emit()
    if (this.activeId) this.track(this.ensureSession(this.activeId))
    return this.list()
  }

  create(
    cwd: string,
    overrides: LaunchOverrides = this.deps.getDefaults(),
    title?: string,
    /** A conversation to continue, set before the session is ever started. */
    lastSessionId?: string
  ): TabState {
    const tab: TabState = {
      id: randomUUID(),
      cwd,
      title: title ?? basename(cwd) ?? cwd,
      overrides,
      ...(lastSessionId ? { lastSessionId } : {}),
      status: 'stopped',
      badge: false,
      missingCwd: !isDirectory(cwd)
    }
    this.tabs.push(tab)
    this.activeId = tab.id
    this.persist()
    this.emit()
    this.track(this.ensureSession(tab.id))
    return { ...tab }
  }

  /**
   * Opens a past conversation in its own tab.
   *
   * The tab is created already pointing at that session, so the usual resume
   * path brings the ribbon back — there is no second way to load a
   * conversation that could drift from the first.
   */
  openHistory(cwd: string, sessionId: string, title?: string): TabState {
    // The pointer is set as the tab is made, so the one session it starts is
    // already the right one. Creating a tab and then swapping its session
    // leaves the first one running: an orphan agent whose own init overwrites
    // the stored id with a throwaway.
    return this.create(cwd, {}, title, sessionId)
  }

  async activate(id: TabId): Promise<void> {
    if (!this.tabs.some((tab) => tab.id === id)) return
    this.activeId = id
    this.patch(id, { badge: false })
    // A background tab's agent comes up the moment the user looks at it.
    await this.ensureSession(id)
  }

  async close(id: TabId): Promise<void> {
    const index = this.tabs.findIndex((tab) => tab.id === id)
    if (index === -1) return
    this.tabs.splice(index, 1)
    await this.deps.manager.close(id)

    if (this.activeId === id) {
      this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
    }
    // Never leave the window with nothing in it.
    if (this.tabs.length === 0) this.create(this.deps.defaultCwd)
    else {
      this.persist()
      this.emit()
    }
  }

  async restart(id: TabId): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    await this.deps.manager.close(id)
    delete tab.lastSessionId
    await this.ensureSession(id)
  }

  /** Records a launch option the user changed while the tab was running. */
  rememberOverride(id: TabId, patch: LaunchOverrides): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    tab.overrides = { ...tab.overrides, ...patch }
    this.persist()
    this.emit()
  }

  update(id: TabId, patch: Partial<TabState>): TabState | undefined {
    const tab = this.patch(id, patch)
    if (tab) this.persist()
    return tab
  }

  /** Past conversations of this tab's folder, for the history screen (Task 14). */
  async history(id: TabId): Promise<SessionSummary[]> {
    const tab = this.tabs.find((t) => t.id === id)
    return tab ? this.deps.history.list(tab.cwd) : []
  }

  async disposeAll(): Promise<void> {
    await this.deps.manager.disposeAll()
  }

  // ------------------------------------------------------------- sessions

  private async ensureSession(id: TabId): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    // A folder that is gone cannot host an agent; the tab stays, flagged, so
    // the user can see what happened and pick a new folder.
    if (tab.missingCwd) return
    if (this.deps.manager.get(id)) return

    // Defaults first, the tab's own choices on top: a tab stored before a
    // setting existed still follows it, and a tab that picked its own mode
    // keeps it.
    const session = this.deps.manager.create(id, tab.cwd, {
      ...this.deps.getDefaults(),
      ...tab.overrides
    })
    this.wire(id, session)

    const resumeId = tab.lastSessionId
    if (resumeId) await this.resume(id, session, resumeId, tab.cwd)
    else await session.start()

    this.rememberSession(id, session)
  }

  /**
   * Picks a conversation back up. A session that will not open — deleted,
   * moved, written by a newer CLI — must not cost the user their tab: they get
   * a clean one and a line in the ribbon saying what happened.
   */
  private async resume(id: TabId, session: AgentSession, resumeId: string, cwd: string): Promise<void> {
    await session.start(resumeId)

    // The conversation is read from the CLI's own transcript on disk, so it
    // can be shown at once. Waiting for the session to settle first — which
    // is what this did — left the tab blank: a resumed CLI sends nothing at
    // all, not even `system/init`, until it is given something to answer. The
    // conversation only appeared after you typed, and whatever you typed was
    // the thing that unblocked it. The file is read whole (before the last
    // compaction too, subagent steps included) and found by the tab's folder.
    const messages = await this.deps.history.transcript(resumeId, cwd)
    if (messages.length > 0) this.emitRibbon(id, session.replay(messages))

    // A resume that will not open fails while the stream runs, long after
    // start() returned, so the recovery waits for that rather than for a
    // status that is still «starting».
    void session.whenIdle().then(() => {
      if (session.status === 'error') void this.recoverFromDeadSession(id, session)
    })
  }

  /** The stored conversation would not open: give the tab a clean session. */
  private async recoverFromDeadSession(id: TabId, dead: AgentSession): Promise<void> {
    if (this.deps.manager.get(id) !== dead) return
    const reason = dead.error ?? 'неизвестная причина'
    const tab = this.tabs.find((t) => t.id === id)
    if (tab) delete tab.lastSessionId

    await this.deps.manager.close(id)
    const fresh = this.deps.manager.create(
      id,
      tab?.cwd ?? this.deps.defaultCwd,
      tab?.overrides ?? {}
    )
    this.wire(id, fresh)
    this.emitRibbon(id, fresh.notice(`Прошлую переписку открыть не удалось: ${reason}`))
    await fresh.start()
    this.rememberSession(id, fresh)
  }

  private wire(id: TabId, session: AgentSession): void {
    session.onChange((changes) => this.deps.onRibbon({ tabId: id, changes }))
    session.onPanel((patch) => this.deps.onPanel({ tabId: id, patch }))
    session.onCommands((commands) => this.deps.onCommands({ tabId: id, commands }))
    session.onSession(() => this.rememberSession(id, session))
    session.onStatus((status) => {
      const patch: Partial<TabState> = { status }
      if (session.error !== undefined) patch.error = session.error
      if (status === 'waiting' || status === 'idle') {
        if (this.activeId !== id) patch.badge = true
      }
      const was = this.lastStatus.get(id)
      this.lastStatus.set(id, status)

      this.patch(id, patch)
      this.rememberSession(id, session)
      const event: StatusEvent = { tabId: id, status }
      // Only a turn that ran and ended counts as finished.
      if (status === 'idle' && (was === 'busy' || was === 'waiting')) event.finished = true
      if (session.error !== undefined) event.error = session.error
      this.deps.onStatus(event)
    })
  }

  private rememberSession(id: TabId, session: AgentSession): void {
    const sessionId = session.sessionId
    if (!sessionId) return
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab || tab.lastSessionId === sessionId) return
    tab.lastSessionId = sessionId
    this.persist()
    this.emit()
  }

  // -------------------------------------------------------------- plumbing

  private emitRibbon(id: TabId, changes: ReturnType<AgentSession['notice']>): void {
    if (changes.length > 0) this.deps.onRibbon({ tabId: id, changes })
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
  }

  private patch(id: TabId, patch: Partial<TabState>): TabState | undefined {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return undefined
    Object.assign(tab, patch)
    this.emit()
    return { ...tab }
  }

  private persist(): void {
    saveTabs(
      this.deps.storeDir,
      this.tabs.map((tab) => ({
        id: tab.id,
        cwd: tab.cwd,
        title: tab.title,
        overrides: tab.overrides,
        ...(tab.lastSessionId ? { lastSessionId: tab.lastSessionId } : {})
      }))
    )
  }

  private emit(): void {
    this.deps.onChanged(this.list())
  }
}
