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
import { resolveExecutable } from './resolveExecutable'

export interface AgentSessionOptions {
  tabId: TabId
  cwd: string
  overrides: LaunchOverrides
  /** The configured path, as typed in settings — resolved on every start. */
  agentPath: string
  resolveAgent?: (requested: string) => string
  createDriver: DriverFactory
  /** Asks the user about a tool. Supplied by the permission layer (Task 6). */
  askPermission?: (request: PermissionRequest) => Promise<PermissionAnswer>
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
    if (!ask) return { behavior: 'allow' }

    const previous = this.state
    this.setStatus('waiting')
    try {
      return await ask({
        requestId: opts.toolUseId ?? `${this.options.tabId}:${Date.now()}`,
        tabId: this.options.tabId,
        toolName,
        target: '',
        input
      })
    } finally {
      this.setStatus(previous === 'waiting' ? 'busy' : previous)
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
