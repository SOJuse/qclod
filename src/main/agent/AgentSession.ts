import { randomUUID } from 'node:crypto'
import { RibbonBuilder } from '../../shared/ribbon'
import type {
  CommandInfo,
  EffortLevel,
  ModelOption,
  LaunchOverrides,
  McpServerInfo,
  NoticeAction,
  PanelData,
  PanelSnapshot,
  PermissionAnswer,
  PermissionRequest,
  RemoteInfo,
  RibbonChange,
  RibbonItem,
  SessionStatus,
  TabId,
  TaskOutput,
  TodoItem,
  UserInput
} from '../../shared/types'
import { REMOTE_OFF, explainRemoteError, isRemoteLive, remoteFromMessage } from '../../shared/remote'
import type { AgentDriver, DriverFactory, DriverOptions, InterruptReceipt, SendPriority } from './driver'
import type { ToolPermissionContext } from './permissionContext'
import { parseExtraFlags } from './launchFlags'
import { composeText } from './userMessage'
import { Outbox, queueModeFrom, type OutboxEntry } from './outbox'
import { PanelCollector, readProjectSettings } from './panelData'
import { BackgroundTracker } from './backgroundTasks'
import { displayTarget } from './permissionStore'
import { locateAgent } from '../setup/findAgent'
import { classifyStartFailure, LOGIN_NEEDED_TEXT } from './startFailure'
import { sdkPermissionMode } from '../../shared/types'

/** How a notice names a mode; the window has its own, longer labels. */
const MODE_NAMES: Record<string, string> = {
  default: 'спрашивать',
  acceptEdits: 'принимать правки',
  plan: 'план',
  autoAllow: 'авто-да',
  auto: 'классификатор',
  dontAsk: 'только разрешённое',
  bypassPermissions: 'без проверок'
}

/**
 * How often a live session asks again for its context and the plan's limits.
 * rate_limit_event comes only with an answer, so an idle tab used to keep
 * showing a five-hour window that had long since reset.
 */
export const PANEL_REFRESH_MS = 60_000

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
  /**
   * The same, outside the window, for «авто-да»: Qclod would answer every
   * question by itself. Without it the mode is refused.
   */
  confirmAutoAllow?: () => Promise<boolean>
  /** How long to wait before asking again about a server still coming up. */
  mcpPollMs?: number
  /** How long `dispose` waits for the agent to close before giving up. */
  disposeTimeoutMs?: number
  /** How often context and limits are asked for again; 0 never. */
  panelRefreshMs?: number
  /** A ribbon and panel already on screen, taken over instead of new ones. */
  seed?: SessionSeed
}

/** The longest `dispose` waits for the agent process to go away. */
export const DISPOSE_TIMEOUT_MS = 5000

/** The longest a closing tab waits for the bridge to say «выключено» to the phone. */
export const REMOTE_OFF_TIMEOUT_MS = 1000

/** A server still `pending` or `connecting` is asked about again after this long… */
export const MCP_POLL_MS = 2000
/** …this many times at most, so one that never comes up is not asked about forever. */
export const MCP_POLL_MAX = 15

/** Messages on the strip, not read by the agent yet; one more is handed back rather than kept. */
export const MAX_QUEUED = 20

/** What a session whose agent simply went away says, and keeps as its error. */
const AGENT_EXITED = 'Агент завершил работу'

/** A message the CLI dropped from its queue without being asked to. */
const NOT_DELIVERED = 'Сообщение не дошло до агента: ход прервали'

/** A queued image handed back to the window: its copy on disk stands for its bytes. */
function withoutCopiedBytes(input: UserInput): UserInput {
  return {
    ...input,
    attachments: input.attachments.map((a) =>
      a.kind === 'image' && a.path ? { ...a, dataBase64: '' } : a
    )
  }
}

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
  private readonly backgroundTasks = new BackgroundTracker()
  private readonly changeListeners: ChangeListener[] = []
  private readonly panelListeners: PanelListener[] = []
  private readonly statusListeners: StatusListener[] = []
  private readonly commandListeners: Array<(commands: CommandInfo[]) => void> = []
  private readonly sessionListeners: Array<(sessionId: string) => void> = []
  private readonly remoteListeners: Array<(info: RemoteInfo) => void> = []
  /** Remote Control of this tab. Live only: a new process starts with it off. */
  private remoteInfo: RemoteInfo = REMOTE_OFF
  /** The «включить» on its way to the CLI; a second one joins it, a «выключить» waits for it. */
  private enabling: Promise<void> | null = null
  private disabling: Promise<void> | null = null

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
  /**
   * The user's messages the agent has not read yet, oldest first — on the
   * strip, not in the ribbon. While the agent starts they wait here
   * (`waiting`); once it is up they are with the CLI, which folds them into
   * the turn between steps, and its `command_lifecycle` frames move them
   * along: `started` turns one into a bubble.
   */
  private readonly outbox = new Outbox()
  /**
   * Whether this CLI keeps a queue of its own and reports on it (ruling R6):
   * init says so, or a lifecycle frame has already come. init comes after the
   * first frames and again every turn; until either, a message sent during a
   * turn shows at once, as with an old CLI.
   */
  private cliQueue = false
  /**
   * The last result came while the CLI still had a turn of this tab's to run:
   * the tab stays busy and the turn counts as under way until that turn starts
   * or there is nothing left for it to run. `queuedTurns` is how many the
   * result said were waiting, less those taken back since.
   */
  private heldByQueue = false
  private queuedTurns = 0
  /** One more every time the outbox is handed over: a cancel answered after that is not ours. */
  private outboxEpoch = 0
  /** Taken back for «Отправить сейчас»: their `cancelled` frame neither lets the tab go nor counts as unread. */
  private readonly resending = new Set<string>()
  /**
   * How many «Стоп» are on their way. Meanwhile a message goes straight to
   * the agent: the queue was handed back when Stop was pressed, and a message
   * typed after that is meant to be sent, not pulled back too.
   */
  private stopsInFlight = 0
  private mcpTimer: ReturnType<typeof setTimeout> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
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

  get remote(): RemoteInfo {
    return this.remoteInfo
  }

  /** Every change of Remote Control. Returns a function that stops the listener. */
  onRemote(cb: (info: RemoteInfo) => void): () => void {
    this.remoteListeners.push(cb)
    return () => {
      const at = this.remoteListeners.indexOf(cb)
      if (at !== -1) this.remoteListeners.splice(at, 1)
    }
  }

  /**
   * Turns Remote Control on or off. A second «включить» while the first is
   * still on its way asks the CLI nothing; a «выключить» meanwhile waits for
   * the answer and then turns off whatever came of it. Nothing here throws:
   * a refusal ends up in the state, for the panel to show.
   */
  async setRemote(enabled: boolean, name?: string): Promise<void> {
    if (enabled) await this.enableRemote(name)
    else await this.disableRemote()
  }

  private async enableRemote(name?: string): Promise<void> {
    // The last click wins: a «включить» waits for a «выключить» already on its way.
    while (this.disabling) await this.disabling
    if (this.enabling) return this.enabling
    const driver = this.driver
    if (!driver || this.remoteInfo.blocked || isRemoteLive(this.remoteInfo)) return
    const enabling = this.runEnable(driver, name)
    this.enabling = enabling
    try {
      await enabling
    } finally {
      if (this.enabling === enabling) this.enabling = null
    }
  }

  private async runEnable(driver: AgentDriver, name?: string): Promise<void> {
    this.setRemoteInfo({ state: 'connecting' })
    let url: string
    try {
      url = (await driver.setRemoteControl(true, name))?.sessionUrl ?? ''
      if (!url) throw new Error('CLI не вернул ссылку на сессию')
    } catch (err) {
      if (this.driver !== driver) return
      const problem = explainRemoteError(err)
      this.setRemoteInfo({ state: 'off', problem })
      this.emit(this.builder.notice(problem, 'error'))
      return
    }
    // The process is gone, or the bridge was turned off meanwhile: the
    // answer must not bring it back.
    if (this.driver !== driver) return
    const now = this.remoteInfo
    if (now.state === 'connecting') this.setRemoteInfo({ state: 'on', url })
    // The bridge spoke first: its state stands, the link is added to it.
    else if (isRemoteLive(now)) this.setRemoteInfo({ ...now, url })
  }

  private async disableRemote(): Promise<void> {
    if (this.enabling) await this.enabling
    if (this.disabling) return this.disabling
    const driver = this.driver
    if (!driver || this.remoteInfo.state === 'off') return
    const disabling = this.runDisable(driver)
    this.disabling = disabling
    try {
      await disabling
    } finally {
      if (this.disabling === disabling) this.disabling = null
    }
  }

  private async runDisable(driver: AgentDriver): Promise<void> {
    try {
      await driver.setRemoteControl(false)
    } catch (err) {
      if (this.driver !== driver) return
      const message = err instanceof Error ? err.message : String(err)
      this.setRemoteInfo({ ...this.remoteInfo, problem: `Не удалось выключить Remote Control: ${message}` })
      return
    }
    if (this.driver === driver && this.remoteInfo.state !== 'connecting') this.setRemoteInfo(REMOTE_OFF)
  }

  /** Whether this login and CLI can run Remote Control at all; asked once the process is up. */
  private async checkRemote(): Promise<void> {
    const driver = this.driver
    if (!driver) return
    const availability = await driver.remoteAvailability()
    if (this.driver !== driver || availability.available || this.remoteInfo.state !== 'off') return
    this.setRemoteInfo({ state: 'off', blocked: availability.reason })
  }

  private setRemoteInfo(info: RemoteInfo): void {
    const was = this.remoteInfo
    if (
      was.state === info.state &&
      was.url === info.url &&
      was.problem === info.problem &&
      was.blocked === info.blocked
    ) {
      return
    }
    this.remoteInfo = info
    this.builder.setRemote(isRemoteLive(info))
    // The tab belongs to whichever session replaced this one.
    if (this.disposed) return
    for (const listener of [...this.remoteListeners]) listener(info)
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
  notice(text: string, tone: 'info' | 'error' = 'info', action?: NoticeAction): RibbonChange[] {
    return this.builder.notice(text, tone, action)
  }

  /**
   * Whether the ribbon already asks to log in, with nothing sent since. The
   * one test for it: a session that took a dead one's place and died the
   * same way — «Повторить» before the login was done — and the tab recovering
   * a dead resume both use it, so the notice is never stacked.
   */
  toldToLogIn(): boolean {
    const items = this.builder.items
    const since = items.slice(items.findLastIndex((i) => i.kind === 'user') + 1)
    return since.some((i) => i.kind === 'notice' && i.action === 'login' && i.text === LOGIN_NEEDED_TEXT)
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
    // The SDK knows nothing of Qclod's own modes and reports `default` at
    // init; the mode is marked as ours so init does not overrule it.
    if (this.mode === 'autoAllow') this.emitPanel(this.collector.setPermissionMode(this.mode))

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
      permissionMode: sdkPermissionMode(this.mode),
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
    // The stored effort is asked for first, so the control request is on the
    // wire before the first queued message and that message runs at it.
    this.background(this.applyStoredEffort())
    // What was sent while the agent was starting goes now, all of it.
    if (!this.flushWaiting()) this.setStatus('idle')
    this.emitPanel(this.collector.setProjectSettings(readProjectSettings(this.options.cwd)))

    // The panel is filled now rather than after the first answer. `system/init`
    // arrives only once the CLI has been given something to answer, so a tab
    // that has not been written in yet used to show «появится после первого
    // ответа» in every row — including a second tab, which looked broken.
    // These are control requests: they answer straight away. Context also
    // names the model; the plan's limits come from the usage call, since no
    // rate_limit_event arrives before the first message either. None of them
    // may become an unhandled rejection, even one thrown synchronously.
    this.background(this.refreshContext())
    this.background(this.refreshModels())
    this.background(this.refreshMcp())
    this.background(this.refreshLimits())
    this.background(this.checkRemote())
    this.startPanelRefresh()
  }

  /**
   * Context and limits are asked for again every minute, working or not: a
   * five-hour window resets on its own clock, and an idle tab must show it.
   * The cheap «summary» count is used — the full one costs token-count calls.
   */
  private startPanelRefresh(): void {
    const every = this.options.panelRefreshMs ?? PANEL_REFRESH_MS
    if (every <= 0 || this.refreshTimer) return
    this.refreshTimer = setInterval(() => {
      if (!this.driver || this.disposed) return
      this.background(this.refreshLimits())
      // A turn under way changes the count with every step; asking then would
      // only race the answer the result brings.
      if (!this.turnRunning) this.background(this.refreshContext('summary'))
    }, every)
    this.refreshTimer.unref?.()
  }

  private stopPanelRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
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

  /**
   * A message from the user. It goes to the CLI at once, with a uuid of its
   * own; during a turn the CLI reads it between the agent's steps, and the
   * strip shows it until then. Only while the agent is still starting does it
   * wait here. False when the session cannot take it — not started, dead, or
   * the strip full — so the window can give it back.
   */
  send(input: UserInput): boolean {
    if (this.disposed) return false
    const starting = !this.driver && this.state === 'starting'
    if (!this.driver && !starting) return false
    if (starting) {
      if (this.outbox.size >= MAX_QUEUED) return false
      this.hold(input)
      return true
    }
    if (this.willQueue() && this.outbox.size >= MAX_QUEUED) return false
    this.dispatch(input, randomUUID())
    return true
  }

  /** A message sent now would wait on the strip for the agent to read it. */
  private willQueue(): boolean {
    return this.turnRunning && this.stopsInFlight === 0 && this.cliQueue
  }

  /**
   * Gives a message to the CLI, by what is going on. No turn: it starts one
   * and shows at once. A «Стоп» on its way: the same — the strip was handed
   * back when Stop was pressed, and a message typed after that is meant to
   * be sent, not pulled back too. A turn under way: the CLI folds it in, and
   * it shows when the CLI says the agent read it — or at once, with a CLI that
   * says nothing about its queue.
   */
  private dispatch(input: UserInput, uuid: string): void {
    if (!this.turnRunning || this.stopsInFlight > 0) this.sendNow(input, uuid)
    else if (this.cliQueue) this.enqueue(input, uuid)
    else this.foldNow(input, uuid)
  }

  private sendNow(input: UserInput, uuid: string): void {
    if (!this.driver) return
    const text = this.showUser(input)
    this.deliver({ ...input, text }, uuid)
  }

  /** Into the turn under way, on a CLI that keeps no account of it: shown at once, no new turn. */
  private foldNow(input: UserInput, uuid: string): void {
    if (!this.driver) return
    const text = this.showUser(input)
    this.transmit({ ...input, text }, { uuid })
  }

  /** Onto the strip and to the CLI; its lifecycle frames take it from there. */
  private enqueue(input: UserInput, uuid: string, priority?: SendPriority): void {
    if (!this.driver) return
    const composed = composeText(input)
    this.outbox.add({ uuid, input, composed, state: 'sending' })
    this.emitQueue()
    // Without a priority the CLI takes it as 'next': read at the next step boundary.
    this.driver.send({ ...input, text: composed }, priority ? { uuid, priority } : { uuid })
  }

  /** Held until the agent is up. The uuid is the one it will go with (ruling R2). */
  private hold(input: UserInput): void {
    this.outbox.add({ uuid: randomUUID(), input, composed: composeText(input), state: 'waiting' })
    this.emitQueue()
  }

  /**
   * The user's bubble. Returns the text as the agent gets it: composed once,
   * here. The ribbon shows what the user typed with their files as chips; the
   * agent — and therefore the echo that comes back — gets the composed
   * version, which is what the dedup must match.
   */
  private showUser(input: UserInput, composed = composeText(input)): string {
    // The ribbon shows an image by its thumbnail, or by its copy on disk when
    // there is none (a large GIF or WebP); the full bytes (up to ~5 MB of
    // base64) would otherwise ride along in every snapshot.
    const shown = input.attachments.map((a) =>
      a.kind === 'image' && (a.thumbnail || a.path) ? { ...a, dataBase64: '' } : a
    )
    this.emit(this.builder.addUser(input.text, shown, composed))
    return composed
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
    this.deliver(sent, randomUUID())
  }

  private deliver(sent: UserInput, uuid: string): void {
    if (!this.driver) return
    this.turn += 1
    this.turnRunning = true
    this.setStatus('busy')
    this.transmit(sent, { uuid })
  }

  /** What is on screen goes to the agent; before init it is also kept for a resend. */
  private transmit(sent: UserInput, opts: { uuid: string }): void {
    if (!this.driver) return
    if (this.session === null) this.unintroduced.push(sent)
    this.driver.send(sent, opts)
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
  async interrupt(): Promise<UserInput[]> {
    const driver = this.driver
    if (!driver) return []
    const stopped = this.turn
    // What is on the strip now is what Stop hands back. Marked before
    // anything is awaited: their `cancelled` frames can come before the
    // receipt does, and must read as asked for, not as messages a stopped
    // turn swallowed. One already being taken back answers for itself.
    const onStrip = this.outbox.pending().filter((e) => !e.requestedCancel)
    const before = new Map(onStrip.map((e) => [e.uuid, e.state]))
    for (const entry of onStrip) {
      entry.requestedCancel = true
      this.outbox.mark(entry.uuid, 'cancelling')
    }
    if (onStrip.length > 0) this.emitQueue()
    const epoch = this.outboxEpoch
    this.cancelWaits()
    this.stopsInFlight += 1
    let cancelled: Set<string>
    try {
      const receipt = await this.interruptSafely(driver, { cancelQueued: true })
      // A CLI with no receipt is asked about each message in turn.
      cancelled = receipt
        ? new Set(receipt.cancelled)
        : await this.cancelEach(driver, onStrip)
    } finally {
      this.stopsInFlight -= 1
    }
    // An image with its copy on disk goes back without its bytes: the window
    // has the copy, and main reads it again on the next send. Nothing goes
    // back from a strip that was handed to a successor meanwhile.
    const returned: UserInput[] = []
    if (epoch === this.outboxEpoch) {
      for (const entry of onStrip) {
        if (cancelled.has(entry.uuid)) {
          this.outbox.remove(entry.uuid)
          returned.push(withoutCopiedBytes(entry.input))
        } else if (this.outbox.get(entry.uuid) === entry) {
          // The CLI kept it, or the agent read it first: it is as it was.
          entry.requestedCancel = false
          this.outbox.mark(entry.uuid, before.get(entry.uuid)!)
        }
      }
      if (onStrip.length > 0) this.emitQueue()
    }
    // A question asked while the interrupt was on its way belongs to the
    // turn being stopped and is refused with it; left open, it would hold a
    // count of one behind an idle tab.
    this.cancelWaits({ upTo: stopped })
    if (this.turn !== stopped) return returned
    this.turnRunning = false
    this.heldByQueue = false
    this.queuedTurns = 0
    this.setStatus('idle')
    return returned
  }

  /**
   * «Отменить» (and «Изменить»): takes a message off the strip before the
   * agent reads it, and hands it back. Null when it is not there, when the
   * agent has read it already (its bubble is on its way), or when this CLI
   * cannot take it back.
   */
  async cancelQueued(id: string): Promise<UserInput | null> {
    const entry = this.outbox.get(id)
    if (!entry || entry.requestedCancel) return null
    const driver = this.driver
    // Still only Qclod's — the agent is starting, or the one it went to is
    // gone: nothing to ask anyone.
    if (entry.state === 'waiting' || !driver) {
      this.dropEntry(id)
      return withoutCopiedBytes(entry.input)
    }
    const was = entry.state
    entry.requestedCancel = true
    this.outbox.mark(id, 'cancelling')
    this.emitQueue()
    const epoch = this.outboxEpoch
    const answer = await this.cancelSafely(driver, id)
    // Handed to a successor meanwhile: it is that session's to send.
    if (epoch !== this.outboxEpoch) return null
    if (answer === true) {
      // Its `cancelled` frame may have taken it off the strip already.
      this.dropEntry(id)
      return withoutCopiedBytes(entry.input)
    }
    if (this.outbox.get(id) === entry) {
      entry.requestedCancel = false
      this.outbox.mark(id, was)
      this.emitQueue()
    }
    return null
  }

  /**
   * «Отправить сейчас»: taken back and sent again with `priority: 'now'`,
   * under a new uuid — the strip shows it as a new entry. A CLI that cannot
   * take it back has it queued already: the turn is stopped, and it goes
   * first. False when it is not on the strip, or the agent has read it.
   */
  async sendQueuedNow(id: string): Promise<boolean> {
    const entry = this.outbox.get(id)
    const driver = this.driver
    if (!entry || !driver || !this.cliQueue || entry.requestedCancel) return false
    if (entry.state !== 'sending' && entry.state !== 'queued') return false
    // Its `cancelled` frame is our doing, not a stopped turn's.
    entry.requestedCancel = true
    const epoch = this.outboxEpoch
    this.resending.add(id)
    let answer: boolean | null
    try {
      answer = await this.cancelSafely(driver, id)
    } finally {
      this.resending.delete(id)
    }
    if (epoch !== this.outboxEpoch || this.driver !== driver) return false
    if (answer === true) {
      // Off and on again in one go, so the tab is not let go in between.
      this.outbox.remove(id)
      this.enqueue(entry.input, randomUUID(), 'now')
      return true
    }
    if (this.outbox.get(id) === entry) entry.requestedCancel = false
    if (answer === false) return false
    // A turn genuinely under way is stopped; between turns it goes next anyway.
    if (this.turnRunning && !this.heldByQueue) {
      // As with «Стоп»: the SDK abandons an open question without saying so.
      this.cancelWaits({ upTo: this.turn })
      await this.interruptSafely(driver)
    }
    return true
  }

  /**
   * Empties the strip and hands over what was on it, to a successor. With
   * the process gone, everything there is unread: the CLI lost its queue.
   */
  takeQueue(): UserInput[] {
    const entries = this.outbox.pending()
    if (entries.length === 0) return []
    this.outboxEpoch += 1
    for (const entry of entries) this.outbox.remove(entry.uuid)
    this.emitQueue()
    return entries.map((e) => e.input)
  }

  /**
   * Takes over a predecessor's strip. A session that is up sends it all at
   * once, as if just typed; one that is not holds it until it is.
   */
  requeue(inputs: UserInput[]): void {
    if (inputs.length === 0) return
    if (!this.driver) {
      for (const input of inputs) this.hold(input)
      return
    }
    for (const input of inputs) this.dispatch(input, randomUUID())
  }

  /** The agent is up: everything held for it goes, in order, each under the uuid it was given. */
  private flushWaiting(): boolean {
    const waiting = this.outbox.pending().filter((e) => e.state === 'waiting')
    if (!this.driver || waiting.length === 0) return false
    for (const entry of waiting) {
      this.outbox.remove(entry.uuid)
      this.dispatch(entry.input, entry.uuid)
    }
    this.emitQueue()
    return true
  }

  /** Off the strip without the agent reading it. */
  private dropEntry(uuid: string): void {
    if (!this.outbox.remove(uuid)) return
    this.emitQueue()
    this.releaseIfDone(true)
  }

  /**
   * The agent read one of the strip's messages: its bubble shows now. If no
   * turn was under way — or the last one had ended with this waiting — it
   * starts one.
   */
  private onRead(entry: OutboxEntry): void {
    this.showUser(entry.input, entry.composed)
    if (this.session === null) this.unintroduced.push({ ...entry.input, text: entry.composed })
    if (this.turnRunning && !this.heldByQueue) return
    this.turn += 1
    this.turnRunning = true
    this.heldByQueue = false
    if (this.queuedTurns > 0) this.queuedTurns -= 1
    if (this.waits === 0) this.setStatus('busy')
  }

  /**
   * Whether a result held back by the CLI's queue can let the tab go: nothing
   * left on the strip with the CLI and no turn it said was waiting. `taken`
   * — a message just came off the strip unread, one turn fewer to wait for.
   */
  private releaseIfDone(taken = false): void {
    if (!this.heldByQueue) return
    if (taken && this.queuedTurns > 0) this.queuedTurns -= 1
    if (this.cliOwesTurn()) return
    this.heldByQueue = false
    this.turnRunning = false
    if (this.waits === 0) this.setStatus('idle')
  }

  /** The CLI still has something of this tab's to run. */
  private cliOwesTurn(): boolean {
    return this.queuedTurns > 0 || this.outbox.pending().some((e) => e.state !== 'waiting')
  }

  /** A driver that throws (a session already closed) cannot cancel: the same as a CLI that cannot. */
  private async cancelSafely(driver: AgentDriver, uuid: string): Promise<boolean | null> {
    try {
      return await driver.cancelQueued(uuid)
    } catch {
      return null
    }
  }

  private async interruptSafely(
    driver: AgentDriver,
    opts?: { cancelQueued?: boolean }
  ): Promise<InterruptReceipt | undefined> {
    try {
      return await driver.interrupt(opts)
    } catch {
      return undefined
    }
  }

  /** Which of these the CLI took back, asked one by one. */
  private async cancelEach(driver: AgentDriver, entries: OutboxEntry[]): Promise<Set<string>> {
    const answers = await Promise.all(entries.map((e) => this.cancelSafely(driver, e.uuid)))
    return new Set(entries.filter((_, i) => answers[i] === true).map((e) => e.uuid))
  }

  private emitQueue(): void {
    this.emitPanel(this.collector.setQueue(this.outbox.view(this.cliQueue && this.driver !== null)))
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
    if (!(await this.allowMode(mode, true))) {
      // The panel's select is controlled on what the panel knows, so a refusal
      // must still be reported — otherwise it keeps showing the mode the user
      // picked while the session is in another one, and the panel's whole
      // premise is that it shows the truth (spec 6.5).
      this.emitPanel(this.collector.currentPermissionMode())
      return
    }
    const was = this.mode
    const driver = this.driver
    if (driver && sdkPermissionMode(mode) !== sdkPermissionMode(was)) {
      try {
        await driver.setPermissionMode(sdkPermissionMode(mode))
      } catch (err) {
        // The CLI refused: the session stays where it was, and says so —
        // a mode that silently did not switch is how «без проверок» kept
        // asking about everything.
        if (this.driver !== driver) return
        const reason = err instanceof Error ? err.message : String(err)
        this.emit(
          this.builder.notice(
            `Режим «${MODE_NAMES[mode] ?? mode}» не включился: ${reason}`,
            'error'
          )
        )
        this.emitPanel(this.collector.currentPermissionMode())
        return
      }
    }
    this.mode = mode
    this.emitPanel(this.collector.setPermissionMode(mode))
    if (mode === 'autoAllow' && was !== 'autoAllow') {
      this.emit(
        this.builder.notice(
          'Режим «авто-да»: Qclod сам отвечает «разрешить» на каждый запрос агента. ' +
            'Сохранённые запреты по-прежнему действуют, вопросы и планы — за вами.',
          'info'
        )
      )
    }
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

  /**
   * The end of a background task's output. Only a task this tab lists is
   * asked about: an id from anywhere else never reaches the agent.
   */
  async taskOutput(taskId: string): Promise<TaskOutput | null> {
    const driver = this.driver
    if (!driver || !this.backgroundTasks.tasks.some((t) => t.taskId === taskId)) return null
    return driver.taskOutput(taskId).catch(() => null)
  }

  /** Stops one of this tab's background tasks while it is still running. */
  async stopTask(taskId: string): Promise<void> {
    const driver = this.driver
    const task = this.backgroundTasks.tasks.find((t) => t.taskId === taskId)
    if (!driver || task?.status !== 'running') return
    // The task's notification, not this call, tells the list it has ended.
    // A refusal is the user's to see: it reaches the row that asked.
    await driver.stopTask(taskId)
  }

  /** The agent is gone: its background tasks are cut off with it. */
  private cutOffBackground(): void {
    const tasks = this.backgroundTasks.endAll('interrupted')
    if (tasks) this.emitPanel(this.collector.setBackgroundTasks(tasks))
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
    // The strip is dropped with the session by design: a closed tab's
    // messages have nowhere to go. A swap takes it first (`takeQueue`).
    this.stopMcpPolling()
    this.stopPanelRefresh()
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
    const bridgeLive = isRemoteLive(this.remoteInfo)
    const closing = (async () => {
      // The phone is told «выключено» rather than left to time out — briefly:
      // a bridge that does not answer must not hold the close.
      if (driver && bridgeLive) await this.remoteOffBeforeClose(driver)
      if (driver) await driver.dispose().catch(() => undefined)
      await pump?.catch(() => undefined)
    })()
    await Promise.race([closing, limit])
    clearTimeout(timer)
    this.setRemoteInfo(REMOTE_OFF)
    this.setStatus('stopped')
  }

  private async remoteOffBeforeClose(driver: AgentDriver): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REMOTE_OFF_TIMEOUT_MS)
    })
    const off = (async () => {
      await driver.setRemoteControl(false)
    })().catch(() => undefined)
    await Promise.race([off, limit])
    clearTimeout(timer)
  }

  // ------------------------------------------------------------- the pump

  /**
   * Two modes need asking about. «Без проверок» is asked about every time,
   * a start included. «Авто-да» is asked about when it is switched on: a tab
   * reopened in it was confirmed then, and keeps its own choice.
   */
  private async allowMode(mode: string, switching = false): Promise<boolean> {
    if (mode === 'autoAllow') {
      if (!switching || this.mode === 'autoAllow') return true
      const confirm = this.options.confirmAutoAllow
      return confirm ? confirm() : false
    }
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
      // The stream ending by itself means the agent exited: the session is
      // dead, as after a crash, only without an error of its own to show.
      // fail() also turns the bridge off — no process, no Remote Control.
      if (this.driver === driver) this.fail(new Error(AGENT_EXITED), { quiet: true })
    } catch (err) {
      if (this.driver === driver) this.fail(err)
    }
  }

  /** Feeds one message in, as the stream would. Exposed for tests. */
  handle(message: unknown): void {
    this.onMessage(message)
  }

  private onMessage(message: unknown): void {
    const changes = this.builder.apply(message)
    this.emit(changes)
    // A message typed on the phone starts a turn of its own — unless one is
    // under way, which it then joins: the bubble shows, nothing is counted twice.
    if (
      !this.turnRunning &&
      changes.some((c) => c.kind === 'append' && c.item.kind === 'user' && c.item.remote)
    ) {
      this.turn += 1
      this.turnRunning = true
      if (this.waits === 0) this.setStatus('busy')
    }
    const remote = remoteFromMessage(message, this.remoteInfo)
    if (remote) {
      this.setRemoteInfo(remote)
      if (remote.state === 'failed' && remote.problem) {
        this.emit(this.builder.notice(remote.problem, 'error'))
      }
    }
    const panel = this.collector.apply(message)
    if (panel) {
      // The collector is the one place that knows the current mode — it also
      // knows not to let a restart overrule what the user chose.
      this.mode = this.collector.data.permissionMode
      this.emitPanel(panel)
    }
    const tasks = this.backgroundTasks.apply(message)
    if (tasks) this.emitPanel(this.collector.setBackgroundTasks(tasks))
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
      case 'command_lifecycle':
        this.onLifecycle(m)
        break
      case 'result':
        this.onResult(m)
        this.background(this.refreshContext())
        // A turn spends the plan; rate_limit_event does not always say so.
        this.background(this.refreshLimits())
        break
      default:
        break
    }
  }

  /**
   * The CLI's account of a message sent with a uuid. Only what is on the
   * strip is followed: a frame for anything else — the message that started
   * the turn, one sent from the phone — is ignored (ruling R5).
   */
  private onLifecycle(m: Record<string, unknown>): void {
    if (!this.cliQueue) {
      this.cliQueue = true
      if (this.outbox.size > 0) this.emitQueue()
    }
    const uuid = m['command_uuid']
    const entry = typeof uuid === 'string' ? this.outbox.get(uuid) : undefined
    if (!entry) return
    switch (m['state']) {
      case 'queued':
        // One being taken back stays so until the CLI answers.
        if (entry.state === 'sending') {
          this.outbox.mark(entry.uuid, 'queued')
          this.emitQueue()
        }
        break
      case 'started':
        this.outbox.remove(entry.uuid)
        this.emitQueue()
        this.onRead(entry)
        break
      case 'cancelled':
        if (this.resending.has(entry.uuid)) {
          // «Отправить сейчас»: it comes back under a new uuid in a moment.
          this.outbox.remove(entry.uuid)
          this.emitQueue()
          break
        }
        this.dropEntry(entry.uuid)
        if (!entry.requestedCancel) {
          this.emit(this.builder.notice(`${NOT_DELIVERED} — «${entry.input.text}»`, 'error'))
        }
        break
      default:
        break
    }
  }

  /**
   * The end of a turn. The tab is free only when the CLI has nothing more of
   * its to run — no turn it says is waiting (`queued_turn_count`), nothing on
   * the strip it holds; otherwise it stays busy (ruling R4).
   */
  private onResult(m: Record<string, unknown>): void {
    // What the turn read, by its uuids: anything on the strip it names was
    // read without a frame saying so, and shows now rather than never.
    const read = Array.isArray(m['user_message_uuids']) ? m['user_message_uuids'] : []
    for (const uuid of read) {
      const entry = typeof uuid === 'string' ? this.outbox.get(uuid) : undefined
      if (!entry || entry.state === 'waiting') continue
      this.outbox.remove(entry.uuid)
      this.emitQueue()
      this.onRead(entry)
    }
    const count = m['queued_turn_count']
    this.queuedTurns = typeof count === 'number' && count > 0 ? count : 0
    this.heldByQueue = this.cliOwesTurn()
    if (this.heldByQueue) return
    this.turnRunning = false
    this.setStatus('idle')
  }

  private onInit(m: Record<string, unknown>): void {
    // init comes again with every turn; what it says of the queue only ever turns it on.
    if (!this.cliQueue && queueModeFrom(m) === 'cli') {
      this.cliQueue = true
      if (this.outbox.size > 0) this.emitQueue()
    }
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
  private async refreshContext(detail?: 'summary' | 'full'): Promise<void> {
    const driver = this.driver
    if (!driver) return
    try {
      const usage = detail ? await driver.getContextUsage({ detail }) : await driver.getContextUsage()
      if (this.driver !== driver) return
      this.emitPanel(this.collector.setContext(usage))
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

    // «Авто-да»: the agent asked, Qclod answers. No card and no «ждёт» —
    // the tool's own card shows what ran. A saved deny rule still refuses.
    if (this.mode === 'autoAllow') {
      if (opts.signal?.aborted) return { behavior: 'deny' }
      try {
        return await ask(
          { requestId, tabId: this.options.tabId, toolName, target, input, auto: true },
          opts.signal ?? new AbortController().signal
        )
      } catch {
        return { behavior: 'deny' }
      }
    }

    // The question is cancelled through a controller of the session's own,
    // so «Стоп» reaches it whether or not the SDK ever fires its signal.
    const controller = new AbortController()
    // Set only when the SDK itself gave up — with the bridge live, that is the
    // phone having answered. «Стоп» aborts the controller, not this.
    let sdkAborted = false
    const cancel = (): void => {
      sdkAborted = true
      controller.abort()
    }
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
      const state =
        sdkAborted && isRemoteLive(this.remoteInfo)
          ? 'elsewhere'
          : answer.behavior === 'allow'
            ? 'allowed'
            : 'denied'
      this.emit(this.builder.resolvePermission(requestId, state))
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
      // The SDK gave up on the plan: it can no longer be approved. With the
      // bridge live, the phone decided it.
      const onAbort = (): void => {
        if (this.pendingPlans.get(requestId)?.resolve !== settle) return
        this.pendingPlans.delete(requestId)
        this.leaveWait()
        this.emit(
          this.builder.resolvePlan(requestId, isRemoteLive(this.remoteInfo) ? 'elsewhere' : 'rejected')
        )
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
        // Answered on the phone: the card closes rather than waiting for a click.
        if (isRemoteLive(this.remoteInfo)) this.emit(this.builder.closeQuestionElsewhere(toolUseId))
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
  private fail(err: unknown, opts: { quiet?: boolean } = {}): void {
    // A closed session has nothing left to fail; a late callback of its
    // would write into a ribbon its successor carries on.
    if (this.disposed) return
    this.turnRunning = false
    this.heldByQueue = false
    this.queuedTurns = 0
    this.stopPanelRefresh()
    const text = err instanceof Error ? err.message : String(err)
    const dead = this.driver
    this.driver = null
    // The strip stays, unread, for the session taking this one's place
    // (`takeQueue`); nothing on it can be hurried any more.
    if (this.outbox.size > 0) this.emitQueue()
    // The process may still be alive; and cards nobody can answer any more
    // must not stay live (a click could save a rule from a dead session).
    this.cancelWaits()
    if (dead) void dead.dispose().catch(() => undefined)
    this.cutOffBackground()
    // No process, no bridge.
    this.setRemoteInfo(REMOTE_OFF)
    this.failure = text
    this.emit(this.builder.closeOpen())
    // «Not logged in · Please run /login» names a command the user has no
    // terminal for; the notice offers the button instead. The raw words stay
    // in `error`, where the tab reads why the session died.
    if (opts.quiet) {
      this.emit(this.builder.notice(`${text}.`, 'info'))
    } else if (classifyStartFailure(text) !== 'not-logged-in') {
      this.emit(this.builder.notice(explain(text), 'error'))
    } else if (!this.toldToLogIn()) {
      this.emit(this.builder.notice(LOGIN_NEEDED_TEXT, 'error', 'login'))
    }
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
