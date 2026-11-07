import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CHANNELS } from '../shared/channels'
import type {
  LaunchOverrides,
  PermissionAnswer,
  TabId,
  UserInput
} from '../shared/types'
import type { TabController } from './tabs/TabController'
import type { AgentSessionManager } from './agent/AgentSessionManager'
import type { PermissionBroker } from './agent/permissions'
import { sanitizeOverrides, sanitizeTabPatch } from './tabs/sanitize'

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

  ipcMain.handle(CHANNELS.agentPermissionMode, async (_e, id: unknown, mode: unknown) => {
    if (!isString(id) || !isString(mode)) return
    await manager.get(id)?.setPermissionMode(mode)
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

  ipcMain.handle(CHANNELS.agentPanel, async (_e, id: unknown) => {
    if (!isString(id)) return
    await manager.get(id)?.refreshMcp()
  })

  ipcMain.handle(CHANNELS.permissionAnswer, (_e, requestId: unknown, answer: unknown) => {
    if (!isString(requestId)) return
    broker.answer(requestId, sanitizeAnswer(answer))
  })

  ipcMain.handle(CHANNELS.permissionRules, () => broker.rules())

  ipcMain.handle(CHANNELS.permissionRuleDelete, (_e, ruleId: unknown) => {
    if (isString(ruleId)) broker.deleteRule(ruleId)
  })

  ipcMain.handle(CHANNELS.historyList, async (_e, id: unknown) => {
    if (!isString(id)) return []
    return controller.history(id)
  })

  ipcMain.handle(CHANNELS.dialogPickFolder, async () => {
    const win = deps.getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(CHANNELS.dialogPickFiles, async () => {
    const win = deps.getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
}

/** A message from the renderer is text plus attachments, and nothing else. */
export function sanitizeInput(value: unknown): UserInput {
  if (typeof value !== 'object' || value === null) return { text: '', attachments: [] }
  const input = value as Record<string, unknown>
  const text = isString(input['text']) ? input['text'] : ''

  const attachments: UserInput['attachments'] = []
  for (const entry of Array.isArray(input['attachments']) ? input['attachments'] : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const attachment = entry as Record<string, unknown>
    if (attachment['kind'] === 'file' && isString(attachment['path'])) {
      attachments.push({ kind: 'file', path: attachment['path'] })
    } else if (
      attachment['kind'] === 'image' &&
      isString(attachment['mediaType']) &&
      isString(attachment['dataBase64'])
    ) {
      attachments.push({
        kind: 'image',
        mediaType: attachment['mediaType'],
        dataBase64: attachment['dataBase64']
      })
    }
  }
  return { text, attachments }
}

/**
 * An answer is allow or deny — anything else is a deny. A malformed payload
 * must never widen a permission.
 */
export function sanitizeAnswer(value: unknown): PermissionAnswer {
  if (typeof value !== 'object' || value === null) return { behavior: 'deny' }
  const answer = value as Record<string, unknown>
  return {
    behavior: answer['behavior'] === 'allow' ? 'allow' : 'deny',
    ...(answer['remember'] === true ? { remember: true } : {})
  }
}

export type { LaunchOverrides, TabId }
