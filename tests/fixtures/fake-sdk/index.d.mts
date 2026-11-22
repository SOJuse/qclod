/** Types for the fake SDK driver. The implementation lives in index.mjs. */

export type FakeStep =
  | { kind: 'text'; text: string }
  | { kind: 'textStream'; pieces: string[]; pauseMs?: number }
  | { kind: 'thinking'; text?: string; ms?: number }
  | { kind: 'tool'; name: string; input?: object; result?: string; output?: object; pauseMs?: number }
  | { kind: 'toolRunning'; name: string; input?: object }
  | { kind: 'toolError'; name: string; input?: object; error: string; output?: object }
  /** `echo`: after the answer the agent says «Получено: <JSON>» with the refusal's message. */
  | { kind: 'askPermission'; name: string; input?: object; echo?: boolean }
  | { kind: 'askPermissions'; tools: Array<{ name: string; input?: object }> }
  | {
      kind: 'askQuestion'
      /** Shorthand for a single question. */
      question?: string
      header?: string
      options?: string[]
      /** After the answer, say what the agent received as a text message. */
      echoAnswers?: boolean
      /** After the answer, «Получено: <JSON>» with the message, answers and annotations. */
      echo?: boolean
      /** The full form: up to four questions. */
      questions?: Array<{ question: string; header?: string; options: string[]; multiSelect?: boolean }>
    }
  /**
   * ExitPlanMode with `plan`: the call, then canUseTool about it. Approved, it runs
   * with updatedInput.plan if given; refused, an errored tool_result with the message.
   * `echo`: «Получено: <JSON>» with the message and the plan carried back.
   */
  | { kind: 'plan'; plan: string; echo?: boolean }
  | { kind: 'todo'; items: Array<{ content: string; status: string }> }
  | {
      kind: 'subagent'
      name: string
      agentType?: string
      /** task_id = AgentOutput.agentId; `a` and 16 hex digits when not given. */
      agentId?: string
      /** AgentInput.name (the CLI takes only [A-Za-z0-9_-], up to 64). */
      label?: string
      /** AgentInput.prompt; `name` when not given. */
      prompt?: string
      /** AgentOutput.resolvedModel. */
      model?: string
      /** One task_progress each, before the end. */
      progress?: FakeProgress[]
      /** Pause before task_updated and the tool_result: time to stop it or move it to the background. */
      holdMs?: number
      /** Run totals under the names AgentOutput uses (sdk-tools.d.ts). */
      stats?: { totalTokens?: number; totalDurationMs?: number; totalToolUseCount?: number }
      /** What it writes back: AgentOutput content text and the tool_result text. Default «подагент закончил». */
      report?: string
      steps: FakeStep[]
    }
  /** The main agent calls SendMessage (after ToolSearch the first time); what a relay instruction plays. */
  | { kind: 'sendMessage'; to: string; message: string }
  | FakeBackgroundAgentStep
  | FakeBackgroundBashStep
  | { kind: 'compact'; preTokens: number; postTokens: number; trigger?: 'auto' | 'manual' }
  /**
   * Throws mid-stream. `times`: only the first N sessions (drivers made) play
   * it, later ones skip it; each session counts once, as it is made, in
   * fake-sdk-crashes.json in QCLOD_USER_DATA (no such folder — always crashes).
   * Read from top-level `steps` and `nextTurn`.
   * `beforeInit`: thrown before the turn's system/init and echo.
   */
  | { kind: 'crash'; message: string; times?: number; beforeInit?: boolean }
  /**
   * The subscription limit: rate_limit_event rejected (resetsAt in resetsInMs), an
   * assistant message with error 'rate_limit', and a result with is_error at the
   * end of the turn. `times`: only the first N times it comes up in a session.
   */
  | { kind: 'limitHit'; type?: 'five_hour' | 'seven_day'; resetsInMs: number; times?: number }
  /** Says «картинок: N; типы: …; байт: M» about the images of the last send. */
  | { kind: 'reportInput' }
  /** A question answered on the phone: its signal aborts after afterMs (default 50), then `decision` rules. */
  | { kind: 'remoteAnswer'; name: string; input?: object; decision: 'allow' | 'deny'; afterMs?: number }

/** One task_progress of a subagent; `summary` only when given (probe 05b saw none in 25 s). */
export interface FakeProgress {
  summary?: string
  tokens: number
  toolUses: number
  durationMs: number
  lastTool?: string
}

/** An Agent call with run_in_background; its progress and notification come after the turn. */
export interface FakeBackgroundAgentStep {
  kind: 'backgroundAgent'
  name: string
  agentType?: string
  /** `a` and 16 hex digits when not given. */
  agentId?: string
  /** Pause between the events this step emits. */
  pauseMs?: number
  progress?: FakeProgress[]
  /** null: the agent never finishes, no notification ever comes. */
  finish?: {
    status: 'completed' | 'failed' | 'stopped'
    summary: string
    tokens: number
    toolUses: number
    durationMs: number
  } | null
}

/** A Bash call with run_in_background; its output grows and it ends after the turn. */
export interface FakeBackgroundBashStep {
  kind: 'backgroundBash'
  command: string
  /** task_started's description; the command when not given. */
  description?: string
  /** `b` and 8 hex digits when not given. */
  taskId?: string
  /** Pieces of output, one every pauseMs after the turn's result, read by taskOutput(). */
  chunks?: string[]
  pauseMs?: number
  /** null or absent: the command never ends by itself. */
  finish?: 'completed' | 'failed' | null
}

/** Mirrors RemoteBlock in src/shared/types.ts. */
export type FakeRemoteBlock = 'sdk' | 'cli' | 'api_key' | 'provider'
/** Mirrors RemoteAvailability in src/shared/remote.ts. */
export type FakeRemoteAvailability =
  | { available: true }
  | { available: false; reason: FakeRemoteBlock }

export interface FakeRemoteControl {
  /** remoteAvailability() says why Remote Control is not there. */
  blocked?: FakeRemoteBlock
  /** setRemoteControl(true) rejects with this message. */
  enableError?: string
  /** Overrides the default session URL. */
  sessionUrl?: string
  /** bridge_state messages after enabling; by default one `connected`. */
  bridge?: Array<{ state: string; detail?: string; failure_kind?: string; afterMs?: number }>
  /** Turns typed on the phone after the bridge states. */
  phoneTurns?: Array<{ text: string; afterMs?: number; steps?: FakeStep[] }>
}

export interface FakeTaskOutput {
  output: string
  totalBytes: number
  truncated: boolean
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
  /** The i-th message sent (0-based) plays `turns[i]`; past the list, `nextTurn`. */
  turns?: FakeStep[][]
  sessionId?: string
  costUsd?: number
  /** result.modelUsage as the SDK gives it: `{ [model]: { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD } }`. */
  modelUsage?: Record<string, Record<string, number>>
  contextPercent?: number
  /** getContextUsage() after the i-th turn answers the i-th entry (1-based); the last one sticks. */
  contextPercentByTurn?: number[]
  rateLimits?: { fiveHour?: FakeWindow; sevenDay?: FakeWindow }
  /** What planLimits() returns; by default the rate_limit_event windows. */
  planLimits?: FakePlanLimits | null
  /** Delay before getContextUsage() answers. */
  contextUsageDelayMs?: number
  /** taskOutput() answers null: a CLI that cannot read a task's output. */
  taskOutputUnavailable?: boolean
  /** stopTask() rejects with this message and the task keeps running. */
  stopTaskError?: string
  // — этап 4: сабагенты
  /** false: the subagent's text and thinking are not forwarded (the CLI's default); its calls still are. */
  forwardSubagentText?: boolean
  /** false: a nested (second-level) agent sends only its task events, no call and no steps. */
  nestedToolCalls?: boolean
  /** backgroundTask() rejects with «background tasks are disabled». */
  backgroundTasksDisabled?: boolean
  /** 'ignored': stopTask() of a foreground agent changes nothing. */
  foregroundStop?: 'ignored'
  /** What an agent answers a SendMessage with; «продолжил: <текст>» by default. */
  resumeReply?: string
  /** How long a resumed agent works before it answers; 0 by default. */
  resumeHoldMs?: number
  /** false: the model ignores a relay instruction; it stays plain text. */
  relay?: boolean
  /** system/init.tools without SendMessage. */
  noSendMessage?: boolean
  remoteControl?: FakeRemoteControl
  /** false: a CLI without msg_lifecycle_v1 (2.1.200) — no frames, no receipt, cancel gives null. */
  lifecycle?: boolean
  /**
   * false: a CLI with interrupt_receipt_v1 but not interrupt_cancel_queued_v1 —
   * interrupt() ignores `cancelQueued`, its receipt has `stillQueued` and no `cancelled`.
   */
  cancelQueuedOnInterrupt?: boolean
  /** A `cancelled` frame for a message that is not ours, `afterMs` after the first send with a uuid. */
  phoneCancel?: { afterMs: number; uuid: string }
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID: string; signal: AbortSignal }
  ) => Promise<FakePermissionAnswer>
  init?: {
    cwd?: string
    /** system/init's claude_code_version; by default 2.1.317 (2.1.200 with `lifecycle: false`). */
    claudeCodeVersion?: string
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
  send(input: { text: string; attachments: unknown[] }, opts?: { uuid?: string; priority?: 'now' | 'next' | 'later' }): void
  cancelQueued(uuid: string): Promise<boolean | null>
  /** The SDK's name for what cancelQueued does: true — taken off the queue, false — too late, null — no lifecycle. */
  cancelAsyncMessage(uuid: string): Promise<boolean | null>
  interrupt(opts?: { cancelQueued?: boolean }): Promise<{ stillQueued: string[]; cancelled?: string[] } | undefined>
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
  taskOutput(taskId: string): Promise<FakeTaskOutput | null>
  stopTask(taskId: string): Promise<void>
  /** true — moved to the background; false — no such agent in the foreground; rejects with backgroundTasksDisabled. */
  backgroundTask(toolUseId: string): Promise<boolean | null>
  remoteAvailability(): Promise<FakeRemoteAvailability>
  setRemoteControl(
    enabled: boolean,
    name?: string
  ): Promise<{ sessionUrl: string; connectUrl?: string } | null>
  /** Only the fake: a turn typed on the phone. Not recorded in `sent`. */
  typeOnPhone(text: string, steps?: FakeStep[]): void
  dispose(): Promise<void>

  readonly remoteCalls: Array<{ enabled: boolean; name?: string }>
  readonly sent: Array<{ text: string; attachments: unknown[] }>
  /** SendMessage calls the main agent made. */
  readonly relayed: Array<{ to: string; message: string }>
  /** Every backgroundTask() argument, in order. */
  readonly backgrounded: string[]
  /** Every stopTask() argument, in order. */
  readonly stopped: string[]
  readonly permissionRequests: Array<{ name: string; input: object }>
  /** Every answer canUseTool gave, in order. */
  readonly permissionLog: Array<{
    name: string
    behavior: 'allow' | 'deny'
    message?: string
    updatedInput?: Record<string, unknown>
  }>
  readonly executedTools: string[]
  /** What each answered AskUserQuestion carried in updatedInput.answers. */
  readonly questionAnswers: Array<Record<string, string>>
  readonly permissionMode: string
  readonly model: string
  readonly effort: string | null
  readonly interrupted: boolean
  /** Uuids of the messages taken into a running turn, in order. */
  readonly folded: string[]
  readonly disposed: boolean
}

export declare function createFakeSdk(script?: FakeScript): FakeDriver

/** A one-off query's script (этап 7, «Собрать мои шаблоны»). */
export interface FakeOneShotScript {
  /** The answer's text; by default a JSON array of two templates. */
  text?: string
  /** Waits this long before answering; the abort controller cuts it short. */
  delayMs?: number
  costUsd?: number
  fail?: 'notLoggedIn' | 'limit' | 'crash'
}

export interface FakeOneShot {
  (args: { prompt: string; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>>
  /** Every prompt and options it was given. */
  readonly calls: Array<{ prompt: string; options: Record<string, unknown> }>
}

export declare function fakeOneShot(script?: FakeOneShotScript): FakeOneShot
