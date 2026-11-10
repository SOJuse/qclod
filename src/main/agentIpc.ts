import { BrowserWindow, dialog, ipcMain } from 'electron'
import { CHANNELS } from '../shared/channels'
import { EFFORT_LEVELS, PERMISSION_MODES } from '../shared/types'
import type {
  EffortLevel,
  LaunchOverrides,
  PanelSnapshot,
  RibbonSnapshot,
  TabId
} from '../shared/types'
import { buildFileIndex } from './files/fileIndex'
import type { PathResolver } from './files/pathResolver'
import { openInEditor, openPath, revealPath } from './files/fileActions'
import type { TabController } from './tabs/TabController'
import { EMPTY_PANEL } from './agent/panelData'
import type { AgentSessionManager } from './agent/AgentSessionManager'
import type { PermissionBroker } from './agent/permissions'
import {
  sanitizeAnswer,
  sanitizeQuestionAnswers,
  sanitizeInput,
  sanitizeOverrides,
  sanitizeTabPatch
} from './tabs/sanitize'

export interface AgentIpcDeps {
  getWindow: () => BrowserWindow | null
  controller: TabController
  manager: AgentSessionManager
  broker: PermissionBroker
  /** The last choice becomes what a new tab starts with. */
  rememberDefault: (patch: LaunchOverrides) => void
  /** One for the whole app: it is also what proves a path may be acted on. */
  resolver: PathResolver
  /** The user's editor template; empty means no editor. */
  getEditorCommand: () => string
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** No path in a chat is this long; a longer string is not worth a stat. */
const MAX_RAW_LENGTH = 1024

function lineNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000_000
    ? value
    : undefined
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
    deps.resolver.forget(id)
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

  ipcMain.handle(CHANNELS.tabsRetry, async (_e, id: unknown) => {
    if (!isString(id)) return
    broker.cancelTab(id)
    await controller.retry(id)
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
    if (actual) {
      // saveTabs drops a bypass; the default sanitiser turns it into 'default'.
      controller.rememberOverride(id, { permissionMode: actual })
      deps.rememberDefault({ permissionMode: actual })
    }
  })

  ipcMain.handle(CHANNELS.agentModel, async (_e, id: unknown, model: unknown) => {
    if (!isString(id) || !isString(model) || model === '') return
    const session = manager.get(id)
    if (!session) return
    await session.setModel(model)
    controller.rememberOverride(id, { model })
    deps.rememberDefault({ model })
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
    deps.rememberDefault({ effort: level as EffortLevel })
  })

  ipcMain.handle(CHANNELS.agentCommands, async (_e, id: unknown) => {
    if (!isString(id)) return []
    return (await manager.get(id)?.commands()) ?? []
  })

  // The ribbon a tab already has, with its revision — what a window needs in
  // order to draw a tab without replaying the whole session. The revision
  // tells the window which events still in flight the snapshot already holds.
  ipcMain.handle(CHANNELS.agentRibbon, (_e, id: unknown): RibbonSnapshot => {
    if (!isString(id)) return { rev: 0, items: [], todo: null }
    return controller.ribbonOf(id)
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

  ipcMain.handle(CHANNELS.questionAnswer, (_e, id: unknown, toolUseId: unknown, answers: unknown) => {
    if (!isString(id) || !isString(toolUseId)) return
    const clean = sanitizeQuestionAnswers(answers)
    // Nothing usable is no answer: the card stays open rather than sending an empty one.
    if (Object.keys(clean).length === 0) return
    manager.get(id)?.answerQuestion(toolUseId, clean)
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

  ipcMain.handle(CHANNELS.filesIndex, async (_e, id: unknown) => {
    if (!isString(id)) return []
    const tab = controller.list().find((t) => t.id === id)
    if (!tab || tab.missingCwd) return []
    return buildFileIndex(tab.cwd)
  })

  // Which of the paths in a tab's text exist, relative to the tab's folder.
  // Anything that is not a short string answers null in its place.
  ipcMain.handle(CHANNELS.filesResolve, async (_e, id: unknown, raws: unknown) => {
    if (!isString(id) || !Array.isArray(raws)) return []
    const tab = controller.list().find((t) => t.id === id)
    if (!tab) return raws.map(() => null)
    const valid = raws.map((r) => isString(r) && r !== '' && r.length <= MAX_RAW_LENGTH)
    const answers = await deps.resolver.resolve(
      tab.cwd,
      raws.filter((_r, i) => valid[i]) as string[],
      id
    )
    let next = 0
    return valid.map((ok) => (ok ? (answers[next++] ?? null) : null))
  })

  // An action takes only a path main found on disk for this same tab in the
  // last half hour (PathResolver.knows). Anything else is silently nothing.
  const mayAct = (id: unknown, absPath: unknown): absPath is string =>
    isString(id) &&
    isString(absPath) &&
    controller.list().some((t) => t.id === id) &&
    deps.resolver.knows(absPath, id)

  ipcMain.handle(CHANNELS.filesOpen, async (_e, id: unknown, absPath: unknown) => {
    if (!mayAct(id, absPath)) return null
    return openPath(absPath)
  })

  ipcMain.handle(CHANNELS.filesReveal, (_e, id: unknown, absPath: unknown) => {
    if (!mayAct(id, absPath)) return
    revealPath(absPath)
  })

  ipcMain.handle(
    CHANNELS.filesOpenInEditor,
    (_e, id: unknown, absPath: unknown, line: unknown, column: unknown) => {
      if (!mayAct(id, absPath)) return null
      const template = deps.getEditorCommand()
      if (template.trim() === '') return null
      const target: { path: string; line?: number; column?: number } = { path: absPath }
      const l = lineNumber(line)
      const c = lineNumber(column)
      if (l !== undefined) target.line = l
      if (l !== undefined && c !== undefined) target.column = c
      // A message for the user when the template cannot run this path safely.
      return openInEditor(template, target)
    }
  )

  // A native file dialog cannot be driven from a test, so the e2e build
  // answers it from the environment. A release build has no such branch
  // (buildFlags.d.ts).
  ipcMain.handle(CHANNELS.dialogPickFolder, async () => {
    const stubbed = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_PICK_FOLDER'] : undefined
    if (stubbed) return stubbed

    const win = deps.getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(CHANNELS.dialogPickFiles, async () => {
    const stubbed = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_PICK_FILES'] : undefined
    if (stubbed) return stubbed.split(';').filter(Boolean)

    const win = deps.getWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  })
}

export type { LaunchOverrides, TabId }
