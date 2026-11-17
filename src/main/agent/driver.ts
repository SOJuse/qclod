import type {
  CommandInfo,
  EffortLevel,
  McpServerInfo,
  ModelOption,
  PanelData,
  PermissionAnswer,
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
  send(input: UserInput): void
  interrupt(): Promise<void>
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
  /** Whether this SDK, CLI and login can run Remote Control, and if not, why. */
  remoteAvailability(): Promise<RemoteAvailability>
  /**
   * Turns Remote Control on (returning the session's link) or off (null).
   * Rejects when the CLI refuses; the caller explains it.
   */
  setRemoteControl(enabled: boolean, name?: string): Promise<RemoteLink | null>
  dispose(): Promise<void>
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
}

export type DriverFactory = (options: DriverOptions) => AgentDriver | Promise<AgentDriver>
