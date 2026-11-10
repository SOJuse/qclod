export type TabId = string

/** What a tab's agent is doing right now. */
export type SessionStatus = 'stopped' | 'starting' | 'busy' | 'waiting' | 'idle' | 'error'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions'
] as const

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'

/** What the user attached to a message. */
export type Attachment =
  | {
      kind: 'image'
      mediaType: string
      /** Empty when `path` stands for it: main reads the bytes from the pasted file. */
      dataBase64: string
      /** The copy kept in userData/pastes; a click on the thumbnail opens it. */
      path?: string
      /** A small `data:image/…` picture for the chip and the bubble. */
      thumbnail?: string
      width?: number
      height?: number
    }
  | { kind: 'file'; path: string }

/** A pasted image after main has read, bounded and saved it. */
export interface PreparedImage {
  mediaType: string
  dataBase64: string
  thumbnail: string
  /** In userData/pastes. */
  path: string
  width: number
  height: number
}

export interface UserInput {
  text: string
  attachments: Attachment[]
}

// ---------------------------------------------------------------- the ribbon

export interface RibbonBase {
  id: string
  /** Set when this item belongs inside a subagent's nested stream. */
  parentId?: string
}

export type ToolState = 'running' | 'done'

/**
 * What a tool card remembers of the call, beyond its one-line summary. All of
 * it is optional: a snapshot or a stored ribbon from before it existed still
 * reads. Input and output are bounded copies (shared/clip.ts).
 */
export interface ToolCallData {
  /** The call's input, as the agent sent it. */
  input?: Record<string, unknown>
  /** The tool's structured output (the SDK's tool_use_result). */
  output?: unknown
  /** When the call was placed, ms since the epoch. */
  startedAt?: number
  /** How long it ran, measured from the card to its result. */
  durationMs?: number
}

/** A subagent can also fail, be stopped, or be left running when the session ended. */
export type SubagentState = 'running' | 'done' | 'failed' | 'stopped' | 'unfinished'

/** One question of an AskUserQuestion card. */
export interface QuestionView {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

/**
 * One element of the conversation as the user reads it. Deliberately a view
 * model, not a copy of the SDK's message: the translator (shared/ribbon.ts)
 * folds a tool call and its result into one item, and a stream of text deltas
 * into one paragraph.
 */
export type RibbonItem =
  | (RibbonBase & { kind: 'user'; text: string; attachments: Attachment[] })
  | (RibbonBase & { kind: 'agentText'; text: string; streaming: boolean })
  | (RibbonBase & { kind: 'thinking'; text: string; done: boolean; durationMs: number })
  | (RibbonBase & ToolCallData & {
      kind: 'tool'
      toolUseId: string
      name: string
      target: string
      summary: string
      detail: string
      state: ToolState
    })
  | (RibbonBase & ToolCallData & {
      kind: 'toolError'
      toolUseId: string
      name: string
      target: string
      error: string
    })
  | (RibbonBase & {
      kind: 'subagent'
      toolUseId: string
      /** The agent kind, e.g. Explore — what it is. */
      name: string
      /** The task it was given — what it is doing. */
      task: string
      state: SubagentState
      summary: string
      /**
       * What it wrote back when it finished, whole and with its line breaks
       * (at most 8000 characters): AgentOutput's text, or a background
       * agent's notice summary.
       */
      report?: string
      /** Launched with run_in_background: the call returns at once, the agent keeps going. */
      background?: boolean
      agentId?: string
      taskId?: string
      /** The tool it used last, while it works. */
      lastTool?: string
      /** Set when it finishes, from the tool's own run totals. */
      tokens?: number
      durationMs?: number
      toolCalls?: number
    })
  | (RibbonBase & {
      kind: 'permission'
      requestId: string
      toolName: string
      target: string
      state: 'pending' | 'allowed' | 'denied'
    })
  | (RibbonBase & {
      kind: 'plan'
      requestId: string
      text: string
      state: 'pending' | 'approved' | 'rejected'
    })
  | (RibbonBase & {
      kind: 'question'
      toolUseId: string
      questions: QuestionView[]
      /** Question text -> chosen label(s); null while the card is open. */
      answers: Record<string, string> | null
    })
  | (RibbonBase & {
      kind: 'compaction'
      trigger: 'auto' | 'manual'
      freedTokens: number
      /** What the conversation before it was boiled down to, when the transcript has it. */
      summary?: string
    })
  /** Something Qclod itself needs to say: a crash, a session that would not resume. */
  | (RibbonBase & {
      kind: 'notice'
      text: string
      tone: 'info' | 'error'
      /** A way out the notice offers: «Войти» opens the login terminal. */
      action?: 'login'
    })

export interface TodoItem {
  content: string
  status: string
  /** The task in the present tense, shown while it is in progress. */
  activeForm?: string
}

export type RibbonChange =
  | { kind: 'append'; item: RibbonItem }
  | { kind: 'update'; id: string; patch: Partial<RibbonItem> }
  | { kind: 'todo'; items: TodoItem[] }

// ----------------------------------------------------------------- the panel

export interface ContextInfo {
  used: number
  max: number
  percent: number
  /** `kind` is absent in an estimate from the record: all of it is content. */
  categories: Array<{ name: string; tokens: number; kind?: 'used' | 'free' | 'buffer' }>
  /**
   * Worked out from the conversation's record, not reported by a process —
   * a tab not yet started. The process's own answer replaces it.
   */
  estimated?: boolean
}

export interface CostInfo {
  session: number
  /**
   * The conversation was resumed: the CLI counts from when this process
   * opened it, not from the conversation's first message.
   */
  sinceOpen?: boolean
}

/** One subscription window, as `rate_limit_event` reports it (probe note 2). */
export interface LimitWindow {
  /** 0..1 */
  utilization: number
  /** unix seconds */
  resetsAt: number
}

export interface McpServerInfo {
  name: string
  status: 'connected' | 'connecting' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
}

export interface ProjectSettingsInfo {
  hooks: number
  mcpServers: string[]
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** A model the session offers, as `supportedModels()` reports it. */
export interface ModelOption {
  value: string
  displayName: string
  description: string
  supportedEffortLevels?: EffortLevel[]
}

export interface PanelData {
  context: ContextInfo | null
  cost: CostInfo | null
  limits: { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null }
  model: string | null
  /** What the user may switch to, asked for once per session. */
  models: ModelOption[]
  effort: EffortLevel | null
  permissionMode: PermissionMode
  mcp: McpServerInfo[]
  projectSettings: ProjectSettingsInfo | null
}

// ------------------------------------------------------------------ the rest

export interface LaunchOverrides {
  model?: string
  permissionMode?: PermissionMode
  extraFlags?: string
  /** Kept in Qclod's tabs.json; applied per session, never to the user's settings. */
  effort?: EffortLevel
}

export interface PersistedTab {
  id: TabId
  cwd: string
  title: string
  overrides: LaunchOverrides
  /** Lets the tab pick its conversation back up after a restart (spec 6.9). */
  lastSessionId?: string
}

export interface TabState extends PersistedTab {
  status: SessionStatus
  badge: boolean
  error?: string
  missingCwd?: boolean
  /**
   * The session never got to the conversation — no agent found, not logged
   * in — and the tab still knows which one it was: «Повторить» opens that
   * same conversation, where «Начать заново» would drop it.
   */
  canRetry?: boolean
}

export interface CommandInfo {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
  builtin?: boolean
  /** Set when the command cannot work here, e.g. /remote-control (spec 6.7). */
  unavailableReason?: string
}

export interface SessionSummary {
  id: string
  title: string
  firstMessage: string
  updatedAt: number
}

export interface PermissionRequest {
  requestId: string
  tabId: TabId
  toolName: string
  target: string
  input: Record<string, unknown>
}

export interface PermissionAnswer {
  behavior: 'allow' | 'deny'
  remember?: boolean
  /**
   * The tool's input as it should run — how a question's answers reach the
   * agent. Set only inside the main process: the window's answer never
   * carries it (sanitizeAnswer drops it), so the window cannot rewrite what a
   * tool does.
   */
  updatedInput?: Record<string, unknown>
}

export interface AppSettings {
  agentPath: string
  globalHotkey: string
  notificationsEnabled: boolean
  soundEnabled: boolean
  closeToTray: boolean
  panelOpen: boolean
  /**
   * How to open a file in the user's editor: `code -g {path}:{line}`. Empty
   * means no editor, and the path menu has no such item.
   */
  editorCommand: string
  defaults: LaunchOverrides
}

export interface ToolReport {
  found: boolean
  version?: string
  path?: string
}

/** What the machine has, for the setup screen. */
export interface EnvironmentReport {
  agent: ToolReport
  /** How this machine can install the agent, if it has to. */
  installMethod: 'winget' | 'npm' | null
  ready: boolean
}

export interface HotkeyRegistration {
  ok: boolean
  accelerator: string
  reason?: string
}

export interface RibbonEvent {
  tabId: TabId
  changes: RibbonChange[]
  /**
   * The revision of the last change in `changes`. Grows with every change,
   * across sessions; orders events against snapshots.
   */
  rev: number
}

/** A tab's whole ribbon at revision `rev` — what a window asks for to catch up. */
export interface RibbonSnapshot {
  rev: number
  items: RibbonItem[]
  todo: TodoItem[] | null
}

export interface PanelEvent {
  tabId: TabId
  patch: Partial<PanelData>
  /** Grows with every patch, across sessions; orders events against snapshots. */
  rev: number
}

/** A tab's whole panel at revision `rev` — what a window asks for to catch up. */
export interface PanelSnapshot {
  rev: number
  data: PanelData
}

export interface StatusEvent {
  tabId: TabId
  status: SessionStatus
  error?: string
  /** The agent was working and has stopped — the only state worth a chime. */
  finished?: boolean
}

/**
 * A path from the agent's text that main found on disk. `raw` is the text as
 * it stands (line suffix included), so the window can match it back.
 */
export interface ResolvedPath {
  raw: string
  absPath: string
  isDir: boolean
  line?: number
  column?: number
}
