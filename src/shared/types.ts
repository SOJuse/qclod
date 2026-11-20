export type TabId = string

/** What a tab's agent is doing right now. */
export type SessionStatus = 'stopped' | 'starting' | 'busy' | 'waiting' | 'idle' | 'error'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'autoAllow',
  'auto',
  'dontAsk',
  'bypassPermissions'
] as const

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  /**
   * Qclod's own mode, unknown to the SDK: the agent runs in `default` and
   * asks as usual, and Qclod answers every permission request with «allow»
   * by itself. Deny rules still win; questions and plans still go to the user.
   */
  | 'autoAllow'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'

/** The mode the SDK is told: Qclod's own modes run on top of one of its. */
export function sdkPermissionMode(mode: string): string {
  return mode === 'autoAllow' ? 'default' : mode
}

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

/**
 * A pasted image after main has read, bounded and saved it. The bytes stay in
 * main: `path` stands for them and they are read from it when the message goes.
 */
export interface PreparedImage {
  mediaType: string
  /** A small `data:image/…` picture; empty when there is none (a large GIF or WebP). */
  thumbnail: string
  /** In userData/pastes. */
  path: string
  /** 0 when unknown (GIF and WebP go as they are, unread). */
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
  | (RibbonBase & {
      kind: 'user'
      text: string
      attachments: Attachment[]
      remote?: true
      /** When it was sent, ms since the epoch; absent in a record that has no time. */
      at?: number
    })
  /** The agent finished a turn: when, and how long the turn took. */
  | (RibbonBase & { kind: 'turnEnd'; at: number; durationMs?: number; failed?: true })
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
      state: 'pending' | 'allowed' | 'denied' | 'elsewhere'
    })
  | (RibbonBase & {
      kind: 'plan'
      requestId: string
      text: string
      state: 'pending' | 'approved' | 'rejected' | 'elsewhere'
    })
  | (RibbonBase & {
      kind: 'question'
      toolUseId: string
      questions: QuestionView[]
      /** Question text -> chosen label(s); null while the card is open. */
      answers: Record<string, string> | null
      /** Answered on another device (Remote Control): closed, with no answers of ours. */
      elsewhere?: true
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
      /**
       * A way out the notice offers: «Войти» opens the login terminal;
       * «Открыть терминал» opens Claude Code itself in the tab's folder, for
       * commands that exist only there (/chrome, /config…).
       */
      action?: NoticeAction
    })

export type NoticeAction = 'login' | 'terminal'

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
  /** Messages sent while the agent was working, waiting for it to be free. */
  queue: QueuedMessage[]
  /** Background shells and the like, newest first; subagents have their own cards. */
  backgroundTasks: BackgroundTask[]
}

/**
 * waiting — агент ещё запускается, сообщение у Qclod; sending — ушло в CLI, ответа нет;
 * queued — CLI поставил в очередь; cancelling — просили отменить, ждём ответа.
 */
export type QueuedState = 'waiting' | 'sending' | 'queued' | 'cancelling'

/** A message waiting its turn: what the strip above the input field shows of it. */
export interface QueuedMessage {
  id: string
  text: string
  /** How many files and pictures go with it. */
  attachments: number
  state: QueuedState
  canSendNow: boolean
}

/**
 * One background task as the status line lists it, from the SDK's task_*
 * events. The end time is ours: the SDK's notification carries none.
 */
export interface BackgroundTask {
  taskId: string
  toolUseId?: string
  /** task_type as the SDK names it: local_bash, monitor, … */
  type: string
  description: string
  /** The Bash call's command, when the task came from one. */
  command?: string
  /** interrupted: the agent itself died while the task ran; no end was ever reported. */
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  /** epoch ms */
  startedAt: number
  endedAt?: number
}

/** The end of a background task's output (get_task_output: the last 8 KiB). */
export interface TaskOutput {
  output: string
  totalBytes: number
  truncated: boolean
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
  /** Remote Control of this tab; live-only, never written to tabs.json. */
  remote?: RemoteInfo
}

export type RemoteState = 'off' | 'connecting' | 'on' | 'reconnecting' | 'failed'
export type RemoteBlock = 'sdk' | 'cli' | 'api_key' | 'provider'
export interface RemoteInfo {
  state: RemoteState
  url?: string
  problem?: string
  blocked?: RemoteBlock
}

export interface CommandInfo {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
  builtin?: boolean
  /** Set when the command cannot work here, e.g. /remote-control when Remote Control is blocked. */
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
  /**
   * The tab is in «авто-да»: a saved rule still decides, otherwise the answer
   * is «allow» without asking anyone.
   */
  auto?: boolean
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
  /** Why the agent was not found, when there is something specific to say. */
  problem?: string
}

/** What `claude auth status` says; 'unknown' when it could not be asked or read. */
export type AuthStatus = 'in' | 'out' | 'unknown'

/** The login watch, as the setup screen hears it. */
export type LoginProgress = 'waiting' | 'in' | 'timeout'

/** The app's own update: nothing to say yet, or a new version downloaded and waiting for a restart. */
export type UpdateState = { kind: 'idle' } | { kind: 'ready'; version: string }

/** What the machine has, for the setup screen. */
export interface EnvironmentReport {
  agent: ToolReport
  /** How this machine can install the agent, if it has to. */
  installMethod: 'winget' | 'npm' | null
  /** null when there is no agent to ask. */
  auth: AuthStatus | null
  /** The agent is there and not known to be logged out. */
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

/** An error the window caught in itself, sent to the main process for the log. */
export interface RendererErrorReport {
  scope: 'app' | 'pane' | 'window'
  message: string
  stack?: string
  componentStack?: string
}
