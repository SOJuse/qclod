/**
 * Every IPC channel Qclod uses, in one place. The preload bridge exposes a
 * named wrapper per channel and never hands `ipcRenderer` to the renderer.
 *
 * v1's terminal channels (session:write / session:resize / session:data) are
 * gone with the pty.
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
  tabsRestart: 'tabs:restart',

  agentSend: 'agent:send',
  agentInterrupt: 'agent:interrupt',
  agentPermissionMode: 'agent:permissionMode',
  agentCommands: 'agent:commands',
  agentRibbon: 'agent:ribbon',
  agentPanel: 'agent:panelRefresh',

  permissionAnswer: 'permission:answer',
  permissionRules: 'permission:rules',
  permissionRuleDelete: 'permission:ruleDelete',
  questionAnswer: 'question:answer',

  historyList: 'history:list',
  historyOpen: 'history:open',

  dialogPickFolder: 'dialog:pickFolder',
  dialogPickFiles: 'dialog:pickFiles',
  filesIndex: 'files:index',

  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',

  // main -> renderer (events)
  ribbonChanged: 'ribbon:changed',
  panelChanged: 'panel:changed',
  statusChanged: 'status:changed',
  tabsChanged: 'tabs:changed',
  activateTab: 'tabs:activateRequest',
  settingsChanged: 'settings:changed',
  commandsChanged: 'commands:changed',
  permissionAsked: 'permission:asked'
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
  CHANNELS.tabsRestart,
  CHANNELS.agentSend,
  CHANNELS.agentInterrupt,
  CHANNELS.agentPermissionMode,
  CHANNELS.agentCommands,
  CHANNELS.agentRibbon,
  CHANNELS.agentPanel,
  CHANNELS.permissionAnswer,
  CHANNELS.permissionRules,
  CHANNELS.permissionRuleDelete,
  CHANNELS.questionAnswer,
  CHANNELS.historyList,
  CHANNELS.historyOpen,
  CHANNELS.dialogPickFolder,
  CHANNELS.dialogPickFiles,
  CHANNELS.filesIndex,
  CHANNELS.windowMinimize,
  CHANNELS.windowMaximize,
  CHANNELS.windowClose
])

export const EVENT_CHANNELS: readonly ChannelName[] = Object.freeze([
  CHANNELS.ribbonChanged,
  CHANNELS.panelChanged,
  CHANNELS.statusChanged,
  CHANNELS.tabsChanged,
  CHANNELS.activateTab,
  CHANNELS.settingsChanged,
  CHANNELS.commandsChanged,
  CHANNELS.permissionAsked
])
