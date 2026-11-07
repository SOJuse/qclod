/**
 * Every IPC channel Qclod uses, in one place. The preload bridge exposes a
 * named wrapper per channel and never hands `ipcRenderer` to the renderer.
 */
export const CHANNELS = Object.freeze({
  // renderer -> main (invoke)
  appVersion: 'app:version',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  hotkeyStatus: 'hotkey:status',
  tabsList: 'tabs:list',
  tabsCreate: 'tabs:create',
  tabsClose: 'tabs:close',
  tabsActivate: 'tabs:activate',
  tabsUpdate: 'tabs:update',
  sessionWrite: 'session:write',
  sessionResize: 'session:resize',
  sessionRestart: 'session:restart',
  dialogPickFolder: 'dialog:pickFolder',
  filesIndex: 'files:index',
  clipboardImage: 'clipboard:image',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',

  // main -> renderer (events)
  sessionData: 'session:data',
  sessionExit: 'session:exit',
  sessionStatus: 'session:status',
  tabsChanged: 'tabs:changed',
  activateTab: 'tabs:activateRequest',
  settingsChanged: 'settings:changed'
} as const)

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS]

export const INVOKE_CHANNELS: readonly ChannelName[] = Object.freeze([
  CHANNELS.appVersion,
  CHANNELS.settingsGet,
  CHANNELS.settingsSet,
  CHANNELS.hotkeyStatus,
  CHANNELS.tabsList,
  CHANNELS.tabsCreate,
  CHANNELS.tabsClose,
  CHANNELS.tabsActivate,
  CHANNELS.tabsUpdate,
  CHANNELS.sessionWrite,
  CHANNELS.sessionResize,
  CHANNELS.sessionRestart,
  CHANNELS.dialogPickFolder,
  CHANNELS.filesIndex,
  CHANNELS.clipboardImage,
  CHANNELS.windowMinimize,
  CHANNELS.windowMaximize,
  CHANNELS.windowClose
])

export const EVENT_CHANNELS: readonly ChannelName[] = Object.freeze([
  CHANNELS.sessionData,
  CHANNELS.sessionExit,
  CHANNELS.sessionStatus,
  CHANNELS.tabsChanged,
  CHANNELS.activateTab,
  CHANNELS.settingsChanged
])
