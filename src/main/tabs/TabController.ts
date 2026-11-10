import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  CommandInfo,
  LaunchOverrides,
  PanelData,
  PanelEvent,
  PanelSnapshot,
  RibbonChange,
  RibbonEvent,
  RibbonItem,
  RibbonSnapshot,
  SessionStatus,
  SessionSummary,
  StatusEvent,
  TabId,
  TabState,
  UserInput
} from '../../shared/types'
import { isDirectory, loadTabs, saveTabs, type LoadedTab } from '../store/tabsStore'
import { MAX_QUEUED, seedFromTranscript, type AgentSession, type SessionSeed } from '../agent/AgentSession'
import { EMPTY_PANEL } from '../agent/panelData'
import { isRemoteLive } from '../../shared/remote'
import { classifyStartFailure } from '../agent/startFailure'
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

let lastRibbonRev = 0

/**
 * The next ribbon revision, shared by every tab and session in the process.
 * A tab's session is replaced on restart or recovery, and a restored tab's
 * preview is taken over by its session: a counter of their own would start
 * again from zero and make the new changes look older than the window's.
 */
function nextRibbonRev(): number {
  lastRibbonRev += 1
  return lastRibbonRev
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
  /**
   * What a restored tab shows before its agent is started: its conversation
   * read from the record. Only for tabs with no session — the session that
   * starts takes the preview over.
   */
  private readonly previews = new Map<TabId, SessionSeed>()
  /** Previews still being read, so a second ask waits for the same read. */
  private readonly previewing = new Map<TabId, Promise<SessionSeed | null>>()
  /**
   * The revision of each tab's last ribbon change. Given when the change is
   * made, not when it is sent, so a snapshot and the events still waiting in
   * the batch can be told apart: whatever the snapshot already holds carries a
   * revision no newer than its own.
   */
  private readonly ribbonRevs = new Map<TabId, number>()
  /** The plan's windows as last reported; they are the account's, not a tab's. */
  private planLimits: PanelData['limits'] | null = null
  /**
   * Tabs whose session is being swapped — restart, retry, recovery — from
   * before the old one closes until the new one is up. While a tab is here
   * the swapper gives it its session: anyone else starting one (a click on
   * the tab) would open the conversation being left, a second time.
   */
  private readonly replacing = new Set<TabId>()
  /**
   * What the user sent while the tab's session was being swapped. The swapper
   * hands it to the new session after the old one's queue (`handOver`).
   */
  private readonly held = new Map<TabId, UserInput[]>()

  constructor(private readonly deps: TabControllerDeps) {}

  list(): TabState[] {
    return this.tabs.map((tab) => ({ ...tab }))
  }

  get activeTabId(): TabId | null {
    return this.activeId
  }

  itemsOf(id: TabId): RibbonItem[] {
    return this.deps.manager.get(id)?.items ?? this.previews.get(id)?.builder.items ?? []
  }

  /**
   * The tab's whole ribbon and the revision it is at, for a window that
   * missed the events — reloaded, or seeing the tab for the first time.
   */
  ribbonOf(id: TabId): RibbonSnapshot {
    const session = this.deps.manager.get(id)
    const todo = session ? session.todo : (this.previews.get(id)?.builder.todo ?? null)
    return { rev: this.ribbonRevs.get(id) ?? 0, items: this.itemsOf(id), todo }
  }

  /**
   * The tab's whole panel, for a window that missed the events — reloaded,
   * or just opened. A tab not started yet reports what its record says.
   */
  panelOf(id: TabId): PanelSnapshot {
    return (
      this.deps.manager.get(id)?.panelSnapshot() ??
      this.previews.get(id)?.collector.snapshot ?? { rev: 0, data: EMPTY_PANEL }
    )
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
    // Every tab shows its conversation straight away, read from the record;
    // only the active one gets a process (spec 9: an agent starts when its
    // tab is first visited).
    for (const tab of this.tabs) this.track(this.preview(tab.id))
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
    this.previews.delete(id)
    this.ribbonRevs.delete(id)
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

  /** «Начать заново»: a new session, and the old conversation is let go. */
  async restart(id: TabId): Promise<void> {
    await this.replaceSession(id, (tab) => {
      // Forgotten on disk now, not when the new session first answers: a
      // launch in between would pick the old conversation back up.
      delete tab.lastSessionId
      this.persist()
      this.emit()
    })
  }

  /**
   * «Повторить»: the session never got to the conversation — no agent, not
   * logged in — so the same conversation is opened again once the cause is
   * fixed. Unlike `restart`, the stored id is kept and resumed — and what
   * the user said to the session that died never reached an agent, so it
   * goes to the new one as it was sent, once (it is on screen already).
   */
  async retry(id: TabId): Promise<void> {
    const unsent = this.deps.manager.get(id)?.sentBeforeInit ?? []
    await this.replaceSession(id, () => undefined, unsent)
  }

  /**
   * Closes the tab's session and starts the next one in its place. The
   * conversation the window shows stays, and the new session's items number
   * on after it — as on recovery from a dead session. A fresh ribbon here
   * would leave the window holding items main no longer has, and new ones
   * under the same ids. `prepare` runs once the old session is gone and
   * before the new one starts. `unsent` and the old session's queue go to
   * the new one (`handOver`).
   */
  private async replaceSession(
    id: TabId,
    prepare: (tab: TabState) => void,
    unsent: UserInput[] = []
  ): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    const old = this.deps.manager.get(id)
    const seed = old?.successorSeed()
    // Taken before the old session goes: closing it would drop the queue.
    const queued = old?.takeQueue() ?? []
    // In place before the old session goes: while it closes the tab has no
    // session, and a snapshot taken then must not come back empty.
    if (seed) this.previews.set(id, seed)
    else this.previews.delete(id)
    this.replacing.add(id)
    try {
      await this.deps.manager.close(id)
      // Closed while the old session was closing: nothing to start.
      if (!this.tabs.includes(tab)) {
        this.previews.delete(id)
        return
      }
      // Someone else has given the tab a session meanwhile: it stays, and
      // takes over what was owed.
      if (!this.deps.manager.get(id)) {
        prepare(tab)
        await this.startSession(id)
      }
      this.handOver(id, this.deps.manager.get(id), unsent, queued)
    } finally {
      this.replacing.delete(id)
      this.held.delete(id)
    }
  }

  /**
   * What a replaced session still owed the user goes to the one taking its
   * place: first what it was given and never got to the agent — on screen
   * already, so sent again without a second bubble — then its queue, which
   * goes one message per turn as before. A message must not vanish because
   * the session under it was swapped (ruling C8).
   */
  private handOver(
    id: TabId,
    fresh: AgentSession | undefined,
    unsent: UserInput[],
    queued: UserInput[]
  ): void {
    const held = this.held.get(id) ?? []
    this.held.delete(id)
    if (!fresh) return
    for (const sent of unsent) fresh.resend(sent)
    fresh.requeue([...queued, ...held])
  }

  /**
   * A message from the user for this tab. While the session is being swapped
   * it is held and goes to the one taking its place; otherwise the session
   * takes it or refuses it. False means it went nowhere, and the window gives
   * it back to the input line.
   */
  send(id: TabId, input: UserInput): boolean {
    if (this.replacing.has(id)) {
      const held = this.held.get(id) ?? []
      if (held.length >= MAX_QUEUED) return false
      held.push(input)
      this.held.set(id, held)
      return true
    }
    return this.deps.manager.get(id)?.send(input) ?? false
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
    // Being swapped: the swapper starts the session.
    if (this.replacing.has(id)) return
    await this.startSession(id)
  }

  private async startSession(id: TabId): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    // A folder that is gone cannot host an agent; the tab stays, flagged, so
    // the user can see what happened and pick a new folder.
    if (tab.missingCwd) return
    if (this.deps.manager.get(id)) return

    // The conversation is already on screen from the record; the session
    // carries on from that same ribbon, so nothing is drawn twice and new
    // items number on after the old ones. A record that cannot be read costs
    // the preview, not the agent.
    const seed = await this.preview(id).catch(() => null)
    // Closed, or started by another call, while the record was read.
    if (!this.tabs.includes(tab) || this.deps.manager.get(id)) return

    const session = this.deps.manager.create(
      id,
      tab.cwd,
      this.launchOptions(tab),
      seed ?? undefined
    )
    this.previews.delete(id)
    this.adopt(id, session)

    const resumeId = tab.lastSessionId
    if (resumeId) await this.resume(id, session, resumeId)
    else await session.start()

    this.rememberSession(id, session)
  }

  /**
   * Reads a tab's past conversation and shows it — ribbon and panel —
   * without starting anything. A resumed CLI sends nothing at all, not even
   * `system/init`, until it is given something to answer, so the record is
   * the only way a restored tab can show anything before it is used. Asked
   * twice, it answers with what it already built.
   */
  private preview(id: TabId): Promise<SessionSeed | null> {
    const built = this.previews.get(id)
    if (built) return Promise.resolve(built)
    const reading = this.previewing.get(id)
    if (reading) return reading
    const work = this.buildPreview(id).finally(() => this.previewing.delete(id))
    this.previewing.set(id, work)
    return work
  }

  private async buildPreview(id: TabId): Promise<SessionSeed | null> {
    const tab = this.tabs.find((t) => t.id === id)
    const sessionId = tab?.lastSessionId
    if (!tab || tab.missingCwd || !sessionId || this.deps.manager.get(id)) return null

    // The file is read whole (before the last compaction too, subagent steps
    // included) and found by the tab's folder.
    const messages = await this.deps.history.transcript(sessionId, tab.cwd)
    // The tab may have moved on while the file was read.
    if (!this.tabs.includes(tab) || tab.lastSessionId !== sessionId || this.deps.manager.get(id)) {
      return null
    }

    const seed = seedFromTranscript(messages)
    if (this.planLimits) seed.collector.setLimits(this.planLimits)
    this.previews.set(id, seed)

    const changes: RibbonChange[] = seed.builder.items.map((item) => ({ kind: 'append', item }))
    const todo = seed.builder.todo
    if (todo) changes.push({ kind: 'todo', items: todo })
    this.emitRibbon(id, changes)
    this.emitWholePanel(id, seed.collector.snapshot)
    return seed
  }

  /**
   * Picks a conversation back up. A session that will not open — deleted,
   * moved, written by a newer CLI — must not cost the user their tab: they get
   * a clean one and a line in the ribbon saying what happened.
   */
  private async resume(id: TabId, session: AgentSession, resumeId: string): Promise<void> {
    await session.start(resumeId)
    if (session.status === 'error') {
      // A start that never made a driver — no executable, an SDK that would
      // not load — never reached the conversation: the error stays on screen
      // and the conversation stays remembered.
      if (session.launched) await this.recoverFromDeadSession(id, session)
      return
    }

    // Otherwise the failure comes out of the stream, whenever the CLI gets to
    // it: soon after start, or — since a resumed CLI says nothing until it is
    // spoken to — only once the first message is sent. Waiting for «idle»
    // does not see it: start() is idle before the CLI has tried anything.
    // Until the session introduces itself with init, an error means the
    // conversation did not open; after that it is the session's own.
    const stop = session.onStatus((status) => {
      if (session.sessionId !== null || status === 'stopped') return stop()
      if (status !== 'error') return
      stop()
      this.track(this.recoverFromDeadSession(id, session))
    })
    session.onSession(() => stop())
  }

  /**
   * The stored conversation would not open: give the tab a clean session.
   * The history stays on screen — the new session continues the dead one's
   * ribbon — but the panel starts over: it describes the new session.
   *
   * Except when the agent is not logged in: a clean session would die the
   * same way, so the tab stays as it is, in error, with «Войти» and
   * «Повторить».
   *
   * The stored id is not erased here. It is replaced once the new session
   * introduces itself (`rememberSession`), and not before: an agent that
   * dies before init for reasons of its own — a crash at
   * start — kills the clean session the same way, and then nothing shows
   * the conversation was at fault. Retrying a truly dead id on the next
   * launch costs one more notice; erasing a live one costs the conversation.
   */
  private async recoverFromDeadSession(id: TabId, dead: AgentSession): Promise<void> {
    if (this.deps.manager.get(id) !== dead) return
    const reason = dead.error ?? 'неизвестная причина'
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return

    // The raw error, before `explain` rewords it for the ribbon.
    const cause = classifyStartFailure(reason)
    if (cause === 'not-logged-in') {
      // A clean session would die the same way. The tab keeps its session,
      // its error and its conversation, and offers the way out.
      this.patch(id, { canRetry: true })
      // Said once: a «Повторить» that fails the same way, with nothing sent
      // since, does not stack a second copy under the first.
      const text = 'Claude Code не вошёл в аккаунт. Войдите и нажмите «Повторить».'
      const since = dead.items.slice(dead.items.findLastIndex((i) => i.kind === 'user') + 1)
      const told = since.some((i) => i.kind === 'notice' && i.action === 'login' && i.text === text)
      if (!told) this.emitRibbon(id, dead.notice(text, 'error', 'login'))
      return
    }

    // Launched as the tab would be, minus «без проверок»: the clean session
    // is a new one, and that mode is never inherited (spec 5.4).
    const launch = this.launchOptions(tab)
    if (launch.permissionMode === 'bypassPermissions') delete launch.permissionMode
    // What the user said to the dead session never reached an agent; it is
    // on screen already and goes to the new one as it was sent.
    const unsent = dead.sentBeforeInit
    const queued = dead.takeQueue()
    const seed = dead.successorSeed()
    // Shown while the dead session closes, so a snapshot then is not empty.
    this.previews.set(id, seed)
    this.replacing.add(id)
    try {
      await this.deps.manager.close(id)
      // Closed while the dead session was closing: no agent for a tab that
      // is gone, and nothing resent to it.
      if (!this.tabs.includes(tab)) {
        this.previews.delete(id)
        return
      }
      // Someone else has given the tab a session meanwhile: it stays, and
      // takes over what was owed.
      const other = this.deps.manager.get(id)
      if (other) {
        this.handOver(id, other, unsent, queued)
        return
      }
      const fresh = this.deps.manager.create(id, tab.cwd, launch, seed)
      this.previews.delete(id)
      this.adopt(id, fresh)
      const said =
        cause === 'missing-conversation'
          ? `Прошлую переписку открыть не удалось: ${reason}`
          : `Сессия не запустилась: ${reason}`
      this.emitRibbon(id, fresh.notice(said))
      await fresh.start()
      this.handOver(id, fresh, unsent, queued)
      this.rememberSession(id, fresh)
    } finally {
      this.replacing.delete(id)
      this.held.delete(id)
    }
  }

  /**
   * Defaults first, the tab's own choices on top: a tab stored before a
   * setting existed still follows it, and a tab that picked its own mode
   * keeps it.
   */
  private launchOptions(tab: TabState): LaunchOverrides {
    return { ...this.deps.getDefaults(), ...tab.overrides }
  }

  /**
   * Connects a session that has just become the tab's, and sends its whole
   * panel. A patch only names what changed; a session that took another's
   * place — after a restart or a failed resume — would otherwise leave the
   * old one's cost and limits on screen. Its revision outranks them.
   */
  private adopt(id: TabId, session: AgentSession): void {
    // Judged before the new session's state replaces the tab's.
    const hadBridge = isRemoteLive(this.tabs.find((t) => t.id === id)?.remote)
    this.wire(id, session)
    this.emitWholePanel(id, session.panelSnapshot())
    this.patch(id, { remote: session.remote })
    // A new process starts with Remote Control off; say so rather than let
    // the phone's link die without a word.
    if (hadBridge) {
      this.emitRibbon(
        id,
        session.notice('Remote Control выключен: сессия перезапущена. Включите снова, если нужно.')
      )
    }
  }

  private wire(id: TabId, session: AgentSession): void {
    // A session that has been replaced — restart, recovery — may still have
    // callbacks on their way; the tab's status, panel and stored id are its
    // successor's now. Ribbon changes still go out: the ribbon is shared.
    const current = (): boolean => this.deps.manager.get(id) === session
    session.onChange((changes) => this.emitRibbon(id, changes))
    session.onPanel((patch, rev) => {
      if (!current()) return
      this.deps.onPanel({ tabId: id, patch, rev })
      if (patch.limits) this.sharePlanLimits(patch.limits)
    })
    session.onRemote((info) => {
      if (current()) this.patch(id, { remote: info })
    })
    session.onCommands((commands) => this.deps.onCommands({ tabId: id, commands }))
    session.onSession(() => {
      if (current()) this.rememberSession(id, session)
    })
    session.onStatus((status) => {
      if (!current()) return
      const patch: Partial<TabState> = { status }
      if (session.error !== undefined) patch.error = session.error
      // A start that never made an agent never reached the conversation:
      // the same one can be tried again. (Not logged in is told apart in
      // `recoverFromDeadSession`, which knows why the agent died.)
      const tab = this.tabs.find((t) => t.id === id)
      patch.canRetry = status === 'error' && !session.launched && Boolean(tab?.lastSessionId)
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

  /**
   * The plan's windows belong to the account, so what one tab learns holds
   * for every tab — including those whose agent has not started and so
   * cannot ask.
   */
  private sharePlanLimits(limits: PanelData['limits']): void {
    if (!limits.fiveHour && !limits.sevenDay) return
    this.planLimits = limits
    for (const [tabId, seed] of this.previews) {
      const patch = seed.collector.setLimits(limits)
      this.deps.onPanel({ tabId, patch, rev: seed.collector.rev })
    }
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

  private emitRibbon(id: TabId, changes: RibbonChange[]): void {
    if (changes.length === 0) return
    const rev = nextRibbonRev()
    this.ribbonRevs.set(id, rev)
    this.deps.onRibbon({ tabId: id, changes, rev })
  }

  private emitWholePanel(id: TabId, snapshot: PanelSnapshot): void {
    this.deps.onPanel({ tabId: id, patch: { ...snapshot.data }, rev: snapshot.rev })
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
