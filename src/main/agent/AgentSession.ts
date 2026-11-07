import { RibbonBuilder } from '../../shared/ribbon'
import type {
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
import { displayTarget } from './permissionStore'
import { resolveExecutable } from './resolveExecutable'

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
}

type ChangeListener = (changes: RibbonChange[]) => void
type PanelListener = (patch: Partial<PanelData>) => void
type StatusListener = (status: SessionStatus) => void

function splitArgs(flags: string | undefined): string[] {
  if (!flags) return []
  return flags.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? []
}

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
  private readonly changeListeners: ChangeListener[] = []
  private readonly panelListeners: PanelListener[] = []
  private readonly statusListeners: StatusListener[] = []

  private driver: AgentDriver | null = null
  private pump: Promise<void> | null = null
  private state: SessionStatus = 'stopped'
  private failure: string | undefined
  private session: string | null = null
  private mode: string
  private todoItems: TodoItem[] = []
  private readonly idleWaiters: Array<() => void> = []
  /** Questions the agent asked through canUseTool, waiting on the user. */
  private readonly pendingQuestions = new Map<string, (answer: PermissionAnswer) => void>()

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
   * nothing else — no status change, no panel update, no cost counted twice.
   */
  replay(messages: unknown[]): RibbonChange[] {
    const changes: RibbonChange[] = []
    for (const message of messages) changes.push(...this.builder.apply(message))
    const todo = this.builder.todo
    if (todo) this.todoItems = todo
    return changes
  }

  /**
   * The user picked an option on a question card.
   *
   * The answer goes back as an ordinary message. The SDK's types do not say
   * how an AskUserQuestion answer travels in a headless session, and inventing
   * a protocol frame would be guessing; a message is what the user would have
   * typed anyway, the agent reads it the same way, and nothing depends on a
   * shape we have not verified.
   */
  answerQuestion(toolUseId: string, choice: string): void {
    this.emit(this.builder.answerQuestion(toolUseId, choice))

    const waiting = this.pendingQuestions.get(toolUseId)
    if (waiting) {
      this.pendingQuestions.delete(toolUseId)
      waiting({ behavior: 'deny' })
    }

    this.send({ text: choice, attachments: [] })
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

  /** Something Qclod itself needs to say — a crash, a session that would not resume. */
  notice(text: string, tone: 'info' | 'error' = 'info'): RibbonChange[] {
    return this.builder.notice(text, tone)
  }

  async start(resumeId?: string): Promise<void> {
    if (this.driver) return
    this.setStatus('starting')
    this.failure = undefined

    let executablePath: string
    try {
      const resolve = this.options.resolveAgent ?? ((p: string) => resolveExecutable(p, process.env))
      executablePath = resolve(this.options.agentPath)
    } catch (err) {
      this.fail(err)
      return
    }

    const driverOptions: DriverOptions = {
      cwd: this.options.cwd,
      executablePath,
      model: this.options.overrides.model,
      permissionMode: this.mode,
      extraArgs: splitArgs(this.options.overrides.extraFlags),
      resume: resumeId,
      canUseTool: (toolName, input, opts) => this.onToolPermission(toolName, input, opts)
    }

    try {
      this.driver = await this.options.createDriver(driverOptions)
    } catch (err) {
      this.fail(err)
      return
    }

    this.pump = this.readMessages(this.driver)
  }

  send(input: UserInput): void {
    if (!this.driver) return
    this.emit(this.builder.addUser(input.text, input.attachments))
    this.setStatus('busy')
    this.driver.send(input)
  }

  async interrupt(): Promise<void> {
    if (!this.driver) return
    await this.driver.interrupt().catch(() => undefined)
    this.setStatus('idle')
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.mode = mode
    // The SDK reports the mode at start and never again, so ours is the
    // authority once we change it (spec 6.5).
    this.emitPanel({ permissionMode: mode as PanelData['permissionMode'] })
    if (!this.driver) return
    await this.driver.setPermissionMode(mode).catch(() => undefined)
  }

  async commands(): Promise<ReturnType<AgentDriver['supportedCommands']>> {
    if (!this.driver) return []
    return this.driver.supportedCommands().catch(() => [])
  }

  /** Live MCP state, asked for only while the panel is open (spec 6.5). */
  async refreshMcp(): Promise<void> {
    if (!this.driver) return
    const mcp = await this.driver.mcpServerStatus().catch((): McpServerInfo[] => [])
    if (mcp.length > 0) this.emitPanel({ mcp })
  }

  async dispose(): Promise<void> {
    // A question nobody can answer any more must not hold the agent open.
    for (const [, resolve] of this.pendingQuestions) resolve({ behavior: 'deny' })
    this.pendingQuestions.clear()

    const driver = this.driver
    this.driver = null
    if (driver) await driver.dispose().catch(() => undefined)
    await this.pump?.catch(() => undefined)
    this.pump = null
    this.setStatus('stopped')
  }

  // ------------------------------------------------------------- the pump

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

  private onMessage(message: unknown): void {
    this.emit(this.builder.apply(message))
    const todo = this.builder.todo
    if (todo) this.todoItems = todo

    if (typeof message !== 'object' || message === null) return
    const m = message as Record<string, unknown>

    switch (m['type']) {
      case 'system':
        if (m['subtype'] === 'init') this.onInit(m)
        break
      case 'rate_limit_event':
        this.onRateLimit(m)
        break
      case 'result':
        this.onResult(m)
        break
      default:
        break
    }
  }

  private onInit(m: Record<string, unknown>): void {
    this.session = typeof m['session_id'] === 'string' ? m['session_id'] : this.session
    const patch: Partial<PanelData> = {}
    if (typeof m['model'] === 'string') patch.model = m['model']
    if (typeof m['permissionMode'] === 'string') {
      this.mode = m['permissionMode']
      patch.permissionMode = m['permissionMode'] as PanelData['permissionMode']
    }
    if (Array.isArray(m['mcp_servers'])) {
      patch.mcp = (m['mcp_servers'] as McpServerInfo[]).map((s) => ({
        name: String(s.name),
        status: s.status
      }))
    }
    this.emitPanel(patch)
    this.setStatus('idle')
  }

  private onRateLimit(m: Record<string, unknown>): void {
    const info = m['rate_limit_info']
    if (typeof info !== 'object' || info === null) return
    const windows = (info as Record<string, unknown>)['unifiedWindows']
    if (typeof windows !== 'object' || windows === null) return
    const w = windows as Record<string, { utilization: number; resetsAt: number } | undefined>
    this.emitPanel({
      limits: { fiveHour: w['five_hour'] ?? null, sevenDay: w['seven_day'] ?? null }
    })
  }

  private onResult(m: Record<string, unknown>): void {
    const cost = m['total_cost_usd']
    if (typeof cost === 'number') this.emitPanel({ cost: { session: cost } })
    this.setStatus('idle')
    void this.refreshContext()
  }

  /** Context is not in the turn's result message (probe note 4): ask for it. */
  private async refreshContext(): Promise<void> {
    const driver = this.driver
    if (!driver) return
    try {
      const usage = await driver.getContextUsage()
      this.emitPanel({
        context: {
          used: usage.totalTokens,
          max: usage.maxTokens,
          percent: usage.percentage,
          categories: usage.categories
            .filter((c) => c.kind === undefined || c.kind === 'used')
            .map((c) => ({ name: c.name, tokens: c.tokens }))
        }
      })
    } catch {
      // A session that is shutting down cannot answer; the panel keeps its
      // last numbers rather than showing a hole.
    }
  }

  private async onToolPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseId?: string }
  ): Promise<PermissionAnswer> {
    const ask = this.options.askPermission

    // A question is not a permission: it has options, not «allow» and «deny»
    // (spec 6.2). It arrives through the same channel, so it is split out here
    // rather than shown as a permission the user cannot sensibly answer.
    if (toolName === 'AskUserQuestion') return this.askQuestion(input, opts)

    const requestId = opts.toolUseId ?? `${this.options.tabId}:${Date.now()}`
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

  private askQuestion(
    input: Record<string, unknown>,
    opts: { toolUseId?: string }
  ): Promise<PermissionAnswer> {
    const toolUseId = opts.toolUseId ?? `q-${Date.now()}`
    this.emit(this.builder.apply(this.questionMessage(toolUseId, input)))

    const previous = this.state
    this.setStatus('waiting')
    return new Promise<PermissionAnswer>((resolve) => {
      this.pendingQuestions.set(toolUseId, (answer) => {
        this.setStatus(previous === 'waiting' ? 'busy' : previous)
        resolve(answer)
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

  private fail(err: unknown): void {
    const text = err instanceof Error ? err.message : String(err)
    this.failure = text
    this.emit(this.builder.notice(text, 'error'))
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
