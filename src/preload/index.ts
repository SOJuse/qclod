import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  AppSettings,
  CommandInfo,
  HotkeyRegistration,
  LaunchOverrides,
  PanelData,
  PanelEvent,
  PermissionAnswer,
  PersistedTab,
  RibbonEvent,
  RibbonItem,
  SessionSummary,
  StatusEvent,
  TabId,
  TabState,
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

  send: (id: TabId, input: UserInput): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.agentSend, id, input),
  interrupt: (id: TabId): Promise<void> => ipcRenderer.invoke(CHANNELS.agentInterrupt, id),
  setPermissionMode: (id: TabId, mode: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.agentPermissionMode, id, mode),
  commands: (id: TabId): Promise<CommandInfo[]> => ipcRenderer.invoke(CHANNELS.agentCommands, id),
  /** Everything already in this tab's ribbon — used when a tab is opened. */
  ribbon: (id: TabId): Promise<RibbonItem[]> => ipcRenderer.invoke(CHANNELS.agentRibbon, id),
  panel: (id: TabId): Promise<PanelData> => ipcRenderer.invoke(CHANNELS.agentPanel, id),

  answerPermission: (requestId: string, answer: PermissionAnswer): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.permissionAnswer, requestId, answer),
  permissionRules: (): Promise<Array<{ id: string; toolName: string; target?: string }>> =>
    ipcRenderer.invoke(CHANNELS.permissionRules),
  deletePermissionRule: (ruleId: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.permissionRuleDelete, ruleId),
  answerQuestion: (id: TabId, toolUseId: string, choice: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.questionAnswer, id, toolUseId, choice),

  listHistory: (cwd: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke(CHANNELS.historyList, cwd),
  openHistory: (cwd: string, sessionId: string): Promise<TabState | null> =>
    ipcRenderer.invoke(CHANNELS.historyOpen, cwd, sessionId),

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.dialogPickFolder),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke(CHANNELS.dialogPickFiles),
  fileIndex: (id: TabId): Promise<string[]> => ipcRenderer.invoke(CHANNELS.filesIndex, id),

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
