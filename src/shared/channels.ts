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
  tabsRetry: 'tabs:retry',

  agentSend: 'agent:send',
  agentInterrupt: 'agent:interrupt',
  agentPermissionMode: 'agent:permissionMode',
  agentModel: 'agent:model',
  agentEffort: 'agent:effort',
  agentCommands: 'agent:commands',
  agentRibbon: 'agent:ribbon',
  agentPanel: 'agent:panelRefresh',

  permissionAnswer: 'permission:answer',
  permissionRules: 'permission:rules',
  permissionRuleDelete: 'permission:ruleDelete',
  questionAnswer: 'question:answer',
  planAnswer: 'plan:answer',

  historyList: 'history:list',
  historyOpen: 'history:open',

  dialogPickFolder: 'dialog:pickFolder',
  dialogPickFiles: 'dialog:pickFiles',
  filesIndex: 'files:index',
  filesResolve: 'files:resolve',
  filesOpen: 'files:open',
  filesReveal: 'files:reveal',
  filesOpenInEditor: 'files:openInEditor',
  filesPrepareImage: 'files:prepareImage',

  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowZoom: 'window:zoom',
  windowReload: 'window:reload',
  openExternal: 'window:openExternal',

  setupCheck: 'setup:check',
  setupInstall: 'setup:install',
  setupCancel: 'setup:cancel',
  setupLogin: 'setup:login',

  updateGet: 'update:get',
  updateRestart: 'update:restart',

  // main -> renderer (events)
  ribbonChanged: 'ribbon:changed',
  panelChanged: 'panel:changed',
  statusChanged: 'status:changed',
  tabsChanged: 'tabs:changed',
  activateTab: 'tabs:activateRequest',
  settingsChanged: 'settings:changed',
  commandsChanged: 'commands:changed',
  setupOutput: 'setup:output',
  setupLoginProgress: 'setup:loginProgress',
  updateChanged: 'update:changed'
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
  CHANNELS.tabsRetry,
  CHANNELS.agentSend,
  CHANNELS.agentInterrupt,
  CHANNELS.agentPermissionMode,
  CHANNELS.agentModel,
  CHANNELS.agentEffort,
  CHANNELS.agentCommands,
  CHANNELS.agentRibbon,
  CHANNELS.agentPanel,
  CHANNELS.permissionAnswer,
  CHANNELS.permissionRules,
  CHANNELS.permissionRuleDelete,
  CHANNELS.questionAnswer,
  CHANNELS.planAnswer,
  CHANNELS.historyList,
  CHANNELS.historyOpen,
  CHANNELS.dialogPickFolder,
  CHANNELS.dialogPickFiles,
  CHANNELS.filesIndex,
  CHANNELS.filesResolve,
  CHANNELS.filesOpen,
  CHANNELS.filesReveal,
  CHANNELS.filesOpenInEditor,
  CHANNELS.filesPrepareImage,
  CHANNELS.windowMinimize,
  CHANNELS.windowMaximize,
  CHANNELS.windowClose,
  CHANNELS.windowZoom,
  CHANNELS.windowReload,
  CHANNELS.openExternal,
  CHANNELS.setupCheck,
  CHANNELS.setupInstall,
  CHANNELS.setupCancel,
  CHANNELS.setupLogin,
  CHANNELS.updateGet,
  CHANNELS.updateRestart
])

export const EVENT_CHANNELS: readonly ChannelName[] = Object.freeze([
  CHANNELS.ribbonChanged,
  CHANNELS.panelChanged,
  CHANNELS.statusChanged,
  CHANNELS.tabsChanged,
  CHANNELS.activateTab,
  CHANNELS.settingsChanged,
  CHANNELS.commandsChanged,
  CHANNELS.setupOutput,
  CHANNELS.setupLoginProgress,
  CHANNELS.updateChanged
])
