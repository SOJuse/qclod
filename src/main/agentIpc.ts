import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { CHANNELS } from '../shared/channels'
import { EFFORT_LEVELS, PERMISSION_MODES } from '../shared/types'
import { projectKey } from '../shared/projects'
import type {
  EffortLevel,
  LaunchOverrides,
  LayoutState,
  PanelSnapshot,
  RibbonSnapshot,
  SessionSummary,
  SubagentSendResult,
  SubagentStopResult,
  TabId,
  TabState,
  UserInput
} from '../shared/types'
import { FILE_INDEX_LIMIT, buildFileIndex } from './files/fileIndex'
import { RemoteIndexCache, UPLOAD_TOO_LARGE_TEXT, uploadFailedText, uploadFile } from './ssh/uploads'
import { MAX_PER_CALL, type PathResolver } from './files/pathResolver'
import { openInEditor, openPath, revealPath } from './files/fileActions'
import { pasteMediaType, pasteRealPath } from './files/imagePaste'
import { prepareImage } from './files/prepareImage'
import { viewerAccess } from './files/viewerIpc'
import type { RelayReader } from './ssh/remoteFiles'
import type { TabController, TabHistory } from './tabs/TabController'
import type { LayoutStore } from './store/layoutStore'
import type { AutonomyHost } from './autonomy/autonomyHost'
import { EMPTY_PANEL } from './agent/panelData'
import { withFault } from './testSeams/ipcFaults'
import type { AgentSessionManager } from './agent/AgentSessionManager'
import type { PermissionBroker } from './agent/permissions'
import {
  sanitizeAnswer,
  sanitizeQuestionAnswers,
  sanitizeInput,
  sanitizeLayoutPatch,
  sanitizeOverrides,
  sanitizePlanDecision,
  sanitizeQuestionNotes,
  sanitizeTabPatch,
  sanitizeCardId,
  sanitizeSubagentText
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
  /** The app's own folder: pasted images are kept in its pastes. */
  userData: string
  /** Opens Claude Code in a console in this folder. */
  openTerminal: (cwd: string) => void
  /** userData/layout.json, shared with the controller. */
  layout: LayoutStore
  /** Past conversations of a folder, for a project in the sidebar. */
  history: Pick<TabHistory, 'list'>
  /** The per-tab autonomy cores (stage 3). */
  autonomy?: Pick<AutonomyHost, 'hold' | 'answerNow' | 'remoteWanted'>
  /** Stage 6: a server project's past conversations, from its relay. */
  serverHistory?: (cwd: string, hostId: string) => Promise<SessionSummary[]>
  /** Stage 6: whether this id is a server Qclod knows. */
  knownServer?: (hostId: string) => boolean
  /** Stage 6: a server's relay, raised if need be — a server chat's files are read through it. */
  serverClient?: (hostId: string) => Promise<RelayReader>
  /** Stage 6: «Закрыть чат» closes what belongs to it, its server terminal too. */
  onTabClosed?: (id: TabId) => void
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** No path in a chat is this long; a longer string is not worth a stat. */
const MAX_RAW_LENGTH = 1024

/** No model name is this long; a longer string is not worth sending to the SDK. */
const MAX_MODEL_LENGTH = 200

/** Base64 of a picture worth trying to read; a larger paste is not a screenshot. */
const MAX_PASTE_BASE64 = 80_000_000

/**
 * A pasted image reaches main as the path of its copy, not its bytes: the
 * bytes are read here, from a path sanitizeInput has already checked is ours,
 * with the type its extension means. One that cannot be read is dropped
 * rather than sent empty.
 */
function withPastedBytes(input: UserInput): UserInput {
  const attachments: UserInput['attachments'] = []
  for (const a of input.attachments) {
    if (a.kind !== 'image' || a.dataBase64 !== '') {
      attachments.push(a)
      continue
    }
    if (!a.path) continue
    try {
      const dataBase64 = readFileSync(a.path).toString('base64')
      const mediaType = pasteMediaType(a.path)
      if (dataBase64 !== '') attachments.push({ ...a, mediaType, dataBase64 })
    } catch {
      /* cleaned up meanwhile */
    }
  }
  return { ...input, attachments }
}

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
  // Stage 6: the read-only viewer and a server chat's paths (task 24).
  const viewer = viewerAccess({
    tab: (id) => controller.list().find((t) => t.id === id),
    knowsLocal: (absPath, id) => deps.resolver.knows(absPath, id),
    client: (hostId) =>
      deps.serverClient ? deps.serverClient(hostId) : Promise.reject(new Error('серверы недоступны')),
    userData: deps.userData,
    openPath
  })
  // Stage 6 (task 25): a server chat's @-list, kept a minute per tab.
  const remoteIndex = new RemoteIndexCache()
  const serverClient = (hostId: string): Promise<RelayReader> =>
    deps.serverClient ? deps.serverClient(hostId) : Promise.reject(new Error('серверы недоступны'))

  ipcMain.handle(CHANNELS.tabsList, () => withFault(CHANNELS.tabsList, () => controller.list()))

  ipcMain.handle(CHANNELS.tabsCreate, async (_e, cwd: unknown, overrides: unknown) => {
    if (!isString(cwd)) return null
    return controller.create(cwd, sanitizeOverrides(overrides))
  })

  ipcMain.handle(CHANNELS.tabsClose, async (_e, id: unknown) => {
    if (!isString(id)) return
    broker.cancelTab(id)
    deps.resolver.forget(id)
    viewer.forget(id)
    remoteIndex.forget(id)
    deps.onTabClosed?.(id)
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

  // False when the message went nowhere — no live session, and none being
  // swapped in — so the window gives it back to the input line.
  ipcMain.handle(CHANNELS.agentSend, (_e, id: unknown, input: unknown): boolean => {
    if (!isString(id)) return false
    return controller.send(id, withPastedBytes(sanitizeInput(input, deps.userData)))
  })

  // «Стоп» hands back what was waiting to be sent; the window puts it back
  // in the input field.
  ipcMain.handle(CHANNELS.agentInterrupt, async (_e, id: unknown): Promise<UserInput[]> => {
    if (!isString(id)) return []
    return (await manager.get(id)?.interrupt()) ?? []
  })

  // «Отменить» and «Изменить» on the strip: the message taken back, for the
  // input field — an image without the bytes its copy on disk stands for —
  // or null when the agent had read it already or it is gone.
  ipcMain.handle(
    CHANNELS.agentQueueCancel,
    async (_e, id: unknown, queuedId: unknown): Promise<UserInput | null> => {
      if (!isString(id) || !isString(queuedId)) return null
      return (await manager.get(id)?.cancelQueued(queuedId)) ?? null
    }
  )

  // «Отправить сейчас»: false when there was nothing to hurry.
  ipcMain.handle(
    CHANNELS.agentQueueSendNow,
    async (_e, id: unknown, queuedId: unknown): Promise<boolean> => {
      if (!isString(id) || !isString(queuedId)) return false
      return (await manager.get(id)?.sendQueuedNow(queuedId)) ?? false
    }
  )

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
    // «Авто-да» answers what is already waiting too, not only what comes next.
    if (actual === 'autoAllow') broker.allowTab(id)
    // A bypass is for this session only (spec 5.4): remembered, the default
    // sanitiser would turn it into 'default' and lose the mode saved before.
    if (actual && actual !== 'bypassPermissions') {
      controller.rememberOverride(id, { permissionMode: actual })
      // «Авто-да» stays with the tab it was confirmed for: as the default it
      // would reach every new tab and folder without being asked about.
      if (actual !== 'autoAllow') deps.rememberDefault({ permissionMode: actual })
    }
  })

  ipcMain.handle(CHANNELS.agentModel, async (_e, id: unknown, model: unknown) => {
    if (!isString(id) || !isString(model) || model === '' || model.length > MAX_MODEL_LENGTH) return
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

  ipcMain.handle(CHANNELS.agentRemote, async (_e, id: unknown, enabled: unknown) => {
    if (!isString(id) || typeof enabled !== 'boolean') return
    const session = manager.get(id)
    if (!session) return
    // The session name the phone shows is the tab's title.
    const title = controller.list().find((tab) => tab.id === id)?.title
    // The person's own switch is what the core keeps on (decision 9) — told
    // before the CLI answers: that may take a minute, and a first attempt
    // that fails is the core's to retry.
    deps.autonomy?.remoteWanted(id, enabled)
    await session.setRemote(enabled, title)
  })

  ipcMain.handle(CHANNELS.agentCommands, async (_e, id: unknown) => {
    if (!isString(id)) return []
    return (await manager.get(id)?.commands()) ?? []
  })

  // The ribbon a tab already has, with its revision — what a window needs in
  // order to draw a tab without replaying the whole session. The revision
  // tells the window which events still in flight the snapshot already holds.
  ipcMain.handle(CHANNELS.agentRibbon, (_e, id: unknown): Promise<RibbonSnapshot> =>
    withFault(CHANNELS.agentRibbon, () => {
      if (!isString(id)) return { rev: 0, items: [], todo: null }
      return controller.ribbonOf(id)
    })
  )

  // What the panel holds right now, answered at once — a reloaded window or
  // a missed event must not leave the panel empty. Live MCP state is asked
  // for meanwhile and arrives as an ordinary event.
  ipcMain.handle(CHANNELS.agentPanel, (_e, id: unknown): PanelSnapshot => {
    if (!isString(id)) return { rev: 0, data: EMPTY_PANEL }
    void manager.get(id)?.refreshMcp().catch(() => undefined)
    return controller.panelOf(id)
  })

  // The session answers only for a task it lists itself, so a made-up id
  // never reaches the agent.
  ipcMain.handle(CHANNELS.agentTaskOutput, async (_e, id: unknown, taskId: unknown) => {
    if (!isString(id) || !isString(taskId) || taskId === '') return null
    return (await manager.get(id)?.taskOutput(taskId)) ?? null
  })

  ipcMain.handle(CHANNELS.agentTaskStop, async (_e, id: unknown, taskId: unknown) => {
    if (!isString(id) || !isString(taskId) || taskId === '') return
    await manager.get(id)?.stopTask(taskId)
  })

  // — этап 4: сабагенты. The window names only a card of the ribbon and
  // the text; the session finds the agent behind the card in its own ribbon,
  // so a made-up id never reaches the agent.
  ipcMain.handle(
    CHANNELS.agentSubagentSend,
    async (_e, id: unknown, cardId: unknown, text: unknown): Promise<SubagentSendResult> => {
      const card = sanitizeCardId(cardId)
      const body = sanitizeSubagentText(text)
      if (!isString(id) || card === null || body === null) return { ok: false, reason: 'empty' }
      const session = manager.get(id)
      if (!session) return { ok: false, reason: 'not-running' }
      return session.sendToSubagent(card, body)
    }
  )

  ipcMain.handle(
    CHANNELS.agentSubagentStop,
    async (_e, id: unknown, cardId: unknown): Promise<SubagentStopResult> => {
      const card = sanitizeCardId(cardId)
      if (!isString(id) || card === null) return 'not-running'
      return (await manager.get(id)?.stopSubagent(card)) ?? 'not-running'
    }
  )

  // Claude Code itself, in a console in the tab's folder: for the commands
  // that exist only in the terminal. The folder is the tab's, never the window's.
  ipcMain.handle(CHANNELS.agentOpenTerminal, (_e, id: unknown) => {
    if (!isString(id)) return
    const tab = controller.list().find((t) => t.id === id)
    if (!tab || tab.missingCwd) return
    deps.openTerminal(tab.cwd)
  })

  ipcMain.handle(CHANNELS.permissionAnswer, (_e, requestId: unknown, answer: unknown) => {
    if (!isString(requestId)) return
    broker.answer(requestId, sanitizeAnswer(answer))
  })

  // The fourth argument is the comments on the chosen options; which of them
  // belong to a chosen option is the session's call, which knows the options.
  ipcMain.handle(
    CHANNELS.questionAnswer,
    (_e, id: unknown, toolUseId: unknown, answers: unknown, notes: unknown) => {
      if (!isString(id) || !isString(toolUseId)) return
      const clean = sanitizeQuestionAnswers(answers)
      // Nothing usable is no answer: the card stays open rather than sending an empty one.
      if (Object.keys(clean).length === 0) return
      manager.get(id)?.answerQuestion(toolUseId, clean, sanitizeQuestionNotes(notes))
    }
  )

  // Anything but a literal true is not an approval, and an unusable decision
  // is no answer: the card stays open.
  ipcMain.handle(CHANNELS.planAnswer, (_e, id: unknown, requestId: unknown, given: unknown) => {
    if (!isString(id) || !isString(requestId)) return
    const decision = sanitizePlanDecision(given)
    if (decision === null) return
    return manager.get(id)?.answerPlan(requestId, decision)
  })

  // — этап 2: проекты и раскладка.
  const { layout } = deps

  /**
   * The folder a project request may act on, as main knows it: a project's
   * first spelling (П13), or the folder of an open chat. Anything else — a
   * folder the window made up — is null. A folder on another machine
   * (`hostId`) is none until этап 6 can reach it.
   */
  const knownFolder = (cwd: unknown, hostId: unknown): string | null => {
    if (!isString(cwd) || cwd === '') return null
    if (hostId !== undefined && hostId !== '') {
      // Stage 6: a folder on a server — a project of that server, or one of its open chats.
      if (!isString(hostId) || hostId.length > 200 || !deps.knownServer?.(hostId)) return null
      const remoteKey = projectKey(cwd, hostId)
      const remote = layout.get().projects.find((p) => p.hostId === hostId && projectKey(p.cwd, hostId) === remoteKey)
      if (remote) return remote.cwd
      return (
        controller.list().find((tab) => tab.server?.hostId === hostId && projectKey(tab.cwd, hostId) === remoteKey)?.cwd ??
        null
      )
    }
    const key = projectKey(cwd)
    const project = layout.get().projects.find((p) => !p.hostId && projectKey(p.cwd) === key)
    if (project) return project.cwd
    return controller.list().find((tab) => projectKey(tab.cwd) === key)?.cwd ?? null
  }

  ipcMain.handle(CHANNELS.layoutGet, (): LayoutState => layout.get())

  // One patch, one write, one layoutChanged: the panes (live chats only, as
  // setPanes keeps them) and the widths for their new count together. setPanes
  // then finds them in place and only starts the agents.
  ipcMain.handle(CHANNELS.layoutSet, async (_e, given: unknown): Promise<LayoutState> => {
    const patch = sanitizeLayoutPatch(given)
    if (patch.panes) {
      const live = new Set(controller.list().map((tab) => tab.id))
      patch.panes = patch.panes.filter((id) => live.has(id))
    }
    layout.patch(patch)
    if (patch.panes) await controller.setPanes(patch.panes)
    return layout.get()
  })

  // A project with open chats stays: nothing changes.
  ipcMain.handle(CHANNELS.projectForget, (_e, cwd: unknown, hostId: unknown): LayoutState => {
    if (!isString(cwd) || cwd === '' || (hostId !== undefined && !isString(hostId))) return layout.get()
    const open = controller.list().map((tab) => projectKey(tab.cwd, tab.server?.hostId))
    layout.forgetProject(cwd, open, hostId === '' ? undefined : hostId)
    return layout.get()
  })

  ipcMain.handle(
    CHANNELS.projectHistory,
    (_e, cwd: unknown, hostId: unknown): Promise<SessionSummary[]> =>
      // e2e sees the sidebar's «Загружаю…» and «Не удалось прочитать историю» through this.
      withFault(CHANNELS.projectHistory, async () => {
        const folder = knownFolder(cwd, hostId)
        if (folder === null) return []
        // A server project's history is its relay's (сверка F21).
        if (isString(hostId) && hostId !== '') return deps.serverHistory ? deps.serverHistory(folder, hostId) : []
        return deps.history.list(folder)
      })
  )

  ipcMain.handle(
    CHANNELS.projectOpenSession,
    (_e, cwd: unknown, sessionId: unknown, title: unknown, hostId: unknown): TabState | null => {
      if (!isString(sessionId) || sessionId === '') return null
      const folder = knownFolder(cwd, hostId)
      if (folder === null) return null
      const host = isString(hostId) && hostId !== '' ? hostId : undefined
      return controller.openSession(folder, sessionId, isString(title) ? title : undefined, host)
    }
  )


  // The timer of a question or plan card: stop it, or answer now. Only a known
  // tab and short strings reach the host.
  const autonomyCall = (id: unknown, cardId: unknown, run: (id: TabId, cardId: string) => void | undefined): void => {
    if (!isString(id) || !isString(cardId) || id.length > 200 || cardId.length > 200) return
    if (!controller.list().some((tab) => tab.id === id)) return
    run(id, cardId)
  }
  // Stage 6 (сверка F5): a server chat's core is its relay's — the card's action goes there.
  const serverAct = (id: TabId, cardId: string, action: 'hold' | 'answerNow'): boolean => {
    const session = manager.get(id)
    if (!session?.hostsAutonomy) return false
    session.autonomyAct(cardId, action).catch(() => undefined)
    return true
  }
  ipcMain.handle(CHANNELS.autonomyHold, (_e, id: unknown, cardId: unknown): void =>
    autonomyCall(id, cardId, (t, c) => (serverAct(t, c, 'hold') ? undefined : deps.autonomy?.hold(t, c)))
  )
  ipcMain.handle(CHANNELS.autonomyAnswerNow, (_e, id: unknown, cardId: unknown): void =>
    autonomyCall(id, cardId, (t, c) => (serverAct(t, c, 'answerNow') ? undefined : deps.autonomy?.answerNow(t, c)))
  )

  ipcMain.handle(CHANNELS.permissionRules, () => withFault(CHANNELS.permissionRules, () => broker.rules()))

  ipcMain.handle(CHANNELS.permissionRuleDelete, (_e, ruleId: unknown) => {
    if (isString(ruleId)) broker.deleteRule(ruleId)
  })

  ipcMain.handle(CHANNELS.historyList, (_e, id: unknown) =>
    withFault(CHANNELS.historyList, async () => {
      if (!isString(id)) return []
      return controller.history(id)
    })
  )

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
    // A server chat's files are the server's: fs.index of its folder (stage 6).
    if (tab.server) {
      const { hostId } = tab.server
      return remoteIndex.files(() => serverClient(hostId), id, tab.cwd, FILE_INDEX_LIMIT).catch(() => [])
    }
    return buildFileIndex(tab.cwd)
  })

  // Stage 6: a file attached in a server chat goes to the server at once; the
  // message carries its path there. Images still go as base64 (decision 8).
  ipcMain.handle(CHANNELS.filesUploadRemote, async (_e, id: unknown, localPath: unknown) => {
    if (!isString(id) || !isString(localPath) || localPath === '' || localPath.length > 4096) {
      return { error: uploadFailedText('неверный запрос') }
    }
    const tab = controller.list().find((t) => t.id === id)
    if (!tab?.server) return { error: uploadFailedText('это не чат на сервере') }
    const s = tab.server.relaySessionId
    if (!s) return { error: uploadFailedText('чат на сервере ещё не открыт') }
    try {
      const remotePath = await uploadFile(await serverClient(tab.server.hostId), s, localPath)
      return { remotePath }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      return { error: why === UPLOAD_TOO_LARGE_TEXT ? why : uploadFailedText(why) }
    }
  })

  // Which of the paths in a tab's text exist, relative to the tab's folder.
  // Anything that is not a short string answers null in its place.
  ipcMain.handle(CHANNELS.filesResolve, async (_e, id: unknown, given: unknown) => {
    if (!isString(id) || !Array.isArray(given)) return []
    // The resolver answers this many per call; the window asks in batches of it.
    const raws = given.slice(0, MAX_PER_CALL)
    const tab = controller.list().find((t) => t.id === id)
    if (!tab) return raws.map(() => null)
    const valid = raws.map((r) => isString(r) && r !== '' && r.length <= MAX_RAW_LENGTH)
    const asked = raws.filter((_r, i) => valid[i]) as string[]
    // A server chat's paths are the server's: one fs.stat through its relay (stage 6).
    const answers = tab.server
      ? await viewer.resolveRemote(id, tab.cwd, tab.server.hostId, asked)
      : await deps.resolver.resolve(tab.cwd, asked, id)
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

  // Open and show also take one of the app's own pasted images (a thumbnail
  // in the chat): never found in any tab's text, but written by main itself.
  // Only a file directly in userData/pastes under our own name passes (C10),
  // and what is acted on is its path on disk, not the text the window sent.
  const showable = (id: unknown, absPath: unknown): string | null => {
    if (mayAct(id, absPath)) return absPath
    if (!isString(id) || !isString(absPath) || !controller.list().some((t) => t.id === id)) return null
    return pasteRealPath(deps.userData, absPath)
  }

  ipcMain.handle(CHANNELS.filesOpen, async (_e, id: unknown, absPath: unknown) => {
    const target = showable(id, absPath)
    if (target === null) return null
    return openPath(target)
  })

  ipcMain.handle(CHANNELS.filesReveal, (_e, id: unknown, absPath: unknown) => {
    const target = showable(id, absPath)
    if (target === null) return
    revealPath(target)
  })

  // A pasted image, bounded to what the API takes, with a thumbnail and a copy
  // in userData/pastes.
  ipcMain.handle(CHANNELS.filesPrepareImage, async (_e, dataBase64: unknown, mediaType: unknown) => {
    if (!isString(dataBase64) || !isString(mediaType) || dataBase64 === '') {
      return { error: 'Не похоже на картинку' }
    }
    if (dataBase64.length > MAX_PASTE_BASE64) return { error: 'Картинка слишком большая' }
    // e2e slows or fails the preparation to reach what waits on it. A release
    // build has no such branch (buildFlags.d.ts).
    if (__QCLOD_TEST_SEAMS__) {
      const delay = Number(process.env['QCLOD_PREPARE_DELAY_MS'] ?? 0)
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (process.env['QCLOD_PREPARE_FAIL']) return { error: 'Не похоже на картинку' }
    }
    try {
      return prepareImage(deps.userData, dataBase64, mediaType)
    } catch {
      return { error: 'Не получилось прочитать картинку' }
    }
  })

  // Stage 6: the read-only viewer, here or on the tab's server.
  ipcMain.handle(CHANNELS.viewerRead, (_e, source: unknown, id: unknown, path: unknown) => viewer.read(source, id, path))
  ipcMain.handle(CHANNELS.viewerDownloadOpen, (_e, id: unknown, path: unknown) => viewer.downloadOpen(id, path))

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
