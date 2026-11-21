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
  // этап 7 (H2), пока нет чтения файлов этапа 6: текст локального файла для FileViewer
  filesViewerRead: 'files:viewerRead',
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
  CHANNELS.historySearch,
  CHANNELS.filesViewerRead
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
  // этап 7: шаблоны, Git, поиск по истории
  CHANNELS.templatesChanged
])

/** Fire-and-forget: the renderer sends, nothing comes back. */
export const SEND_CHANNELS: readonly ChannelName[] = Object.freeze([CHANNELS.rendererError])
