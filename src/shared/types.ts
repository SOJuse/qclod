export type TabId = string

/** What a tab's agent is doing right now (spec 6.3, 6.9). */
export type SessionStatus = 'starting' | 'busy' | 'waiting' | 'idle' | 'exited' | 'error'

/** Launch flags. Global values are defaults; a tab may override any of them. */
export interface LaunchOverrides {
  model?: string
  permissionMode?: string
  mcpConfig?: string
  extraFlags?: string
}

export interface AppSettings {
  /** Absolute path to the agent executable, or a bare name to resolve on PATH. */
  agentPath: string
  globalHotkey: string
  notificationsEnabled: boolean
  soundEnabled: boolean
  fontSize: number
  /** Move focus to the terminal when the agent opens a menu (spec 6.4). */
  autoFocusOnMenu: boolean
  closeToTray: boolean
  defaults: LaunchOverrides
}

export interface PersistedTab {
  id: TabId
  cwd: string
  title: string
  overrides: LaunchOverrides
}

export interface TabState extends PersistedTab {
  status: SessionStatus
  /** Something happened here while the tab was not in front. */
  badge: boolean
  /** Status is being guessed from output silence because hooks went quiet. */
  degraded: boolean
  exitCode?: number
  error?: string
  missingCwd?: boolean
}

/** Shape of the JSON a Claude Code hook writes to its command's stdin. */
export interface HookEvent {
  hook_event_name: string
  session_id?: string
  cwd?: string
  matcher?: string
  tool_name?: string
  last_assistant_message?: string
  /** Added by Qclod so an event can be attributed to the tab that caused it. */
  tabId?: TabId
}

export interface SessionDataEvent {
  tabId: TabId
  chunk: string
}

export interface SessionExitEvent {
  tabId: TabId
  code: number
}

export interface SessionStatusEvent {
  tabId: TabId
  status: SessionStatus
  degraded: boolean
}

export interface HotkeyRegistration {
  ok: boolean
  accelerator: string
  reason?: string
}
