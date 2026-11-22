import type {
  CommandInfo,
  EffortLevel,
  McpServerInfo,
  ModelOption,
  PanelData,
  PermissionAnswer,
  TabServer,
  TaskOutput,
  UserInput
} from '../../shared/types'
import type { RemoteAvailability } from '../../shared/remote'
import type { ToolPermissionContext } from './permissionContext'

/**
 * Everything Qclod needs from an agent session, and nothing more.
 *
 * The real implementation wraps the Agent SDK's `query()`; the test fixture
 * implements the same shape. Keeping the surface this small is what lets the
 * whole app be tested without an account, a network or a single token spent —
 * and what keeps the real SDK's forty-odd message types from leaking into
 * every layer above.
 */
export interface AgentDriver {
  /** The session's message stream. It ends only when the session does. */
  readonly messages: AsyncIterable<unknown>
  send(input: UserInput, opts?: SendOptions): void
  /** true — снято с очереди; false — уже ушло агенту; null — этот SDK или CLI не умеет. */
  cancelQueued(uuid: string): Promise<boolean | null>
  interrupt(opts?: { cancelQueued?: boolean }): Promise<InterruptReceipt | undefined>
  setPermissionMode(mode: string): Promise<void>
  supportedCommands(): Promise<CommandInfo[]>
  mcpServerStatus(): Promise<McpServerInfo[]>
  /** `summary` answers from the last response's usage, without token-count calls. */
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<ContextUsage>
  supportedModels(): Promise<ModelOption[]>
  setModel(model: string): Promise<void>
  /** Session-scoped: never written to the user's settings files. */
  setEffort(level: EffortLevel): Promise<void>
  /**
   * The plan's rate-limit windows, asked for rather than waited for: the CLI
   * sends no `rate_limit_event` until it is given something to answer. Null
   * when the plan has none or this CLI cannot say.
   */
  planLimits(): Promise<PanelData['limits'] | null>
  /**
   * The end of a background task's output. Null when this SDK or CLI cannot
   * read it, or refused to for this task.
   */
  taskOutput(taskId: string): Promise<TaskOutput | null>
  stopTask(taskId: string): Promise<void>
  /** Уводит в фон задачу этого tool_use. true — увёл; false — нет такой на переднем плане; null — этот SDK/CLI не умеет или фон выключен. */
  backgroundTask(toolUseId: string): Promise<boolean | null>
  /** Whether this SDK, CLI and login can run Remote Control, and if not, why. */
  remoteAvailability(): Promise<RemoteAvailability>
  /**
   * Turns Remote Control on (returning the session's link) or off (null).
   * Rejects when the CLI refuses; the caller explains it.
   */
  setRemoteControl(enabled: boolean, name?: string): Promise<RemoteLink | null>
  /**
   * Ends the session. `detachOnly` (stage 6): a relay driver lets go of the
   * server's session and leaves its agent running; local drivers ignore it.
   */
  dispose(opts?: { detachOnly?: boolean }): Promise<void>
  /**
   * Stage 6: set by the relay's driver — this tab's AutonomyCore lives on the
   * server, so main makes none for it (AutonomyHost.tabAdded, task 19).
   */
  readonly hostsAutonomy?: true
}

export type SendPriority = 'now' | 'next' | 'later'
export interface SendOptions {
  uuid?: string
  priority?: SendPriority
}
export interface InterruptReceipt {
  stillQueued: string[]
  /**
   * Absent — this CLI has a receipt but cannot cancel on interrupt
   * (no interrupt_cancel_queued_v1): not the same as «nothing cancelled».
   */
  cancelled?: string[]
}

export interface RemoteLink {
  sessionUrl: string
  connectUrl?: string
}

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
  /** The model the session is on — the CLI knows it before init is sent. */
  model?: string
  categories: Array<{ name: string; tokens: number; kind?: 'used' | 'free' | 'buffer' | 'deferred' }>
}

export interface DriverOptions {
  cwd: string
  /** Resolved on every start, so changing the setting needs no restart. */
  executablePath: string
  model?: string | undefined
  permissionMode?: string | undefined
  /** Extra CLI arguments, already filtered: name (without --) to value. */
  extraArgs?: Record<string, string | null> | undefined
  /** Session id to continue, when the tab is picking a conversation back up. */
  resume?: string | undefined
  /**
   * Called before a tool runs; the answer decides whether it does. The
   * context carries the tool call's own id, so concurrent questions about
   * one message's tools never collide.
   */
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    context: ToolPermissionContext
  ) => Promise<PermissionAnswer>
  /** Stage 6: the tab's agent runs on this server, through its relay. */
  server?: TabServer | undefined
  /** Stage 6, the relay: claude's environment (the login shell's PATH). Absent — the process's own. */
  env?: Record<string, string | undefined> | undefined
}

export type DriverFactory = (options: DriverOptions) => AgentDriver | Promise<AgentDriver>
