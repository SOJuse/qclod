import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  AppSettings,
  HotkeyRegistration,
  LaunchOverrides,
  PersistedTab,
  SessionDataEvent,
  SessionExitEvent,
  SessionStatusEvent,
  TabId,
  TabState
} from '../shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * One named wrapper per channel. `ipcRenderer` itself never crosses the bridge,
 * so the renderer can only reach the channels listed here.
 */
const api = {
  appVersion: (): Promise<string> => ipcRenderer.invoke(CHANNELS.appVersion),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(CHANNELS.settingsGet),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(CHANNELS.settingsSet, patch),
  hotkeyStatus: (): Promise<HotkeyRegistration> => ipcRenderer.invoke(CHANNELS.hotkeyStatus),

  listTabs: (): Promise<TabState[]> => ipcRenderer.invoke(CHANNELS.tabsList),
  createTab: (cwd: string, overrides?: LaunchOverrides): Promise<TabState> =>
    ipcRenderer.invoke(CHANNELS.tabsCreate, cwd, overrides),
  closeTab: (id: TabId): Promise<void> => ipcRenderer.invoke(CHANNELS.tabsClose, id),
  activateTab: (id: TabId): Promise<void> => ipcRenderer.invoke(CHANNELS.tabsActivate, id),
  updateTab: (id: TabId, patch: Partial<PersistedTab>): Promise<TabState> =>
    ipcRenderer.invoke(CHANNELS.tabsUpdate, id, patch),

  write: (id: TabId, data: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.sessionWrite, id, data),
  resize: (id: TabId, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.sessionResize, id, cols, rows),
  restart: (id: TabId): Promise<void> => ipcRenderer.invoke(CHANNELS.sessionRestart, id),

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.dialogPickFolder),
  fileIndex: (id: TabId): Promise<string[]> => ipcRenderer.invoke(CHANNELS.filesIndex, id),
  clipboardImage: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.clipboardImage),

  // File.path was removed in Electron 32; webUtils is the supported way to
  // learn where a dropped file lives on disk.
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

  onSessionData: (cb: (e: SessionDataEvent) => void) => on(CHANNELS.sessionData, cb),
  onSessionExit: (cb: (e: SessionExitEvent) => void) => on(CHANNELS.sessionExit, cb),
  onSessionStatus: (cb: (e: SessionStatusEvent) => void) => on(CHANNELS.sessionStatus, cb),
  onTabsChanged: (cb: (tabs: TabState[]) => void) => on(CHANNELS.tabsChanged, cb),
  onActivateTab: (cb: (id: TabId) => void) => on(CHANNELS.activateTab, cb),
  onSettingsChanged: (cb: (s: AppSettings) => void) => on(CHANNELS.settingsChanged, cb)
}

export type QclodApi = typeof api

contextBridge.exposeInMainWorld('qclod', api)
