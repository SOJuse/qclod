import { randomUUID } from 'node:crypto'
import { RibbonBuilder } from '../../shared/ribbon'
import type {
  CommandInfo,
  EffortLevel,
  ModelOption,
  LaunchOverrides,
  McpServerInfo,
  PanelData,
  PanelSnapshot,
  PermissionAnswer,
  PermissionRequest,
  RibbonChange,
  RibbonItem,
  SessionStatus,
  TabId,
  TodoItem,
  UserInput
} from '../../shared/types'
import type { AgentDriver, DriverFactory, DriverOptions } from './driver'
import type { ToolPermissionContext } from './permissionContext'
import { parseExtraFlags } from './launchFlags'
import { composeText } from './userMessage'
import { PanelCollector, readProjectSettings } from './panelData'
import { displayTarget } from './permissionStore'
import { locateAgent } from '../setup/findAgent'

export interface AgentSessionOptions {
  tabId: TabId
  cwd: string
  overrides: LaunchOverrides
  /** The configured path, as typed in settings — resolved on every start. */
  agentPath: string
  resolveAgent?: (requested: string) => string
  createDriver: DriverFactory
  /**
   * Asks the user about a tool. Required, not optional: a session built
   * without a gate would answer every `canUseTool` with «allow», and a single
   * missed wire-up would silently disable every permission prompt in the app.
   * `signal` fires when the session stops waiting for this answer («Стоп»,
   * a closed tab, or the SDK giving up on it).
   */
  askPermission: (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionAnswer>
  /**
   * Asks the person, outside the window, whether they really mean to turn the
   * permission gate off. Required: a session built without it refuses
   * `bypassPermissions` outright rather than assuming consent.
   */
  confirmBypass?: () => Promise<boolean>
  /** How long to wait before asking again about a server still coming up. */
  mcpPollMs?: number
  /** How long `dispose` waits for the agent to close before giving up. */
  disposeTimeoutMs?: number
  /** A ribbon and panel already on screen, taken over instead of new ones. */
  seed?: SessionSeed
}

/** The longest `dispose` waits for the agent process to go away. */
export const DISPOSE_TIMEOUT_MS = 5000

/** A server still `pending` or `connecting` is asked about again after this long… */
export const MCP_POLL_MS = 2000
/** …this many times at most, so one that never comes up is not asked about forever. */
export const MCP_POLL_MAX = 15

/**
 * Turns what the SDK said into something worth reading. «Claude Code process
 * exited with code 1» tells the user nothing they can act on (spec 6.10).
 */
function explain(message: string): string {
  if (/exited with code|process exited|stream closed|ECONNRESET/i.test(message)) {
    return `Агент перестал отвечать и сессия закрылась. Подробности: ${message}`
  }
  return message
}

/**
 * What a tab shows of a past conversation before any process runs for it:
 * the ribbon rebuilt from the record, and the panel the record supports.
 * The session that later starts for the tab takes both over, so what is
 * already on screen is neither drawn twice nor renumbered.
 */
export interface SessionSeed {
  builder: RibbonBuilder
  collector: PanelCollector
}

/**
 * Builds a seed from a conversation's messages — the one way a past
 * conversation becomes ribbon and panel. What the old process left running
 * is closed as unfinished: that process is gone and will never report back.
 */
export function seedFromTranscript(messages: unknown[]): SessionSeed {
  const builder = new RibbonBuilder({ replay: true })
  for (const message of messages) builder.apply(message)
  builder.finishReplay()
  const collector = new PanelCollector()
  collector.seedFromTranscript(messages)
  return { builder, collector }
}

/** The texts of an AskUserQuestion's questions — the keys its answers go under. */
function questionTexts(input: Record<string, unknown>): string[] {
  const questions = input['questions']
  if (!Array.isArray(questions)) return []
  return questions.flatMap((q: unknown) => {
    const text = typeof q === 'object' && q !== null ? (q as Record<string, unknown>)['question'] : undefined
    return typeof text === 'string' ? [text] : []
  })
}

type ChangeListener = (changes: RibbonChange[]) => void
type PanelListener = (patch: Partial<PanelData>, rev: number) => void
type StatusListener = (status: SessionStatus) => void

/**
 * One tab's conversation with the agent.
 *
 * Owns the driver, translates its messages into ribbon changes and panel data,
 * and keeps the tab's status honest. Everything that can fail — a missing
 * executable, an agent that dies mid-answer — ends as a visible notice and an
 * `error` status, never as an unhandled rejection: a tab that silently stops
 * answering is the worst outcome for the person using it.
 */
export class AgentSession {
  private readonly options: AgentSessionOptions
  private readonly builder: RibbonBuilder
  private readonly collector: PanelCollector
  private readonly changeListeners: ChangeListener[] = []
  private readonly panelListeners: PanelListener[] = []
  private readonly statusListeners: StatusListener[] = []
  private readonly commandListeners: Array<(commands: CommandInfo[]) => void> = []
  private readonly sessionListeners: Array<(sessionId: string) => void> = []

  private driver: AgentDriver | null = null
  private pump: Promise<void> | null = null
  private state: SessionStatus = 'stopped'
  private failure: string | undefined
  private session: string | null = null
  private mode: string
  private todoItems: TodoItem[] = []
  private readonly idleWaiters: Array<() => void> = []
  /** Messages given to the driver before system/init; see `sentBeforeInit`. */
  private unintroduced: UserInput[] = []
  private disposed = false
  /** Whether a driver was ever made; see `launched`. */
  private launchedAgent = false
  /**
   * Which turn this is: one more for every message given to the agent. Each
   * open question, permission and plan remembers the turn it was asked in,
   * so «Стоп» refuses only what belongs to the turn it stopped.
   */
  private turn = 0
  /** Questions the agent asked through canUseTool, waiting on the user. */
  private readonly pendingQuestions = new Map<
    string,
    { input: Record<string, unknown>; resolve: (answer: PermissionAnswer) => void; turn: number }
  >()
  private readonly pendingPlans = new Map<
    string,
    { resolve: (answer: PermissionAnswer) => void; turn: number }
  >()
  /** Permission questions still waiting on the user; aborting one refuses it. */
  private readonly openPermissions = new Map<string, { controller: AbortController; turn: number }>()
  /**
   * How many questions, permissions and plans are open at once. The tab
   * shows «ждёт» while any is, so answering one of two keeps it waiting.
   */
  private waits = 0
  /**
   * Whether a turn is under way: from a message given to the agent until its
   * result, «Стоп» or a failure. A question can be open outside one — a
   * background subagent asking after the result — and answering it must
   * leave the tab idle, not working on a turn that is not there.
   */
  private turnRunning = false
  private mcpTimer: ReturnType<typeof setTimeout> | null = null
  /** Repeats asked since the servers were last all settled. */
  private mcpPolls = 0

  constructor(options: AgentSessionOptions) {
    this.options = options
    this.mode = options.overrides.permissionMode ?? 'default'
    this.builder = options.seed?.builder ?? new RibbonBuilder()
    this.collector = options.seed?.collector ?? new PanelCollector()
    this.todoItems = this.builder.todo ?? []
  }

  get status(): SessionStatus {
    return this.state
  }

  get error(): string | undefined {
    return this.failure
  }

  get sessionId(): string | null {
    return this.session
  }

  get items(): RibbonItem[] {
    return this.builder.items
  }

  /**
   * Whether a driver was ever created, even if it has failed since. A start
   * that failed before that — no executable, an SDK that would not load —
   * never got as far as the conversation, and so says nothing about it.
   */
  get launched(): boolean {
    return this.launchedAgent
  }

  get todo(): TodoItem[] {
    return this.todoItems
  }

  onChange(cb: ChangeListener): void {
    this.changeListeners.push(cb)
  }

  onPanel(cb: PanelListener): void {
    this.panelListeners.push(cb)
  }

  /** Returns a function that stops the listener. */
  onStatus(cb: StatusListener): () => void {
    this.statusListeners.push(cb)
    return () => {
      const at = this.statusListeners.indexOf(cb)
      if (at !== -1) this.statusListeners.splice(at, 1)
    }
  }

  onCommands(cb: (commands: CommandInfo[]) => void): void {
    this.commandListeners.push(cb)
  }

  /** Fires when the conversation's own id becomes known (system/init). */
  onSession(cb: (sessionId: string) => void): void {
    this.sessionListeners.push(cb)
  }

  /** Resolves when the session is no longer working: idle, stopped or failed. */
  async whenIdle(): Promise<void> {
    if (this.settled()) {
      await new Promise(setImmediate)
      if (this.settled()) return
    }
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
    await new Promise(setImmediate)
  }

  private settled(): boolean {
    return this.state === 'idle' || this.state === 'stopped' || this.state === 'error'
  }

  /**
   * What a session taking this one's place starts from: the same ribbon, so
   * the history stays on screen and new items keep numbering after it, and a
   * clean panel — none of this session's numbers belong to the next one.
   */
  successorSeed(): SessionSeed {
    return { builder: this.builder, collector: new PanelCollector() }
  }

  /**
   * The user answered every question on a question card.
   *
   * A question the agent is still waiting on is answered in place: the SDK
   * takes the answers as `updatedInput.answers` (question text -> choice;
   * AskUserQuestionInput in sdk-tools.d.ts), and the agent carries on with
   * the same turn. Only when nothing is waiting — a card from history, a
   * question left over after «Стоп» — do the answers go as a message — one line
   * `«Question» — answer` per question, just the answer for a single question —
   * which is what the user would have typed anyway. A stopped question is dropped
   * from `pendingQuestions` the moment it is stopped, so its card lands here.
   */
  answerQuestion(toolUseId: string, given: Record<string, string>): void {
    const waiting = this.pendingQuestions.get(toolUseId)
    // The window only says which choice goes with which question; what the
    // questions are comes from here. Foreign keys are dropped, and a card
    // with a question left unanswered stays open and the agent stays held.
    const card = this.builder.items.find((i) => i.kind === 'question' && i.toolUseId === toolUseId)
    const asked = waiting
      ? questionTexts(waiting.input)
      : card && card.kind === 'question'
        ? card.questions.map((q) => q.question)
        : []
    if (asked.length === 0 || !asked.every((q) => typeof given[q] === 'string')) return
    const answers = Object.fromEntries(asked.map((q) => [q, given[q]!]))
    this.emit(this.builder.answerQuestion(toolUseId, answers))

    if (!waiting) {
      const entries = Object.entries(answers)
      const text =
        entries.length === 1
          ? entries[0]![1]
          : entries.map(([question, answer]) => `«${question}» — ${answer}`).join('\n')
      this.send({ text, attachments: [] })
      return
    }
    this.pendingQuestions.delete(toolUseId)
    this.leaveWait()
    waiting.resolve({
      behavior: 'allow',
      updatedInput: { ...waiting.input, answers }
    })
  }

  /**
   * Puts the question in the ribbon, where the tool's own card will go.
   *
   * Called by the permission layer at the moment it decides the person really
   * has to answer. A request a saved rule settles never reaches here, so the
   * ribbon shows a card only for questions that were actually asked.
   */
  showPermissionCard(requestId: string, toolName: string, target: string): void {
    this.emit(this.builder.addPermission(requestId, toolName, target))
  }

  /**
   * The user read the plan and decided.
   *
   * Approving also leaves plan mode, because staying in it would stop the
   * agent from doing the very thing that was just approved.
   */
  async answerPlan(requestId: string, approve: boolean): Promise<void> {
    // (4) Nothing is marked answered until there is something to answer: a
    // card with no pending plan behind it must not look settled.
    const waiting = this.pendingPlans.get(requestId)
    if (!waiting) return
    this.pendingPlans.delete(requestId)
    this.leaveWait()

    this.emit(this.builder.resolvePlan(requestId, approve ? 'approved' : 'rejected'))
    if (!approve) {
      waiting.resolve({ behavior: 'deny' })
      return
    }

    // The mode must be in place before the tool runs, not racing it.
    await this.setPermissionMode('acceptEdits')
    waiting.resolve({ behavior: 'allow' })
  }

  /** Something Qclod itself needs to say — a crash, a session that would not resume. */
  notice(text: string, tone: 'info' | 'error' = 'info', action?: 'login'): RibbonChange[] {
    return this.builder.notice(text, tone, action)
  }

  async start(resumeId?: string): Promise<void> {
    if (this.driver || this.disposed) return
    this.setStatus('starting')
    this.failure = undefined
    // A resumed CLI reports what it has spent since it opened the
    // conversation, not since the conversation began.
    if (resumeId) this.collector.markResumed()

    // A tab could carry bypassPermissions in its stored overrides, from a
    // settings default or an older tabs.json. Starting in it unasked would
    // walk around the confirmation entirely, so the check lives here too.
    if (!(await this.allowMode(this.mode))) {
      this.mode = 'default'
      this.emit(
        this.builder.notice(
          'Режим «без проверок» не подтверждён — сессия запущена в обычном режиме.',
          'info'
        )
      )
      this.emitPanel(this.collector.setPermissionMode('default'))
    }

    let executablePath: string
    try {
      const resolve =
        this.options.resolveAgent ??
        ((p: string) => {
          // PATH is captured when a process starts, so an agent installed
          // while Qclod was open is invisible to it; findAgent also looks
          // where the installers put it. A miss keeps its own reason.
          return locateAgent(p, process.env)
        })
      executablePath = resolve(this.options.agentPath)
    } catch (err) {
      this.fail(err)
      return
    }

    // The «дополнительные флаги» setting is honoured, minus anything that
    // would reach around the permission gate — and the user is told, rather
    // than left with a setting that quietly does nothing.
    const flags = parseExtraFlags(this.options.overrides.extraFlags)
    if (flags.rejected.length > 0) {
      this.emit(
        this.builder.notice(
          `Не переданы агенту: ${flags.rejected.join(', ')} — эти флаги управляют разрешениями, ` +
            'режим меняется в панели.',
          'info'
        )
      )
    }

    const driverOptions: DriverOptions = {
      cwd: this.options.cwd,
      executablePath,
      model: this.options.overrides.model,
      permissionMode: this.mode,
      extraArgs: flags.args,
      resume: resumeId,
      canUseTool: (toolName, input, opts) => this.onToolPermission(toolName, input, opts)
    }

    let driver: AgentDriver
    try {
      driver = await this.options.createDriver(driverOptions)
    } catch (err) {
      this.fail(err)
      return
    }

    // Disposed while we were starting: whoever disposed it is entitled to
    // believe it is gone, so the driver is closed rather than adopted.
    if (this.disposed) {
      await driver.dispose().catch(() => undefined)
      return
    }
    this.driver = driver
    this.launchedAgent = true

    this.pump = this.readMessages(this.driver)
    this.setStatus('idle')
    this.emitPanel(this.collector.setProjectSettings(readProjectSettings(this.options.cwd)))

    // The panel is filled now rather than after the first answer. `system/init`
    // arrives only once the CLI has been given something to answer, so a tab
    // that has not been written in yet used to show «появится после первого
    // ответа» in every row — including a second tab, which looked broken.
    // These are control requests: they answer straight away. Context also
    // names the model; the plan's limits come from the usage call, since no
    // rate_limit_event arrives before the first message either. None of them
    // may become an unhandled rejection, even one thrown synchronously.
    this.background(this.applyStoredEffort())
    this.background(this.refreshContext())
    this.background(this.refreshModels())
    this.background(this.refreshMcp())
    this.background(this.refreshLimits())
  }

  /** The level this tab was left at, from tabs.json — the session's, not the user's settings. */
  private async applyStoredEffort(): Promise<void> {
    const effort = this.options.overrides.effort
    const driver = this.driver
    if (!effort || !driver) return
    try {
      await driver.setEffort(effort)
    } catch {
      // The panel keeps showing what the process is really at.
      this.emit(
        this.builder.notice(
          `Усилие «${effort}» не применено — процесс отказался его принять.`,
          'info'
        )
      )
      return
    }
    this.emitPanel(this.collector.setEffort(effort))
  }

  /**
   * A refresh nobody awaits. The work is an async call, so even a driver that
   * throws synchronously ends as a rejection — which, unhandled, is a process
   * warning at best. The panel simply stays as it was.
   */
  private background(work: Promise<unknown>): void {
    work.catch(() => undefined)
  }

  /** The plan's windows before the first message; rate_limit_event takes over after. */
  private async refreshLimits(): Promise<void> {
    const driver = this.driver
    if (!driver) return
    const limits = await driver.planLimits()
    if (limits && (limits.fiveHour || limits.sevenDay)) {
      this.emitPanel(this.collector.setLimits(limits))
    }
  }

  send(input: UserInput): void {
    if (!this.driver) return

    // The text is composed once, here. The ribbon shows what the user typed
    // with their files as chips; the agent — and therefore the echo that comes
    // back — gets the composed version, which is what the dedup must match.
    const text = composeText(input)
    // The ribbon shows an image by its thumbnail, or by its copy on disk when
    // there is none (a large GIF or WebP); the full bytes (up to ~5 MB of
    // base64) would otherwise ride along in every snapshot.
    const shown = input.attachments.map((a) =>
      a.kind === 'image' && (a.thumbnail || a.path) ? { ...a, dataBase64: '' } : a
    )
    this.emit(this.builder.addUser(input.text, shown, text))
    this.deliver({ ...input, text })
  }

  /**
   * What was sent here before the CLI introduced itself. A resume that will
   * not open may only say so once it is spoken to, and takes these down with
   * it; the session taking its place sends them again (`resend`).
   */
  get sentBeforeInit(): UserInput[] {
    return this.session === null ? [...this.unintroduced] : []
  }

  /**
   * Sends again, as it was sent, a message a dead predecessor never got to.
   * It is in the ribbon already — the ribbon is carried over — so no second
   * bubble, and the echo it brings back is matched to the first one.
   */
  resend(sent: UserInput): void {
    this.deliver(sent)
  }

  private deliver(sent: UserInput): void {
    if (!this.driver) return
    if (this.session === null) this.unintroduced.push(sent)
    this.turn += 1
    this.turnRunning = true
    this.setStatus('busy')
    this.driver.send(sent)
  }

  /**
   * «Стоп». Every open question is refused here and now rather than left to
   * the SDK: the real one abandons a pending `canUseTool` without saying so,
   * and a card answered after that would set the tab working on a turn that
   * is already over.
   *
   * The stop is for the turn under way when it was pressed. The user need
   * not wait for it to land: a message sent meanwhile starts a turn of its
   * own, and that turn — its status, its first question — is left alone.
   */
  async interrupt(): Promise<void> {
    if (!this.driver) return
    const stopped = this.turn
    this.cancelWaits()
    await this.driver.interrupt().catch(() => undefined)
    // A question asked while the interrupt was on its way belongs to the
    // turn being stopped and is refused with it; left open, it would hold a
    // count of one behind an idle tab.
    this.cancelWaits({ upTo: stopped })
    if (this.turn !== stopped) return
    this.turnRunning = false
    this.setStatus('idle')
  }

  /**
   * Refuses what is still waiting on the user — everything, or only what was
   * asked in turn `upTo` or before. Permission and plan cards show as denied
   * and rejected; a question card stays as it is, and a click on it later
   * goes as a message (see `answerQuestion`).
   */
  private cancelWaits(scope: { upTo?: number } = {}): void {
    const ours = (wait: { turn: number }): boolean =>
      scope.upTo === undefined || wait.turn <= scope.upTo

    const permissions = [...this.openPermissions].filter(([, wait]) => ours(wait))
    for (const [requestId, { controller }] of permissions) {
      this.openPermissions.delete(requestId)
      this.emit(this.builder.resolvePermission(requestId, 'denied'))
      controller.abort()
    }

    const questions = [...this.pendingQuestions].filter(([, wait]) => ours(wait))
    for (const [toolUseId, waiting] of questions) {
      this.pendingQuestions.delete(toolUseId)
      waiting.resolve({ behavior: 'deny' })
    }

    const plans = [...this.pendingPlans].filter(([, wait]) => ours(wait))
    for (const [requestId, waiting] of plans) {
      this.pendingPlans.delete(requestId)
      this.emit(this.builder.resolvePlan(requestId, 'rejected'))
      waiting.resolve({ behavior: 'deny' })
    }

    // What is left open is what still holds the tab waiting.
    this.waits = this.openPermissions.size + this.pendingQuestions.size + this.pendingPlans.size
  }

  private enterWait(): void {
    this.waits += 1
    this.setStatus('waiting')
  }

  private leaveWait(): void {
    if (this.waits === 0) return
    this.waits -= 1
    if (this.waits === 0 && this.state === 'waiting') {
      this.setStatus(this.turnRunning ? 'busy' : 'idle')
    }
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (!(await this.allowMode(mode))) {
      // The panel's select is controlled on what the panel knows, so a refusal
      // must still be reported — otherwise it keeps showing the mode the user
      // picked while the session is in another one, and the panel's whole
      // premise is that it shows the truth (spec 6.5).
      this.emitPanel(this.collector.currentPermissionMode())
      return
    }
    this.mode = mode
    this.emitPanel(this.collector.setPermissionMode(mode))
    if (!this.driver) return
    await this.driver.setPermissionMode(mode).catch(() => undefined)
  }

  async commands(): Promise<ReturnType<AgentDriver['supportedCommands']>> {
    if (!this.driver) return []
    return this.driver.supportedCommands().catch(() => [])
  }

  /**
   * The models this session can switch to, asked for once it is up.
   *
   * Applied through the SDK rather than by sending «/model …» as text: the
   * command needs an argument the user has to pick from somewhere, and the
   * somewhere may as well be the real list.
   */
  async setModel(model: string): Promise<void> {
    if (!this.driver) return
    await this.driver.setModel(model).catch(() => undefined)
    this.emitPanel(this.collector.setModel(model))
  }

  async setEffort(level: EffortLevel): Promise<void> {
    if (!this.driver) return
    await this.driver.setEffort(level).catch(() => undefined)
    this.emitPanel(this.collector.setEffort(level))
  }

  private async refreshModels(): Promise<void> {
    const driver = this.driver
    if (!driver) return
    const models = await driver.supportedModels().catch((): ModelOption[] => [])
    if (models.length > 0) this.emitPanel(this.collector.setModels(models))
  }

  /**
   * Live MCP state. Asked for at start, right after init, when the commands
   * or plugins change, and when the panel is opened. init itself only says how
   * the servers stood when the CLI started — `pending`, mostly — so a server
   * still coming up is asked about again until it settles: otherwise
   * «ждёт» stayed on screen until someone happened to reopen the panel.
   */
  async refreshMcp(reason: 'poll' | 'trigger' = 'trigger'): Promise<void> {
    const driver = this.driver
    if (!driver) return
    // An outside cause (start, init, commands, plugin) earns a fresh allowance
    // of repeats; the timer's own repeats do not.
    if (reason === 'trigger') this.mcpPolls = 0
    let mcp: McpServerInfo[]
    try {
      mcp = await driver.mcpServerStatus()
    } catch {
      // A failed check says nothing about the servers: keep the list on the
      // panel and keep waiting, within the same limit.
      if (this.disposed || this.driver !== driver) return
      this.pollMcpWhileWaiting(this.collector.data.mcp, { failed: true })
      return
    }
    if (this.disposed || this.driver !== driver) return
    if (mcp.length > 0) this.emitPanel(this.collector.setMcp(mcp))
    this.pollMcpWhileWaiting(mcp)
  }

  private pollMcpWhileWaiting(mcp: McpServerInfo[], opts: { failed?: boolean } = {}): void {
    const waiting =
      opts.failed === true || mcp.some((s) => s.status === 'pending' || s.status === 'connecting')
    if (!waiting) {
      this.mcpPolls = 0
      this.stopMcpPolling()
      return
    }
    // One repeat in flight at a time; a refresh from elsewhere joins it.
    if (this.mcpTimer || this.mcpPolls >= MCP_POLL_MAX) return
    this.mcpPolls += 1
    this.mcpTimer = setTimeout(() => {
      this.mcpTimer = null
      this.background(this.refreshMcp('poll'))
    }, this.options.mcpPollMs ?? MCP_POLL_MS)
  }

  private stopMcpPolling(): void {
    if (this.mcpTimer) clearTimeout(this.mcpTimer)
    this.mcpTimer = null
  }

  /** Everything the panel knows about this tab right now. */
  get panel(): PanelData {
    return this.collector.data
  }

  /** The whole panel with the revision of its last patch — for a window catching up. */
  panelSnapshot(): PanelSnapshot {
    return this.collector.snapshot
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.turnRunning = false
    this.stopMcpPolling()
    // A question nobody can answer any more must not hold the agent open.
    this.cancelWaits()

    const driver = this.driver
    this.driver = null
    const pump = this.pump
    this.pump = null
    // A driver that never closes must not hold a tab close or the app's exit.
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS)
    })
    const closing = (async () => {
      if (driver) await driver.dispose().catch(() => undefined)
      await pump?.catch(() => undefined)
    })()
    await Promise.race([closing, limit])
    clearTimeout(timer)
    this.setStatus('stopped')
  }

  // ------------------------------------------------------------- the pump

  /** Only one mode needs asking about, and it is asked about every time. */
  private async allowMode(mode: string): Promise<boolean> {
    if (mode !== 'bypassPermissions') return true
    const confirm = this.options.confirmBypass
    if (!confirm) return false
    return confirm()
  }

  private async readMessages(driver: AgentDriver): Promise<void> {
    try {
      for await (const message of driver.messages) {
        // A driver that failed or was disposed is dead: whatever it still
        // delivers must not bring the session back to life.
        if (this.driver !== driver) break
        this.onMessage(message)
      }
      // The stream ending by itself means the agent exited.
      if (this.driver === driver) this.setStatus('stopped')
    } catch (err) {
      if (this.driver === driver) this.fail(err)
    }
  }

  /** Feeds one message in, as the stream would. Exposed for tests. */
  handle(message: unknown): void {
    this.onMessage(message)
  }

  private onMessage(message: unknown): void {
    this.emit(this.builder.apply(message))
    const panel = this.collector.apply(message)
    if (panel) {
      // The collector is the one place that knows the current mode — it also
      // knows not to let a restart overrule what the user chose.
      this.mode = this.collector.data.permissionMode
      this.emitPanel(panel)
    }
    const todo = this.builder.todo
    if (todo) this.todoItems = todo

    if (typeof message !== 'object' || message === null) return
    const m = message as Record<string, unknown>

    switch (m['type']) {
      case 'system':
        if (m['subtype'] === 'init') this.onInit(m)
        else if (m['subtype'] === 'commands_changed') {
          this.onCommandsChanged(m)
          // A plugin's commands come with its servers.
          this.background(this.refreshMcp())
        } else if (m['subtype'] === 'plugin_install') this.background(this.refreshMcp())
        break
      case 'result':
        this.turnRunning = false
        this.setStatus('idle')
        this.background(this.refreshContext())
        break
      default:
        break
    }
  }

  private onInit(m: Record<string, unknown>): void {
    const id = typeof m['session_id'] === 'string' ? m['session_id'] : null
    if (id && id !== this.session) {
      this.session = id
      // The CLI is up and has them; nothing is left to resend.
      this.unintroduced = []
      // The tab remembers the conversation by this id. It used to be picked up
      // from the status change init caused — but a session is already idle by
      // then, and a status that does not change notifies nobody.
      for (const listener of this.sessionListeners) listener(id)
    }
    // init is the session introducing itself, not a turn ending. With
    // streaming input the CLI sends it only once it has been given something
    // to answer, so it lands *after* the first message — and treating it as a
    // turn boundary made that first message look dead: the status flipped to
    // idle while the agent was still working, and only from the second message
    // on did anything ever look alive. Only `result` ends a turn.
    if (this.state !== 'busy' && this.state !== 'waiting') this.setStatus('idle')
    this.background(this.refreshModels())
    // init's servers are as they were at start; the live state is asked for.
    this.background(this.refreshMcp())
  }

  private onCommandsChanged(m: Record<string, unknown>): void {
    if (!Array.isArray(m['commands'])) return
    const commands = (m['commands'] as Array<Record<string, unknown>>).map((c) => ({
      name: String(c['name'] ?? ''),
      description: String(c['description'] ?? ''),
      argumentHint: String(c['argumentHint'] ?? ''),
      ...(c['builtin'] === undefined ? {} : { builtin: Boolean(c['builtin']) })
    }))
    for (const listener of this.commandListeners) listener(commands)
  }

  /** Context is not in the turn's result message (probe note 4): ask for it. */
  private async refreshContext(): Promise<void> {
    const driver = this.driver
    if (!driver) return
    try {
      this.emitPanel(this.collector.setContext(await driver.getContextUsage()))
    } catch {
      // A session that is shutting down cannot answer; the panel keeps its
      // last numbers rather than showing a hole.
    }
  }

  private async onToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: ToolPermissionContext
  ): Promise<PermissionAnswer> {
    const ask = this.options.askPermission

    // A question is not a permission: it has options, not «allow» and «deny»
    // (spec 6.2). It arrives through the same channel, so it is split out here
    // rather than shown as a permission the user cannot sensibly answer.
    if (toolName === 'AskUserQuestion') return this.askQuestion(input, opts)

    // A plan is a document to read, not a tool call to wave through. In plan
    // mode the agent finishes by calling ExitPlanMode with what it intends to
    // do, and that is the moment the user decides (spec 6.4).
    if (toolName === 'ExitPlanMode' && this.mode === 'plan') return this.askPlan(input, opts)

    // The tool call's own id, so two questions about one message's tools are
    // two requests. A clock is no id: two asks in one millisecond collided.
    const requestId = opts.toolUseId ?? randomUUID()
    const target = displayTarget(input)

    // The question is cancelled through a controller of the session's own,
    // so «Стоп» reaches it whether or not the SDK ever fires its signal.
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    if (opts.signal?.aborted) return { behavior: 'deny' }
    opts.signal?.addEventListener('abort', cancel, { once: true })
    const wait = { controller, turn: this.turn }
    this.openPermissions.set(requestId, wait)
    this.enterWait()

    let answer: PermissionAnswer
    try {
      answer = await ask(
        { requestId, tabId: this.options.tabId, toolName, target, input },
        controller.signal
      )
    } catch {
      // A gate that failed is not a gate that said yes.
      answer = { behavior: 'deny' }
    } finally {
      opts.signal?.removeEventListener('abort', cancel)
    }
    // An answer to a question nobody waits on any more is no answer.
    if (controller.signal.aborted) answer = { behavior: 'deny' }

    // Still open unless «Стоп» already closed it — and marked its card.
    if (this.openPermissions.get(requestId) === wait) {
      this.openPermissions.delete(requestId)
      this.leaveWait()
      this.emit(
        this.builder.resolvePermission(requestId, answer.behavior === 'allow' ? 'allowed' : 'denied')
      )
    }
    return answer
  }

  private askPlan(
    input: Record<string, unknown>,
    opts: ToolPermissionContext
  ): Promise<PermissionAnswer> {
    const requestId = opts.toolUseId ?? randomUUID()
    const text = typeof input['plan'] === 'string' ? input['plan'] : ''
    this.emit(this.builder.addPlan(requestId, text))
    if (opts.signal?.aborted) {
      this.emit(this.builder.resolvePlan(requestId, 'rejected'))
      return Promise.resolve({ behavior: 'deny' })
    }

    this.enterWait()
    return new Promise<PermissionAnswer>((resolve) => {
      // The SDK gave up on the plan: it can no longer be approved.
      const onAbort = (): void => {
        if (this.pendingPlans.get(requestId)?.resolve !== settle) return
        this.pendingPlans.delete(requestId)
        this.leaveWait()
        this.emit(this.builder.resolvePlan(requestId, 'rejected'))
        resolve({ behavior: 'deny' })
      }
      const settle = (answer: PermissionAnswer): void => {
        opts.signal?.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingPlans.set(requestId, { resolve: settle, turn: this.turn })
    })
  }

  private askQuestion(
    input: Record<string, unknown>,
    opts: ToolPermissionContext
  ): Promise<PermissionAnswer> {
    const toolUseId = opts.toolUseId ?? randomUUID()
    // The CLI puts the call in the stream before it asks, so its card is
    // usually there already; a second one would be a card nobody can answer.
    if (!this.builder.hasToolUse(toolUseId)) {
      this.emit(this.builder.apply(this.questionMessage(toolUseId, input)))
    }

    // A question the SDK has already given up on is not asked: its card stays,
    // and a click on it goes as a message.
    if (opts.signal?.aborted) return Promise.resolve({ behavior: 'deny' })

    this.enterWait()
    return new Promise<PermissionAnswer>((resolve) => {
      // The SDK stopped waiting: the entry goes, so a later click on the card
      // is sent as a message instead of answering a promise nobody reads.
      const onAbort = (): void => {
        if (this.pendingQuestions.get(toolUseId)?.resolve !== settle) return
        this.pendingQuestions.delete(toolUseId)
        this.leaveWait()
        resolve({ behavior: 'deny' })
      }
      const settle = (answer: PermissionAnswer): void => {
        opts.signal?.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingQuestions.set(toolUseId, { input, resolve: settle, turn: this.turn })
    })
  }

  /** Reuses the ribbon translator so a question looks the same either way. */
  private questionMessage(toolUseId: string, input: Record<string, unknown>): unknown {
    return {
      type: 'assistant',
      message: {
        id: `q-${toolUseId}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input }]
      }
    }
  }

  // --------------------------------------------------------------- plumbing

  /**
   * The session is over and could not finish.
   *
   * The driver is dropped, so nothing can be sent into a dead session — a
   * message accepted there would show in the ribbon, set the tab working, and
   * never arrive anywhere. Rows that were mid-flight stop pretending to still
   * be happening: a blinking caret and a card reading «работает…» describe an
   * agent that no longer exists.
   */
  private fail(err: unknown): void {
    // A closed session has nothing left to fail; a late callback of its
    // would write into a ribbon its successor carries on.
    if (this.disposed) return
    this.turnRunning = false
    const text = err instanceof Error ? err.message : String(err)
    const dead = this.driver
    this.driver = null
    // The process may still be alive; and cards nobody can answer any more
    // must not stay live (a click could save a rule from a dead session).
    this.cancelWaits()
    if (dead) void dead.dispose().catch(() => undefined)
    this.failure = text
    this.emit(this.builder.closeOpen())
    this.emit(this.builder.notice(explain(text), 'error'))
    this.setStatus('error')
  }

  private emit(changes: RibbonChange[]): void {
    if (changes.length === 0) return
    for (const listener of this.changeListeners) listener(changes)
  }

  /** Every patch comes from the collector, so its revision is the collector's. */
  private emitPanel(patch: Partial<PanelData>): void {
    // The tab's panel belongs to whichever session replaced this one.
    if (this.disposed || Object.keys(patch).length === 0) return
    const rev = this.collector.rev
    for (const listener of this.panelListeners) listener(patch, rev)
  }

  private setStatus(status: SessionStatus): void {
    if (this.state === status) return
    this.state = status
    // A copy: a listener may stop itself while it is being told.
    for (const listener of [...this.statusListeners]) listener(status)
    if (this.settled()) {
      const waiters = this.idleWaiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }
}
