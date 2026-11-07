import type { CommandInfo, McpServerInfo, PermissionAnswer, UserInput } from '../../shared/types'

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
  getContextUsage(): Promise<ContextUsage>
  dispose(): Promise<void>
}

export interface ContextUsage {
  totalTokens: number
  maxTokens: number
  percentage: number
  categories: Array<{ name: string; tokens: number; kind?: string }>
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
  /** Called before a tool runs; the answer decides whether it does. */
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseId?: string }
  ) => Promise<PermissionAnswer>
}

export type DriverFactory = (options: DriverOptions) => AgentDriver | Promise<AgentDriver>
