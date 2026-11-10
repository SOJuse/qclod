import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CHANNELS } from '../shared/channels'
import { EFFORT_LEVELS, PERMISSION_MODES } from '../shared/types'
import type { EffortLevel, LaunchOverrides, PanelSnapshot, TabId } from '../shared/types'
import { buildFileIndex } from './files/fileIndex'
import type { TabController } from './tabs/TabController'
import { EMPTY_PANEL } from './agent/panelData'
import type { AgentSessionManager } from './agent/AgentSessionManager'
import type { PermissionBroker } from './agent/permissions'
import {
  sanitizeAnswer,
  sanitizeInput,
  sanitizeOverrides,
  sanitizeTabPatch
} from './tabs/sanitize'

export interface AgentIpcDeps {
  getWindow: () => BrowserWindow | null
  controller: TabController
  manager: AgentSessionManager
  broker: PermissionBroker
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * Everything the renderer may ask of an agent.
 *
 * Every payload crossing this boundary is checked here rather than trusted:
 * the renderer is the least privileged part of the app and a bug there must
 * not be able to point a session at another folder or fake a status.
 */
export function registerAgentIpc(deps: AgentIpcDeps): void {
  const { controller, manager, broker } = deps

  ipcMain.handle(CHANNELS.tabsList, () => controller.list())

  ipcMain.handle(CHANNELS.tabsCreate, async (_e, cwd: unknown, overrides: unknown) => {
    if (!isString(cwd)) return null
    return controller.create(cwd, sanitizeOverrides(overrides))
  })

  ipcMain.handle(CHANNELS.tabsClose, async (_e, id: unknown) => {
    if (!isString(id)) return
    broker.cancelTab(id)
    await controller.close(id)
  })

  ipcMain.handle(CHANNELS.tabsActivate, async (_e, id: unknown) => {
    if (!isString(id)) return
    await controller.activate(id)
  })

  ipcMain.handle(CHANNELS.tabsUpdate, (_e, id: unknown, patch: unknown) => {
    if (!isString(id)) return undefined
    return controller.update(id, sanitizeTabPatch(patch))
  })

  ipcMain.handle(CHANNELS.tabsRestart, async (_e, id: unknown) => {
    if (!isString(id)) return
    broker.cancelTab(id)
    await controller.restart(id)
  })

  ipcMain.handle(CHANNELS.agentSend, (_e, id: unknown, input: unknown) => {
    if (!isString(id)) return
    const session = manager.get(id)
    if (!session) return
    session.send(sanitizeInput(input))
  })

  ipcMain.handle(CHANNELS.agentInterrupt, async (_e, id: unknown) => {
    if (!isString(id)) return
    await manager.get(id)?.interrupt()
  })

  // The mode decides whether the agent asks at all, so an unknown string must
  // never reach the session: it would be rejected deep inside the SDK, far
  // from here, or silently mean something we did not intend.
  ipcMain.handle(CHANNELS.agentPermissionMode, async (_e, id: unknown, mode: unknown) => {
    if (!isString(id) || !isString(mode)) return
    if (!(PERMISSION_MODES as readonly string[]).includes(mode)) return

    // bypassPermissions is confirmed inside the session, which is the one
    // place every path to it passes through — this channel, a tab's stored
    // overrides, and a settings default alike.
    await manager.get(id)?.setPermissionMode(mode)
    // What the session actually ended up in — a refused bypass leaves it alone.
    const actual = manager.get(id)?.panel.permissionMode
    if (actual) controller.rememberOverride(id, { permissionMode: actual })
  })

  ipcMain.handle(CHANNELS.agentModel, async (_e, id: unknown, model: unknown) => {
    if (!isString(id) || !isString(model) || model === '') return
    await manager.get(id)?.setModel(model)
  })

  // The levels are an enum, not free text: an unknown one would be refused
  // deep inside the SDK, far from here.
  ipcMain.handle(CHANNELS.agentEffort, async (_e, id: unknown, level: unknown) => {
    if (!isString(id) || !isString(level)) return
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) return
    const session = manager.get(id)
    if (!session) return
    await session.setEffort(level as EffortLevel)
    // Kept in Qclod's own tabs.json, so a reopened tab starts at the same
    // level — the user's settings files are never touched.
    controller.rememberOverride(id, { effort: level as EffortLevel })
  })

  ipcMain.handle(CHANNELS.agentCommands, async (_e, id: unknown) => {
    if (!isString(id)) return []
    return (await manager.get(id)?.commands()) ?? []
  })

  // The ribbon a tab already has — what a tab being switched to needs in order
  // to draw itself without replaying the whole session.
  ipcMain.handle(CHANNELS.agentRibbon, (_e, id: unknown) => {
    if (!isString(id)) return []
    return controller.itemsOf(id)
  })

  // What the panel holds right now, answered at once — a reloaded window or
  // a missed event must not leave the panel empty. Live MCP state is asked
  // for meanwhile and arrives as an ordinary event.
  ipcMain.handle(CHANNELS.agentPanel, (_e, id: unknown): PanelSnapshot => {
    if (!isString(id)) return { rev: 0, data: EMPTY_PANEL }
    void manager.get(id)?.refreshMcp().catch(() => undefined)
    return controller.panelOf(id)
  })

  ipcMain.handle(CHANNELS.permissionAnswer, (_e, requestId: unknown, answer: unknown) => {
    if (!isString(requestId)) return
    broker.answer(requestId, sanitizeAnswer(answer))
  })

  ipcMain.handle(CHANNELS.questionAnswer, (_e, id: unknown, toolUseId: unknown, choice: unknown) => {
    if (!isString(id) || !isString(toolUseId) || !isString(choice)) return
    manager.get(id)?.answerQuestion(toolUseId, choice)
  })

  ipcMain.handle(CHANNELS.planAnswer, (_e, id: unknown, requestId: unknown, approve: unknown) => {
    if (!isString(id) || !isString(requestId)) return
    // Anything but a literal true is not an approval.
    manager.get(id)?.answerPlan(requestId, approve === true)
  })

  ipcMain.handle(CHANNELS.permissionRules, () => broker.rules())

  ipcMain.handle(CHANNELS.permissionRuleDelete, (_e, ruleId: unknown) => {
    if (isString(ruleId)) broker.deleteRule(ruleId)
  })

  ipcMain.handle(CHANNELS.historyList, async (_e, id: unknown) => {
    if (!isString(id)) return []
    return controller.history(id)
  })

  ipcMain.handle(CHANNELS.historyOpen, (_e, id: unknown, sessionId: unknown, title: unknown) => {
    if (!isString(id) || !isString(sessionId)) return null
    const tab = controller.list().find((t) => t.id === id)
    if (!tab) return null
    return controller.openHistory(tab.cwd, sessionId, isString(title) ? title : undefined)
  })

  // A native file dialog cannot be driven from a test, so an e2e run answers
  // it from the environment — the same kind of seam as QCLOD_FAKE_SDK, and
  // never set in a real install.
  ipcMain.handle(CHANNELS.filesIndex, async (_e, id: unknown) => {
    if (!isString(id)) return []
    const tab = controller.list().find((t) => t.id === id)
    if (!tab || tab.missingCwd) return []
    return buildFileIndex(tab.cwd)
  })

  ipcMain.handle(CHANNELS.dialogPickFolder, async () => {
    const stubbed = process.env['QCLOD_PICK_FOLDER']
    if (stubbed) return stubbed

    const win = deps.getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(CHANNELS.dialogPickFiles, async () => {
    const stubbed = process.env['QCLOD_PICK_FILES']
    if (stubbed) return stubbed.split(';').filter(Boolean)

    const win = deps.getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
}

export type { LaunchOverrides, TabId }
