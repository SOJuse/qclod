/** Types for the fake SDK driver. The implementation lives in index.mjs. */

export type FakeStep =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text?: string; ms?: number }
  | { kind: 'tool'; name: string; input?: object; result?: string }
  | { kind: 'toolError'; name: string; input?: object; error: string }
  | { kind: 'askPermission'; name: string; input?: object }
  | { kind: 'askQuestion'; question: string; options: string[] }
  | { kind: 'todo'; items: Array<{ content: string; status: string }> }
  | { kind: 'subagent'; name: string; steps: FakeStep[] }
  | { kind: 'compact'; preTokens: number; postTokens: number; trigger?: 'auto' | 'manual' }
  | { kind: 'crash'; message: string }

export interface FakePermissionAnswer {
  behavior: 'allow' | 'deny'
  message?: string
}

export interface FakeWindow {
  utilization: number
  resetsAt: number
}

export interface FakeScript {
  steps?: FakeStep[]
  nextTurn?: FakeStep[]
  sessionId?: string
  costUsd?: number
  contextPercent?: number
  rateLimits?: { fiveHour?: FakeWindow; sevenDay?: FakeWindow }
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { sessionId: string }
  ) => Promise<FakePermissionAnswer>
  init?: {
    cwd?: string
    model?: string
    permissionMode?: string
    mcpServers?: Array<{ name: string; status: string }>
    slashCommands?: string[]
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
  mcpServerStatus(): Promise<Array<{ name: string; status: string }>>
  getContextUsage(): Promise<{
    totalTokens: number
    maxTokens: number
    percentage: number
    categories: Array<{ name: string; tokens: number; kind: string }>
  }>
  dispose(): Promise<void>

  readonly sent: Array<{ text: string; attachments: unknown[] }>
  readonly permissionRequests: Array<{ name: string; input: object }>
  readonly executedTools: string[]
  readonly permissionMode: string
  readonly interrupted: boolean
  readonly disposed: boolean
}

export declare function createFakeSdk(script?: FakeScript): FakeDriver
