/** Types for the fake SDK driver. The implementation lives in index.mjs. */

export type FakeStep =
  | { kind: 'text'; text: string }
  | { kind: 'textStream'; pieces: string[]; pauseMs?: number }
  | { kind: 'thinking'; text?: string; ms?: number }
  | { kind: 'tool'; name: string; input?: object; result?: string }
  | { kind: 'toolRunning'; name: string; input?: object }
  | { kind: 'toolError'; name: string; input?: object; error: string }
  | { kind: 'askPermission'; name: string; input?: object }
  | { kind: 'askPermissions'; tools: Array<{ name: string; input?: object }> }
  | {
      kind: 'askQuestion'
      /** Shorthand for a single question. */
      question?: string
      header?: string
      options?: string[]
      /** After the answer, say what the agent received as a text message. */
      echoAnswers?: boolean
      /** The full form: up to four questions. */
      questions?: Array<{ question: string; header?: string; options: string[]; multiSelect?: boolean }>
    }
  | { kind: 'todo'; items: Array<{ content: string; status: string }> }
  | {
      kind: 'subagent'
      name: string
      agentType?: string
      /** Run totals under the names AgentOutput uses (sdk-tools.d.ts). */
      stats?: { totalTokens?: number; totalDurationMs?: number; totalToolUseCount?: number }
      steps: FakeStep[]
    }
  | FakeBackgroundAgentStep
  | { kind: 'compact'; preTokens: number; postTokens: number; trigger?: 'auto' | 'manual' }
  | { kind: 'crash'; message: string }

/** An Agent call with run_in_background; its progress and notification come after the turn. */
export interface FakeBackgroundAgentStep {
  kind: 'backgroundAgent'
  name: string
  agentType?: string
  /** `a` and 16 hex digits when not given. */
  agentId?: string
  /** Pause between the events this step emits. */
  pauseMs?: number
  progress?: Array<{ tokens: number; toolUses: number; durationMs: number; lastTool?: string }>
  /** null: the agent never finishes, no notification ever comes. */
  finish?: {
    status: 'completed' | 'failed' | 'stopped'
    summary: string
    tokens: number
    toolUses: number
    durationMs: number
  } | null
}

export interface FakePermissionAnswer {
  behavior: 'allow' | 'deny'
  message?: string
  updatedInput?: Record<string, unknown>
}

export interface FakeWindow {
  utilization: number
  resetsAt: number
}

export interface FakePlanLimits {
  fiveHour: FakeWindow | null
  sevenDay: FakeWindow | null
}

export interface FakeScript {
  steps?: FakeStep[]
  nextTurn?: FakeStep[]
  sessionId?: string
  costUsd?: number
  contextPercent?: number
  rateLimits?: { fiveHour?: FakeWindow; sevenDay?: FakeWindow }
  /** What planLimits() returns; by default the rate_limit_event windows. */
  planLimits?: FakePlanLimits | null
  /** Delay before getContextUsage() answers. */
  contextUsageDelayMs?: number
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID: string; signal: AbortSignal }
  ) => Promise<FakePermissionAnswer>
  init?: {
    cwd?: string
    model?: string
    permissionMode?: string
    mcpServers?: Array<{ name: string; status: string }>
    slashCommands?: string[]
    models?: Array<{
      value: string
      displayName: string
      description: string
      supportedEffortLevels?: string[]
    }>
    commands?: Array<{
      name: string
      description: string
      argumentHint: string
      builtin?: boolean
    }>
  }
}

export interface FakeDriver {
  readonly messages: AsyncIterable<Record<string, never>>
  send(input: { text: string; attachments: unknown[] }): void
  interrupt(): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  supportedCommands(): Promise<
    Array<{ name: string; description: string; argumentHint: string; builtin?: boolean }>
  >
  supportedModels(): Promise<
    Array<{
      value: string
      displayName: string
      description: string
      supportedEffortLevels?: string[]
    }>
  >
  setModel(model: string): Promise<void>
  setEffort(level: string): Promise<void>
  mcpServerStatus(): Promise<Array<{ name: string; status: string }>>
  planLimits(): Promise<FakePlanLimits | null>
  getContextUsage(): Promise<{
    model: string
    totalTokens: number
    maxTokens: number
    percentage: number
    categories: Array<{ name: string; tokens: number; kind: string }>
  }>
  dispose(): Promise<void>

  readonly sent: Array<{ text: string; attachments: unknown[] }>
  readonly permissionRequests: Array<{ name: string; input: object }>
  readonly executedTools: string[]
  /** What each answered AskUserQuestion carried in updatedInput.answers. */
  readonly questionAnswers: Array<Record<string, string>>
  readonly permissionMode: string
  readonly model: string
  readonly effort: string | null
  readonly interrupted: boolean
  readonly disposed: boolean
}

export declare function createFakeSdk(script?: FakeScript): FakeDriver
