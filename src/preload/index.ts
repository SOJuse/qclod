import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  EnvironmentReport,
  LoginProgress,
  AppSettings,
  CommandInfo,
  HotkeyRegistration,
  LaunchOverrides,
  PanelEvent,
  PanelSnapshot,
  PermissionAnswer,
  PersistedTab,
  PreparedImage,
  ResolvedPath,
  RibbonEvent,
  RibbonSnapshot,
  SessionSummary,
  StatusEvent,
  TabId,
  TabState,
  TaskOutput,
  UpdateState,
  UserInput
} from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * One named wrapper per channel. `ipcRenderer` itself never crosses the
 * bridge, so the renderer can only reach what is listed here.
 */
const api = {
  appVersion: (): Promise<string> => ipcRenderer.invoke(CHANNELS.appVersion),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(CHANNELS.settingsGet),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(CHANNELS.settingsSet, patch),
  hotkeyStatus: (): Promise<HotkeyRegistration> => ipcRenderer.invoke(CHANNELS.hotkeyStatus),

  listTabs: (): Promise<TabState[]> => ipcRenderer.invoke(CHANNELS.tabsList),
  createTab: (cwd: string, overrides?: LaunchOverrides): Promise<TabState | null> =>
    ipcRenderer.invoke(CHANNELS.tabsCreate, cwd, overrides),
  closeTab: (id: TabId): Promise<void> => ipcRenderer.invoke(CHANNELS.tabsClose, id),
  activateTab: (id: TabId): Promise<void> => ipcRenderer.invoke(CHANNELS.tabsActivate, id),
  updateTab: (id: TabId, patch: Partial<PersistedTab>): Promise<TabState | undefined> =>
    ipcRenderer.invoke(CHANNELS.tabsUpdate, id, patch),
  restartTab: (id: TabId): Promise<void> => ipcRenderer.invoke(CHANNELS.tabsRestart, id),
  retryTab: (id: TabId): Promise<void> => ipcRenderer.invoke(CHANNELS.tabsRetry, id),

  /** False when the tab could not take the message: it goes back to the input line. */
  send: (id: TabId, input: UserInput): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.agentSend, id, input),
  /** Stops the turn; resolves with the messages that were waiting to be sent. */
  interrupt: (id: TabId): Promise<UserInput[]> => ipcRenderer.invoke(CHANNELS.agentInterrupt, id),
  cancelQueued: (tabId: TabId, id: string): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.agentQueueCancel, tabId, id),
  setPermissionMode: (id: TabId, mode: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.agentPermissionMode, id, mode),
  setModel: (id: TabId, model: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.agentModel, id, model),

  setEffort: (id: TabId, level: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.agentEffort, id, level),

  commands: (id: TabId): Promise<CommandInfo[]> => ipcRenderer.invoke(CHANNELS.agentCommands, id),
  /** The tab's whole ribbon with its revision — for a window catching up. */
  ribbon: (id: TabId): Promise<RibbonSnapshot> => ipcRenderer.invoke(CHANNELS.agentRibbon, id),
  /** The tab's whole panel with its revision; live MCP follows as an event. */
  panel: (id: TabId): Promise<PanelSnapshot> => ipcRenderer.invoke(CHANNELS.agentPanel, id),
  /** The end of a background task's output; null when this Claude Code cannot read it. */
  taskOutput: (id: TabId, taskId: string): Promise<TaskOutput | null> =>
    ipcRenderer.invoke(CHANNELS.agentTaskOutput, id, taskId),
  stopTask: (id: TabId, taskId: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.agentTaskStop, id, taskId),

  answerPermission: (requestId: string, answer: PermissionAnswer): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.permissionAnswer, requestId, answer),
  permissionRules: (): Promise<Array<{ id: string; toolName: string; target?: string }>> =>
    ipcRenderer.invoke(CHANNELS.permissionRules),
  deletePermissionRule: (ruleId: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.permissionRuleDelete, ruleId),
  answerPlan: (id: TabId, requestId: string, approve: boolean): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.planAnswer, id, requestId, approve),

  answerQuestion: (id: TabId, toolUseId: string, answers: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.questionAnswer, id, toolUseId, answers),

  listHistory: (tabId: TabId): Promise<SessionSummary[]> =>
    ipcRenderer.invoke(CHANNELS.historyList, tabId),
  openHistory: (tabId: TabId, sessionId: string, title?: string): Promise<TabState | null> =>
    ipcRenderer.invoke(CHANNELS.historyOpen, tabId, sessionId, title),

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.dialogPickFolder),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(CHANNELS.dialogPickFiles),
  fileIndex: (id: TabId): Promise<string[]> => ipcRenderer.invoke(CHANNELS.filesIndex, id),

  /** Which candidate texts (`src/a.ts:3`) exist, relative to the tab's folder; null where not. */
  resolvePaths: (tabId: TabId, raws: string[]): Promise<Array<ResolvedPath | null>> =>
    ipcRenderer.invoke(CHANNELS.filesResolve, tabId, raws),
  /** Opens with the default program; an executable is shown in Explorer instead. */
  openPath: (tabId: TabId, absPath: string): Promise<'opened' | 'revealed' | null> =>
    ipcRenderer.invoke(CHANNELS.filesOpen, tabId, absPath),
  revealPath: (tabId: TabId, absPath: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.filesReveal, tabId, absPath),
  /** A pasted image made fit to send: bounded, with a thumbnail and a copy on disk. */
  prepareImage: (dataBase64: string, mediaType: string): Promise<PreparedImage | { error: string }> =>
    ipcRenderer.invoke(CHANNELS.filesPrepareImage, dataBase64, mediaType),
  /** null when the editor started; otherwise a message to show (the template needs fixing). */
  openInEditor: (
    tabId: TabId,
    absPath: string,
    line?: number,
    column?: number
  ): Promise<string | null> =>
    ipcRenderer.invoke(CHANNELS.filesOpenInEditor, tabId, absPath, line, column),

  // File.path was removed in Electron 32; webUtils is the supported way to
  // learn where a dropped or pasted file lives on disk.
  pathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },

  minimize: (): Promise<void> => ipcRenderer.invoke(CHANNELS.windowMinimize),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.windowMaximize),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(CHANNELS.windowClose),
  zoom: (step: 'in' | 'out' | 'reset'): Promise<void> => ipcRenderer.invoke(CHANNELS.windowZoom, step),
  reloadWindow: (): Promise<void> => ipcRenderer.invoke(CHANNELS.windowReload),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openExternal, url),

  checkEnvironment: (): Promise<EnvironmentReport> => ipcRenderer.invoke(CHANNELS.setupCheck),
  installAgent: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.setupInstall),
  cancelInstall: (): Promise<void> => ipcRenderer.invoke(CHANNELS.setupCancel),
  /** Opens `claude auth login` in its own window and starts watching for success. */
  login: (): Promise<void> => ipcRenderer.invoke(CHANNELS.setupLogin),
  onSetupOutput: (cb: (line: string) => void) => on(CHANNELS.setupOutput, cb),
  onLoginProgress: (cb: (p: LoginProgress) => void) => on(CHANNELS.setupLoginProgress, cb),

  /** Whether a new version of Qclod is downloaded and waits for a restart. */
  getUpdate: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNELS.updateGet),
  /** Quits and installs the downloaded version; false when there is none. */
  restartToUpdate: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.updateRestart),
  onUpdateChanged: (cb: (s: UpdateState) => void) => on(CHANNELS.updateChanged, cb),

  onRibbon: (cb: (e: RibbonEvent) => void) => on(CHANNELS.ribbonChanged, cb),
  onPanel: (cb: (e: PanelEvent) => void) => on(CHANNELS.panelChanged, cb),
  onStatus: (cb: (e: StatusEvent) => void) => on(CHANNELS.statusChanged, cb),
  onTabsChanged: (cb: (tabs: TabState[]) => void) => on(CHANNELS.tabsChanged, cb),
  onActivateTab: (cb: (id: TabId) => void) => on(CHANNELS.activateTab, cb),
  onSettingsChanged: (cb: (s: AppSettings) => void) => on(CHANNELS.settingsChanged, cb),
  onCommandsChanged: (cb: (e: { tabId: TabId; commands: CommandInfo[] }) => void) =>
    on(CHANNELS.commandsChanged, cb)
}

export type QclodApi = typeof api

contextBridge.exposeInMainWorld('qclod', api)
