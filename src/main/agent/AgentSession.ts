import { randomUUID } from 'node:crypto'
import { RibbonBuilder } from '../../shared/ribbon'
import type {
  CommandInfo,
  EffortLevel,
  ModelOption,
  LaunchOverrides,
  McpServerInfo,
  PanelData,
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
import { AgentNotFoundError } from './resolveExecutable'
import { findAgent } from '../setup/findAgent'

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
   */
  askPermission: (request: PermissionRequest) => Promise<PermissionAnswer>
  /**
   * Asks the person, outside the window, whether they really mean to turn the
   * permission gate off. Required: a session built without it refuses
   * `bypassPermissions` outright rather than assuming consent.
   */
  confirmBypass?: () => Promise<boolean>
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
 * The model that last answered in a conversation's history. `<synthetic>` is
 * what the CLI writes on messages it made up itself (an API error, say) — not
 * a model anyone could be on.
 */
function lastAssistantModel(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m !== 'object' || m === null) continue
    const record = m as Record<string, unknown>
    if (record['type'] !== 'assistant') continue
    const inner = record['message']
    if (typeof inner !== 'object' || inner === null) continue
    const model = (inner as Record<string, unknown>)['model']
    if (typeof model === 'string' && model !== '' && model !== '<synthetic>') return model
  }
  return null
}

/** The text of an AskUserQuestion's first question — the key its answer goes under. */
function firstQuestion(input: Record<string, unknown>): string {
  const questions = input['questions']
  const first: unknown = Array.isArray(questions) ? questions[0] : undefined
  if (typeof first !== 'object' || first === null) return ''
  const text = (first as Record<string, unknown>)['question']
  return typeof text === 'string' ? text : ''
}

type ChangeListener = (changes: RibbonChange[]) => void
type PanelListener = (patch: Partial<PanelData>) => void
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
  private readonly builder = new RibbonBuilder()
  private readonly collector = new PanelCollector()
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
  private disposed = false
  /** Questions the agent asked through canUseTool, waiting on the user. */
  private readonly pendingQuestions = new Map<
    string,
    { input: Record<string, unknown>; resolve: (answer: PermissionAnswer) => void }
  >()
  private readonly pendingPlans = new Map<string, (answer: PermissionAnswer) => void>()

  constructor(options: AgentSessionOptions) {
    this.options = options
    this.mode = options.overrides.permissionMode ?? 'default'
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

  get todo(): TodoItem[] {
    return this.todoItems
  }

  onChange(cb: ChangeListener): void {
    this.changeListeners.push(cb)
  }

  onPanel(cb: PanelListener): void {
    this.panelListeners.push(cb)
  }

  onStatus(cb: StatusListener): void {
    this.statusListeners.push(cb)
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
   * Rebuilds the ribbon from a past conversation's messages.
   *
   * Replay must never be mistaken for live traffic: it adds items and touches
   * nothing else — no status change, no cost counted twice. The one panel
   * line it may fill is the model, and only until the process names its own:
   * a resumed CLI says nothing until it is written to.
   * What the old process left running is closed as unfinished at the end:
   * that process is gone and will never report back.
   */
  replay(messages: unknown[]): RibbonChange[] {
    const changes: RibbonChange[] = []
    for (const message of messages) changes.push(...this.builder.apply(message))
    changes.push(...this.builder.finishReplay())
    const todo = this.builder.todo
    if (todo) this.todoItems = todo
    const model = lastAssistantModel(messages)
    if (model) this.emitPanel(this.collector.seedModel(model))
    return changes
  }

  /**
   * The user picked an option on a question card.
   *
   * A question the agent is still waiting on is answered in place: the SDK
   * takes the answer as `updatedInput.answers` (question text -> choice;
   * AskUserQuestionInput in sdk-tools.d.ts), and the agent carries on with
   * the same turn. Only when nothing is waiting — a card from history, a
   * question left over after «Стоп» — does the choice go as a message, which
   * is what the user would have typed anyway.
   */
  answerQuestion(toolUseId: string, choice: string): void {
    this.emit(this.builder.answerQuestion(toolUseId, choice))

    const waiting = this.pendingQuestions.get(toolUseId)
    if (!waiting) {
      this.send({ text: choice, attachments: [] })
      return
    }
    this.pendingQuestions.delete(toolUseId)
    waiting.resolve({
      behavior: 'allow',
      updatedInput: { ...waiting.input, answers: { [firstQuestion(waiting.input)]: choice } }
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

    this.emit(this.builder.resolvePlan(requestId, approve ? 'approved' : 'rejected'))
    if (!approve) {
      waiting({ behavior: 'deny' })
      return
    }

    // The mode must be in place before the tool runs, not racing it.
    await this.setPermissionMode('acceptEdits')
    waiting({ behavior: 'allow' })
  }

  /** Something Qclod itself needs to say — a crash, a session that would not resume. */
  notice(text: string, tone: 'info' | 'error' = 'info'): RibbonChange[] {
    return this.builder.notice(text, tone)
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
          // where the installers put it.
          const found = findAgent(p, process.env)
          if (!found) throw new AgentNotFoundError(p)
          return found
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
    void this.applyStoredEffort().catch(() => undefined)
    void this.refreshContext().catch(() => undefined)
    void this.refreshModels().catch(() => undefined)
    void this.refreshMcp().catch(() => undefined)
    void this.refreshLimits().catch(() => undefined)
  }

  /** The level this tab was left at, from tabs.json — the session's, not the user's settings. */
  private async applyStoredEffort(): Promise<void> {
    const effort = this.options.overrides.effort
    const driver = this.driver
    if (!effort || !driver) return
    this.emitPanel(this.collector.setEffort(effort))
    await driver.setEffort(effort)
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
    this.emit(this.builder.addUser(input.text, input.attachments, text))
    this.setStatus('busy')
    this.driver.send({ ...input, text })
  }

  async interrupt(): Promise<void> {
    if (!this.driver) return
    await this.driver.interrupt().catch(() => undefined)
    this.setStatus('idle')
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (!(await this.allowMode(mode))) {
      // The panel's select is controlled on what the panel knows, so a refusal
      // must still be reported — otherwise it keeps showing the mode the user
      // picked while the session is in another one, and the panel's whole
      // premise is that it shows the truth (spec 6.5).
      this.emitPanel({ permissionMode: this.collector.data.permissionMode })
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

  /** Live MCP state, asked for only while the panel is open (spec 6.5). */
  async refreshMcp(): Promise<void> {
    if (!this.driver) return
    const mcp = await this.driver.mcpServerStatus().catch((): McpServerInfo[] => [])
    if (mcp.length > 0) this.emitPanel({ mcp })
  }

  /** Everything the panel knows about this tab right now. */
  get panel(): PanelData {
    return this.collector.data
  }

  async dispose(): Promise<void> {
    this.disposed = true
    // A question nobody can answer any more must not hold the agent open.
    for (const [, waiting] of this.pendingQuestions) waiting.resolve({ behavior: 'deny' })
    this.pendingQuestions.clear()
    for (const [, resolve] of this.pendingPlans) resolve({ behavior: 'deny' })
    this.pendingPlans.clear()

    const driver = this.driver
    this.driver = null
    if (driver) await driver.dispose().catch(() => undefined)
    await this.pump?.catch(() => undefined)
    this.pump = null
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
        else if (m['subtype'] === 'commands_changed') this.onCommandsChanged(m)
        break
      case 'result':
        this.setStatus('idle')
        void this.refreshContext()
        break
      default:
        break
    }
  }

  private onInit(m: Record<string, unknown>): void {
    const id = typeof m['session_id'] === 'string' ? m['session_id'] : null
    if (id && id !== this.session) {
      this.session = id
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
    void this.refreshModels()
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

    const previous = this.state
    this.setStatus('waiting')
    try {
      let answer: PermissionAnswer
      try {
        answer = await ask({ requestId, tabId: this.options.tabId, toolName, target, input })
      } catch {
        // A gate that failed is not a gate that said yes.
        answer = { behavior: 'deny' }
      }
      this.emit(
        this.builder.resolvePermission(requestId, answer.behavior === 'allow' ? 'allowed' : 'denied')
      )
      return answer
    } finally {
      this.setStatus(previous === 'waiting' ? 'busy' : previous)
    }
  }

  private askPlan(
    input: Record<string, unknown>,
    opts: ToolPermissionContext
  ): Promise<PermissionAnswer> {
    const requestId = opts.toolUseId ?? randomUUID()
    const text = typeof input['plan'] === 'string' ? input['plan'] : ''
    this.emit(this.builder.addPlan(requestId, text))

    const previous = this.state
    this.setStatus('waiting')
    return new Promise<PermissionAnswer>((resolve) => {
      this.pendingPlans.set(requestId, (answer) => {
        this.setStatus(previous === 'waiting' ? 'busy' : previous)
        resolve(answer)
      })
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

    const previous = this.state
    this.setStatus('waiting')
    return new Promise<PermissionAnswer>((resolve) => {
      this.pendingQuestions.set(toolUseId, {
        input,
        resolve: (answer) => {
          this.setStatus(previous === 'waiting' ? 'busy' : previous)
          resolve(answer)
        }
      })
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
    const text = err instanceof Error ? err.message : String(err)
    this.driver = null
    this.failure = text
    this.emit(this.builder.closeOpen())
    this.emit(this.builder.notice(explain(text), 'error'))
    this.setStatus('error')
  }

  private emit(changes: RibbonChange[]): void {
    if (changes.length === 0) return
    for (const listener of this.changeListeners) listener(changes)
  }

  private emitPanel(patch: Partial<PanelData>): void {
    if (Object.keys(patch).length === 0) return
    for (const listener of this.panelListeners) listener(patch)
  }

  private setStatus(status: SessionStatus): void {
    if (this.state === status) return
    this.state = status
    for (const listener of this.statusListeners) listener(status)
    if (this.settled()) {
      const waiters = this.idleWaiters.splice(0)
      for (const resolve of waiters) resolve()
    }
  }
}
