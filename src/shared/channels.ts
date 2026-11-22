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
  agentQueueCancel: 'agent:queueCancel',
  agentQueueSendNow: 'agent:queueSendNow',
  agentPermissionMode: 'agent:permissionMode',
  agentModel: 'agent:model',
  agentEffort: 'agent:effort',
  agentRemote: 'agent:remote',
  agentCommands: 'agent:commands',
  agentRibbon: 'agent:ribbon',
  agentPanel: 'agent:panelRefresh',
  agentTaskOutput: 'agent:taskOutput',
  agentTaskStop: 'agent:taskStop',
  agentOpenTerminal: 'agent:openTerminal',
  voiceStart: 'voice:start',

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

  // renderer -> main (send, no answer)
  rendererError: 'renderer:error',

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
  updateChanged: 'update:changed',

  // — этап 2: проекты, раскладка, окно-заглушка
  // renderer -> main (invoke)
  layoutGet: 'layout:get',
  layoutSet: 'layout:set',
  projectHistory: 'projects:history',
  projectOpenSession: 'projects:openSession',
  projectForget: 'projects:forget',
  rendererRetry: 'window:rendererRetry',
  logsOpen: 'logs:open',
  // main -> renderer (event)
  layoutChanged: 'layout:changed',

  // stage 3: autonomy
  // renderer -> main (invoke)
  autonomyHold: 'autonomy:hold',
  autonomyAnswerNow: 'autonomy:answerNow',

  // Stage 5: voice (voiceStart, Win+H, stays above)
  voiceModels: 'voice:models',
  voiceDownload: 'voice:download',
  voiceCancelDownload: 'voice:cancelDownload',
  voiceDelete: 'voice:delete',
  voiceBegin: 'voice:begin',
  voiceEnd: 'voice:end',
  voiceOpenMicSettings: 'voice:openMicSettings',
  voiceOpenVcRedist: 'voice:openVcRedist',
  // renderer -> main (send)
  voiceAudio: 'voice:audio',
  // main -> renderer (events)
  voiceEvent: 'voice:event',
  voiceModelsChanged: 'voice:modelsChanged',
  // этап 4: сабагенты
  // renderer -> main (invoke)
  agentSubagentSend: 'agent:subagentSend',
  agentSubagentStop: 'agent:subagentStop',
  // stage 6
  // main -> renderer (event): a menu item that does what a key does
  appAction: 'app:action',

  // stage 6: servers over SSH
  // renderer -> main (invoke)
  serversList: 'servers:list',
  serversSave: 'servers:save',
  serversRemove: 'servers:remove',
  serversConnect: 'servers:connect',
  serversForgetPassword: 'servers:forgetPassword',
  serversPromptAnswer: 'servers:promptAnswer',
  serversListDir: 'servers:listDir',
  serversOpenFolder: 'servers:openFolder',
  serversLogin: 'servers:login',
  serversLoginCode: 'servers:loginCode',
  serversUpdateRelay: 'servers:updateRelay',
  viewerRead: 'viewer:read',
  viewerDownloadOpen: 'viewer:downloadOpen',
  filesUploadRemote: 'files:uploadRemote',
  terminalOpen: 'terminal:open',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalAttach: 'terminal:attach',
  // renderer -> main (send)
  terminalInput: 'terminal:input',
  /** A local file the person dropped or pasted (the preload, from webUtils): it may go to a server. */
  filesSeen: 'files:seen',
  // main -> renderer (events)
  serversChanged: 'servers:changed',
  serversPrompt: 'servers:prompt',
  serversConnectProgress: 'servers:connectProgress',
  serversLoginProgress: 'servers:loginProgress',
  /** An ssh question is gone without the window's answer (timeout, ssh exited, cancelled): its dialog closes. */
  serversPromptClosed: 'servers:promptClosed',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  // этап 7: шаблоны, Git, поиск по истории
  // renderer -> main (invoke)
  templatesList: 'templates:list',
  templatesSave: 'templates:save',
  templatesSaveMany: 'templates:saveMany',
  templatesDelete: 'templates:delete',
  harvestPreview: 'templates:harvestPreview',
  harvestRun: 'templates:harvestRun',
  harvestCancel: 'templates:harvestCancel',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitCommit: 'git:commit',
  historySearch: 'history:search',
  // main -> renderer (event)
  templatesChanged: 'templates:changed'
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
  CHANNELS.agentQueueCancel,
  CHANNELS.agentQueueSendNow,
  CHANNELS.agentPermissionMode,
  CHANNELS.agentModel,
  CHANNELS.agentEffort,
  CHANNELS.agentRemote,
  CHANNELS.agentCommands,
  CHANNELS.agentRibbon,
  CHANNELS.agentPanel,
  CHANNELS.agentTaskOutput,
  CHANNELS.agentTaskStop,
  CHANNELS.agentOpenTerminal,
  CHANNELS.voiceStart,
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
  CHANNELS.updateRestart,
  // — этап 2: проекты, раскладка, окно-заглушка
  CHANNELS.layoutGet,
  CHANNELS.layoutSet,
  CHANNELS.projectHistory,
  CHANNELS.projectOpenSession,
  CHANNELS.projectForget,
  CHANNELS.rendererRetry,
  CHANNELS.logsOpen,
  // stage 3: autonomy
  CHANNELS.autonomyHold,
  CHANNELS.autonomyAnswerNow,
  // Stage 5: voice
  CHANNELS.voiceModels,
  CHANNELS.voiceDownload,
  CHANNELS.voiceCancelDownload,
  CHANNELS.voiceDelete,
  CHANNELS.voiceBegin,
  CHANNELS.voiceEnd,
  CHANNELS.voiceOpenMicSettings,
  CHANNELS.voiceOpenVcRedist,
  // этап 4: сабагенты
  CHANNELS.agentSubagentSend,
  CHANNELS.agentSubagentStop,
  // stage 6: servers over SSH
  CHANNELS.serversList,
  CHANNELS.serversSave,
  CHANNELS.serversRemove,
  CHANNELS.serversConnect,
  CHANNELS.serversForgetPassword,
  CHANNELS.serversPromptAnswer,
  CHANNELS.serversListDir,
  CHANNELS.serversOpenFolder,
  CHANNELS.serversLogin,
  CHANNELS.serversLoginCode,
  CHANNELS.serversUpdateRelay,
  CHANNELS.viewerRead,
  CHANNELS.viewerDownloadOpen,
  CHANNELS.filesUploadRemote,
  CHANNELS.terminalOpen,
  CHANNELS.terminalResize,
  CHANNELS.terminalClose,
  CHANNELS.terminalAttach,
  // этап 7: шаблоны, Git, поиск по истории
  CHANNELS.templatesList,
  CHANNELS.templatesSave,
  CHANNELS.templatesSaveMany,
  CHANNELS.templatesDelete,
  CHANNELS.harvestPreview,
  CHANNELS.harvestRun,
  CHANNELS.harvestCancel,
  CHANNELS.gitStatus,
  CHANNELS.gitDiff,
  CHANNELS.gitCommit,
  CHANNELS.historySearch
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
  CHANNELS.updateChanged,
  // — этап 2: проекты, раскладка, окно-заглушка
  CHANNELS.layoutChanged,
  // Stage 5: voice
  CHANNELS.voiceEvent,
  CHANNELS.voiceModelsChanged,
  // stage 6
  CHANNELS.appAction,
  // stage 6: servers over SSH
  CHANNELS.serversChanged,
  CHANNELS.serversPrompt,
  CHANNELS.serversConnectProgress,
  CHANNELS.serversLoginProgress,
  CHANNELS.serversPromptClosed,
  CHANNELS.terminalData,
  CHANNELS.terminalExit,
  // этап 7: шаблоны, Git, поиск по истории
  CHANNELS.templatesChanged
])

/** Fire-and-forget: the renderer sends, nothing comes back. */
export const SEND_CHANNELS: readonly ChannelName[] = Object.freeze([
  CHANNELS.rendererError,
  // Stage 5: voice
  CHANNELS.voiceAudio,
  // stage 6: keystrokes for a server's terminal; a dropped/pasted file main may upload
  CHANNELS.terminalInput,
  CHANNELS.filesSeen
])
