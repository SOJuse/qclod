import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ShieldAlert, TriangleAlert } from 'lucide-react'
import type { CostRates, FileSource, RibbonItem, SessionSummary, SubagentItem, TabId, UserInput } from '../../shared/types'
import type { VoiceControls } from '../../shared/voice'
import { useVoiceControls } from '../voice/voiceStore'
import { isWindows } from '../voice/platform'
import { KEY_CHANGED_STRIP_TEXT, OFFLINE_STRIP_TEXT, SERVER_REMOVED_TEXT } from '../../shared/serverTexts'
import { ServerLoginDialog } from './servers/ServerLoginDialog'
import { FileViewer } from './viewer/FileViewer'
import { TerminalDrawer } from './terminal/TerminalDrawer'
import { EMPTY_PANEL, useAppStore, type PaneLayerState } from '../state/useAppStore'
import { useHeldDrafts } from '../state/heldDrafts'
import { compactNow, sendCommand } from '../input/slash'
import { REMOTE_BLOCK_TEXT, REMOTE_OFF, isRemoteLive } from '../../shared/remote'
import {
  draftWithReturned,
  needsUpload,
  pendingFromSent,
  prepareAttachment,
  prepareRemoteFile,
  type PendingFile,
  type PendingImage
} from '../input/attachments'
import { Ribbon } from './Ribbon'
import { Composer } from './Composer'
import { NowLine } from './NowLine'
import { TodoStrip } from './TodoStrip'
import { QueueStrip } from './QueueStrip'
import { StatusLine } from './StatusLine'
import { ContextBanner } from './ContextBanner'
import { EmptyTab } from './EmptyTab'
import { PinnedCards } from './cards/PinnedCards'
import { AutoAnswerGuard } from './cards/AutoAnswerGuard'
import { cardAnswers } from '../chat/cardAnswers'
import { cardIdOf } from '../chat/openCards'
import { autoAnswerTimer, toAutoAnswerView } from '../chat/autoAnswer'
import { StateView } from '../ui/StateView'
import { nextOverride, panelMode, panelToggle, type PanelOverride } from '../app/panelVisibility'
import { restartChat } from '../app/restartChat'
import { ChatHeader } from './ChatHeader'
import { PaneLayer } from './PaneLayer'
import { AgentsLayer } from './agents/AgentsLayer'
import { AgentComposer, SEND_REFUSAL, agentPlaceholder } from './agents/AgentComposer'
import { useTemplates } from '../state/useTemplates'
import { GitLayer, gitTitle } from './git/GitLayer'
import { useGitStatus } from './git/useGitStatus'
import { SidePanel } from './SidePanel'
import './ChatPane.css'

const NO_ITEMS: RibbonItem[] = []

/** Ctrl+\ for the pane it acts on: that pane's panel button, pressed from the keyboard. */
export interface PanelRequest {
  tabId: string
  /** Grows with every request: a pane acts on a number it has not seen. */
  n: number
}

/**
 * What a layer over the ribbon shows, by kind — one line per stage. A kind
 * with nothing to show draws no layer.
 */
function paneLayerView(
  layer: PaneLayerState,
  pane: { tabId: string; items: RibbonItem[]; costRates: CostRates | null },
  ctx: { tabId: TabId; source: FileSource; cwd: string; git: ReturnType<typeof useGitStatus>; close: () => void }
): { title: string; body: ReactNode } | null {
  switch (layer.kind) {
    case 'agents': // этап 4: the pane's subagents, layer.agentId opened
      return {
        title: 'Агенты этого чата',
        body: <AgentsLayer {...pane} {...(layer.agentId !== undefined ? { agentId: layer.agentId } : {})} />
      }
    case 'file': // этап 6: layer.path at layer.line, here or on the chat's server
      if (!layer.path) return null
      return {
        title: layer.path.split(/[\\/]/).pop() || layer.path,
        body: (
          <FileViewer tabId={ctx.tabId} source={ctx.source} path={layer.path} line={layer.line} onClose={ctx.close} />
        )
      }
    case 'git': // этап 7: the folder's changes
      return {
        title: gitTitle(ctx.git.status),
        body: (
          <GitLayer
            tabId={ctx.tabId}
            source={ctx.source}
            cwd={ctx.cwd}
            status={ctx.git.status}
            refresh={ctx.git.refresh}
            refreshNow={ctx.git.refreshNow}
          />
        )
      }
  }
}

interface Props {
  tabId: string
  /** The pane the keyboard and the side panel belong to. */
  focused: boolean
  focusToken: number
  title: string
  /** Two panes or more: the header then names the chat, and the pane can leave the row. */
  split: boolean
  /** Takes this chat out of the split. */
  onUnsplit?: () => void
  onFocus: () => void
  onOpenHistory: () => void
  onCycleMode: () => void
  /** A past conversation picked on the empty tab opens in a tab of its own. */
  onOpenSession: (fromTabId: string, session: SessionSummary) => void
  /** A warning to show above the input, such as the close-tab guard. */
  notice?: { testId: string; text: string } | null
  /** The window's last Ctrl+\; only the pane it names acts on it. */
  panelRequest?: PanelRequest | null
  /** Why the tab's ribbon could not be read; `onRetryRibbon` asks again. */
  ribbonError?: string | null
  onRetryRibbon?: () => void
  /** Этап 5's voice input, the same for the chat's input and a subagent's (сверка F12). */
  voice?: VoiceControls
  /** Ctrl+K's palette, for the server terminal's Ctrl+Shift+K (R10). */
  onOpenPalette?: () => void
  /** A server's checklist in the servers' sheet — for a changed host key (R5). */
  onOpenServerChecklist?: (hostId: string) => void
}

/**
 * One conversation: its ribbon and its input line.
 *
 * Pulled out of App so two of them can sit side by side. Everything a
 * conversation owns — ribbon, draft, attachments, file index — was already
 * keyed by tab, so a second pane is a second tab id and nothing else.
 */
export function ChatPane({
  tabId,
  focused,
  focusToken,
  title,
  split,
  onUnsplit,
  onFocus,
  onOpenHistory,
  onCycleMode,
  onOpenSession,
  notice,
  panelRequest = null,
  ribbonError = null,
  onRetryRibbon,
  voice: voiceOverride,
  onOpenPalette,
  onOpenServerChecklist
}: Props): JSX.Element {
  // One voice for the pane: the chat's input and a subagent's get the same (сверка F12).
  // Voice is Windows-only in 1.0 (G11): elsewhere the button stays as этап 2 left it.
  const paneVoice = useVoiceControls(tabId)
  const voice = voiceOverride ?? (isWindows() ? paneVoice : undefined)
  const tabs = useAppStore((s) => s.tabs)
  const ribbonByTab = useAppStore((s) => s.ribbonByTab)
  const todoByTab = useAppStore((s) => s.todoByTab)
  const draftByTab = useAppStore((s) => s.draftByTab)
  const attachmentsByTab = useAppStore((s) => s.attachmentsByTab)
  const fileIndexByTab = useAppStore((s) => s.fileIndexByTab)
  const setDraft = useAppStore((s) => s.setDraft)
  const setAttachments = useAppStore((s) => s.setAttachments)
  const commands = useAppStore((s) => s.commandsByTab[tabId])
  const recentCommands = useAppStore((s) => s.recentCommands)
  const templates = useTemplates()
  const insertRequest = useAppStore((s) => (s.composerInsert?.tabId === tabId ? s.composerInsert : null))
  const panel = useAppStore((s) => s.panelByTab[tabId]) ?? EMPTY_PANEL
  const terminalShown = useAppStore((s) => s.terminalShownByTab[tabId])

  const busySinceByTab = useAppStore((s) => s.busySinceByTab)
  // A tab with history is not empty just because its ribbon has not arrived yet.
  const ribbonLoaded = useAppStore((s) => s.ribbonRevByTab[tabId] !== undefined)
  const tab = tabs.find((t) => t.id === tabId)
  // Stage 6: the server this chat runs on, as main last said.
  const servers = useAppStore((s) => s.servers)
  const server = tab?.server ? servers.find((s) => s.id === tab.server!.hostId) : undefined
  const serverAway = server !== undefined && server.state !== 'online' && server.state !== 'connecting'
  /** A changed host key is a danger of its own (R5): the strip says what main said, in red. */
  const keyChanged = server?.state === 'hostKeyChanged'
  /** The chat's server is no longer in the list (R9): only once the list has come at all. */
  const serversLoaded = useAppStore((s) => s.serversLoaded)
  const serverGone = tab?.server !== undefined && server === undefined && serversLoaded
  /** Stage 6: «Войти» of the server's Claude account. */
  const [loginOpen, setLoginOpen] = useState(false)
  const status = tab?.status ?? 'stopped'
  const remote = tab?.remote ?? REMOTE_OFF
  const draft = draftByTab[tabId] ?? ''
  const heldDraft = useHeldDrafts((s) => s.byTab[tabId] !== undefined)

  /** The draft held back after the window froze goes into the field, before what is typed since. */
  function insertHeldDraft(): void {
    const text = useHeldDrafts.getState().take(tabId)
    if (text === undefined) return
    setDraft(tabId, draftWithReturned([text], useAppStore.getState().draftByTab[tabId] ?? ''))
  }

  // ------------------------------------------------ the pane's own right-hand panel (E5)

  /**
   * The pane's width decides how its panel shows (panelVisibility.ts). A
   * choice made with the button is this pane's alone (S2-R23: each half of a
   * split keeps its own), kept by tab in memory until the pane crosses the
   * threshold; only a lone wide pane writes the saved setting.
   */
  const paneRef = useRef<HTMLElement | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const widthRef = useRef(0)
  const override = useAppStore((s) => s.panelChoiceByTab[tabId] ?? null)
  const setOverride = useCallback(
    (choice: PanelOverride): void => useAppStore.getState().setPanelChoice(tabId, choice),
    [tabId]
  )
  useLayoutEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = (): void => {
      const before = widthRef.current
      const after = el.getBoundingClientRect().width
      if (after === before) return
      widthRef.current = after
      // The first measure is not a change of shape.
      if (before > 0) setOverride(nextOverride(useAppStore.getState().panelChoiceByTab[tabId] ?? null, before, after))
      setPaneWidth(after)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tabId, setOverride])
  const setting = useAppStore((s) => s.settings?.panelOpen === true)
  const mode = panelMode({ setting, paneWidth, override })
  const shown = mode !== 'hidden'

  /** Opened, the panel shows the whole snapshot, not only what events brought meanwhile. */
  const refreshPanel = useCallback((): void => {
    void window.qclod
      .panel(tabId)
      .then((snapshot) => useAppStore.getState().setPanelSnapshot(tabId, snapshot))
      .catch(() => undefined)
  }, [tabId])

  /**
   * The panel button (and Ctrl+\ for the active pane): this pane only. A lone
   * wide pane also saves it as the default for panes to come (panelToggle).
   */
  const togglePanel = useCallback((): void => {
    const next = panelToggle({ shown, paneWidth: widthRef.current, split })
    setOverride(next.override)
    if (next.saveSetting !== undefined) {
      void window.qclod
        .setSettings({ panelOpen: next.saveSetting })
        .then((saved) => useAppStore.getState().setSettings(saved))
        .catch(() => undefined)
    }
    if (!shown) refreshPanel()
  }, [shown, split, setOverride, refreshPanel])
  /** A drawer closed by Esc or a press past it; the pane is narrow, so it simply folds. */
  const closeDrawer = useCallback((): void => setOverride(null), [setOverride])

  const handledRequest = useRef(panelRequest?.n ?? 0)
  useEffect(() => {
    if (!panelRequest || panelRequest.tabId !== tabId || panelRequest.n === handledRequest.current) return
    handledRequest.current = panelRequest.n
    togglePanel()
  }, [panelRequest, tabId, togglePanel])

  /** The status-line switch and /remote-control: on shows the panel, where the link is. */
  function toggleRemote(): void {
    if (remote.blocked) return
    const enable = !isRemoteLive(remote)
    void window.qclod.setRemote(tabId, enable)
    // Out in this pane only, and not saved: the link and the QR are wanted now, here.
    if (enable && !shown) {
      setOverride('open')
      refreshPanel()
    }
  }

  // ------------------------------------------------ the floating input

  /** The ribbon and a layer keep room under their last line for the dock, by its real height. */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const body = bodyRef.current
    const dock = dockRef.current
    if (!body || !dock) return
    let last = ''
    const measure = (): void => {
      // From the dock's top to the body's bottom: its height and the gap under it.
      // Measured from the boxes and rounded up, not from offsetTop: that one rounds
      // a fractional top to 597 or 598 by turns, and every turn moved the ribbon's
      // foot by a pixel, which moved it again — the ribbon never stood still.
      const room = Math.ceil(body.getBoundingClientRect().bottom - dock.getBoundingClientRect().top)
      const value = `${Math.max(0, room)}px`
      if (value === last) return
      last = value
      body.style.setProperty('--dock-h', value)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  const items = ribbonByTab[tabId]
  const layer = useAppStore((s) => s.layerByTab[tabId] ?? null)
  const layerSource: FileSource = tab?.server ? { kind: 'remote', hostId: tab.server.hostId } : { kind: 'local' }
  const git = useGitStatus(tabId)
  const layerView = layer
    ? paneLayerView(
        layer,
        { tabId, items: items ?? NO_ITEMS, costRates: panel.costRates },
        {
          tabId,
          source: layerSource,
          cwd: tab?.cwd ?? '',
          git,
          close: () => useAppStore.getState().setPaneLayer(tabId, null)
        }
      )
    : null
  const gitState =
    git.status?.kind === 'notRepo' || git.status?.kind === 'noGit' || git.status?.kind === 'unavailable'
      ? git.status.kind
      : 'ok'


  /** A subagent's own ribbon open over this pane: its input stands where the chat's does (решение 1). */
  const agentCard = useMemo(() => {
    const id = layer?.kind === 'agents' ? layer.agentId : undefined
    return id === undefined ? undefined : (items ?? NO_ITEMS).find((i): i is SubagentItem => i.kind === 'subagent' && i.id === id)
  }, [layer, items])
  /** «Агенты (3)»: the subagents working now. */
  const agentsCount = useMemo(
    () => (items ?? NO_ITEMS).reduce((n, item) => (item.kind === 'subagent' && item.state === 'running' ? n + 1 : n), 0),
    [items]
  )
  const answers = useMemo(() => cardAnswers(tabId), [tabId])
  const sentTexts = useMemo(
    () => (items ?? []).flatMap((item) => (item.kind === 'user' ? [item.text] : [])),
    [items]
  )

  /** main finished preparing an image: its chip becomes the thumbnail, or the error. */
  function applyPrepared(file: File, patch: Pick<PendingImage, 'prepared' | 'error'>): void {
    setAttachments(
      tabId,
      (useAppStore.getState().attachmentsByTab[tabId] ?? []).map((item) =>
        item.kind === 'image' && item.file === file ? { ...item, ...patch } : item
      )
    )
  }

  // Stage 6: a server chat's file goes to the server the moment it is attached —
  // dropped, pasted or picked. The chip says «загружаю на сервер…», a send waits
  // for it (isPreparing), and the message carries the server's path.
  const isServerChat = tab?.server !== undefined
  const tabAttachments = attachmentsByTab[tabId]
  useEffect(() => {
    if (!isServerChat || !tabAttachments) return
    const fresh = tabAttachments.filter(needsUpload)
    if (fresh.length === 0) return
    setAttachments(
      tabId,
      tabAttachments.map((item) => (fresh.includes(item as PendingFile) ? { ...item, uploading: true as const } : item))
    )
    for (const item of fresh) {
      void prepareRemoteFile(item, (path) => window.qclod.uploadRemoteFile(tabId, path)).then((done) => {
        setAttachments(
          tabId,
          (useAppStore.getState().attachmentsByTab[tabId] ?? []).map((chip) =>
            chip.kind === 'file' && chip.path === item.path && chip.uploading ? done : chip
          )
        )
      })
    }
  }, [isServerChat, tabAttachments, tabId, setAttachments])

  /**
   * «Стоп» handed the queue back: its texts go into the field before what is
   * already typed, its attachments back as chips — nothing the user wrote is
   * lost by stopping.
   */
  function takeBack(returned: UserInput[]): void {
    if (returned.length === 0) return
    const state = useAppStore.getState()
    setDraft(tabId, draftWithReturned(returned.map((r) => r.text), state.draftByTab[tabId] ?? ''))
    // A server chat's file came back with its server path: it is there already, not uploaded again.
    const chips = returned.flatMap((r) =>
      r.attachments.map((a) =>
        a.kind === 'file' && tab?.server ? { kind: 'file' as const, path: a.path, remotePath: a.path } : pendingFromSent(a)
      )
    )
    setAttachments(tabId, [...chips, ...(state.attachmentsByTab[tabId] ?? [])])
    // An image that came back without main's copy is prepared again.
    for (const chip of chips) {
      if (chip.kind !== 'image' || !chip.file || chip.prepared || chip.error) continue
      const file = chip.file
      void prepareAttachment(chip, window.qclod.prepareImage).then((patch) => applyPrepared(file, patch))
    }
  }

  // The session's commands are asked for the first time a slash is typed in
  // this tab; after that the main process pushes every change. A session that
  // has not started yet answers with nothing, so that answer is not kept and
  // the next keystroke asks again — Qclod's own commands show meanwhile.
  const asking = useRef(new Set<string>())
  const wantsCommands = draft.startsWith('/') && commands === undefined
  useEffect(() => {
    if (!wantsCommands || asking.current.has(tabId)) return
    asking.current.add(tabId)
    void window.qclod
      .commands(tabId)
      .then((list) => {
        if (list.length > 0) useAppStore.getState().setCommands(tabId, list)
      })
      .finally(() => asking.current.delete(tabId))
  }, [wantsCommands, tabId, draft])

  return (
    <section
      ref={paneRef}
      className={`chat-pane${focused ? ' is-focused' : ''}`}
      data-testid="chat-pane"
      data-tab={tabId}
      data-panel={mode}
      onMouseDown={onFocus}
    >
      <div className="chat-main">
        <ChatHeader
          title={title}
          cwd={tab?.cwd ?? ''}
          status={status}
          split={split}
          panelShown={shown}
          onTogglePanel={togglePanel}
          {...(split && onUnsplit ? { onUnsplit } : {})}
          onOpenAgents={() => useAppStore.getState().openAgents(tabId)}
          agentsCount={agentsCount}
          server={server}
          {...(server ? { onReconnect: () => void window.qclod.connectServer(server.id).catch(() => undefined) } : {})}
          {...(server && onOpenServerChecklist ? { onShowChecklist: () => onOpenServerChecklist(server.id) } : {})}
          serverGone={serverGone}
          {...(server
            ? {
                onToggleTerminal: () => useAppStore.getState().setTerminalShown(tabId, terminalShown !== true),
                terminalOpen: terminalShown === true
              }
            : {})}
          onOpenGit={() => useAppStore.getState().setPaneLayer(tabId, { kind: 'git' })}
          gitBadge={git.status?.kind === 'ok' ? git.status.changes.length : null}
          gitState={gitState}
          {...(git.status?.kind === 'unavailable' ? { gitHint: git.status.reason } : {})}
        />

        <div className="chat-body" ref={bodyRef}>
          <Ribbon
            key={tabId}
            items={ribbonByTab[tabId] ?? []}
            cwd={tab?.cwd ?? ''}
            tabId={tabId}
            whenEmpty={
              !tab ? null : ribbonError !== null ? (
                <div className="ribbon-state">
                  <StateView
                    kind="error"
                    title="Не удалось загрузить разговор"
                    hint={ribbonError}
                    {...(onRetryRibbon ? { action: { label: 'Повторить', onClick: onRetryRibbon } } : {})}
                  />
                </div>
              ) : ribbonLoaded ? (
                <EmptyTab tabId={tabId} cwd={tab.cwd} onOpenSession={(s) => onOpenSession(tabId, s)} />
              ) : (
                <div className="ribbon-state">
                  <StateView kind="loading" title="Загружаю разговор…" />
                </div>
              )
            }
            answers={answers}
          />

          {layer && layerView && (
            <PaneLayer title={layerView.title} onClose={() => useAppStore.getState().setPaneLayer(tabId, null)}>
              {layerView.body}
            </PaneLayer>
          )}

          {/* The input floats over the ribbon's foot, centred in its column (D9); the cards (PinnedCards) sit above it here. */}
          <div className="composer-dock" data-testid="composer-dock" ref={dockRef}>
            <TodoStrip items={todoByTab[tabId] ?? []} status={status} />

            <NowLine tabId={tabId} status={status} since={busySinceByTab[tabId]} items={ribbonByTab[tabId] ?? []} />

            {serverGone ? (
              <div className="server-offline-strip is-danger" data-testid="server-removed" role="alert">
                <TriangleAlert size={14} aria-hidden="true" />
                <span>{SERVER_REMOVED_TEXT}</span>
              </div>
            ) : keyChanged ? (
              <div className="server-offline-strip is-danger" data-testid="server-key-changed" role="alert">
                <ShieldAlert size={14} aria-hidden="true" />
                <span>{server?.problem || KEY_CHANGED_STRIP_TEXT}</span>
              </div>
            ) : (
              serverAway && (
                <div className="server-offline-strip" data-testid="server-offline" role="status">
                  {OFFLINE_STRIP_TEXT}
                </div>
              )
            )}

            {notice && (
              <div className="close-guard" data-testid={notice.testId} role="status">
                <TriangleAlert size={14} aria-hidden="true" />
                {notice.text}
              </div>
            )}

            {panel.context && (
              <ContextBanner
                percent={panel.context.percent}
                disabled={status === 'busy' || status === 'waiting'}
                onCompact={() => compactNow(tabId)}
              />
            )}

            {/* The cards and the queue can grow: they scroll inside the dock, so the input and the status line always show. */}
            <div className="composer-dock-scroll" data-testid="composer-dock-scroll">
              <PinnedCards
                tabId={tabId}
                items={ribbonByTab[tabId] ?? []}
                answers={answers}
                // «Авто-да» counting down on the card (decision 2: the panel carries it); main runs the timer.
                autoAnswerFor={(c) => toAutoAnswerView(autoAnswerTimer(panel.autonomy, cardIdOf(c)), tabId)}
                guard={(c, children) => (
                  <AutoAnswerGuard
                    active={!!autoAnswerTimer(panel.autonomy, cardIdOf(c))}
                    // A refused call leaves the timer as it is.
                    onStop={() => void window.qclod.autonomyHold(tabId, cardIdOf(c)).catch(() => undefined)}
                  >
                    {children}
                  </AutoAnswerGuard>
                )}
              />

              <QueueStrip
                queue={panel.queue ?? []}
                // A refused or failed call changes nothing: the strip follows main's queue, not the answer.
                onSendNow={(id) => void window.qclod.sendQueuedNow(tabId, id).catch(() => undefined)}
                onCancel={(id) => void window.qclod.cancelQueued(tabId, id).catch(() => undefined)}
                onEdit={(id) =>
                  void window.qclod
                    .cancelQueued(tabId, id)
                    .then((input) => {
                      // null: it already reached the agent, or is gone — nothing to take back.
                      if (input) takeBack([input])
                    })
                    .catch(() => undefined)
                }
              />
            </div>

            {agentCard ? (
              <AgentComposer
                key={agentCard.id}
                tabId={tabId}
                cardId={agentCard.id}
                disabledReason={status === 'stopped' ? SEND_REFUSAL['not-running'] : null}
                placeholder={agentPlaceholder(agentCard.state)}
                voice={voice}
              />
            ) : (
            <Composer
              voice={voice}
              tabId={tabId}
              status={status}
              draft={draft}
              sentTexts={sentTexts}
              attachments={attachmentsByTab[tabId] ?? []}
              fileIndex={fileIndexByTab[tabId] ?? []}
              started={status !== 'stopped'}
              commands={commands ?? []}
              recentCommands={recentCommands}
              templates={templates}
              insertRequest={insertRequest}
              models={panel.models}
              model={panel.model}
              effort={panel.effort}
              onSendCommand={(text) => sendCommand(tabId, text)}
              onCommandUsed={(name) => useAppStore.getState().noteCommand(name)}
              onOpenHistory={onOpenHistory}
              onToggleRemote={toggleRemote}
              remoteBlockedText={remote.blocked ? REMOTE_BLOCK_TEXT[remote.blocked] : null}
              onSetModel={(model) => void window.qclod.setModel(tabId, model)}
              onSetEffort={(level) => void window.qclod.setEffort(tabId, level)}
              focusToken={focusToken}
              autoFocus={focused}
              onDraftChange={(text) => setDraft(tabId, text)}
              onAttachmentsChange={(items) => setAttachments(tabId, items)}
              onSubmit={(text, attachments) => {
                // A tab with no live session takes nothing: the text and chips
                // come back to the input line rather than vanish.
                void window.qclod.send(tabId, { text, attachments }).then((taken) => {
                  if (!taken) takeBack([{ text, attachments }])
                })
              }}
              onInterrupt={() => void window.qclod.interrupt(tabId).then(takeBack)}
              onCycleMode={onCycleMode}
              // A new session, its own panel, and the project's history read again.
              onRestart={() => void restartChat(tabId)}
              canRetry={tab?.canRetry === true}
              onRetry={() => {
                // The same conversation again; the new session's panel replaces the
                // dead one's whole, as on restart.
                void window.qclod
                  .retryTab(tabId)
                  .then(() => window.qclod.panel(tabId))
                  .then((snapshot) => useAppStore.getState().setPanelSnapshot(tabId, snapshot))
              }}
              onImagePrepared={applyPrepared}
              heldDraft={heldDraft}
              onInsertHeldDraft={insertHeldDraft}
              blockedText={serverGone ? 'Сервер удалён' : null}
              onPickFiles={() => {
                void window.qclod.pickFiles().then((paths) => {
                  if (paths.length === 0) return
                  setAttachments(tabId, [
                    ...(useAppStore.getState().attachmentsByTab[tabId] ?? []),
                    ...paths.map((path) => ({ kind: 'file' as const, path }))
                  ])
                })
              }}
            />
            )}

            <StatusLine
              tabId={tabId}
              data={panel}
              started={status !== 'stopped'}
              remote={remote}
              onToggleRemote={toggleRemote}
            />
          </div>
        </div>

        {/* Stage 6: the server's terminal, once opened; hidden it keeps its session. */}
        {server && terminalShown !== undefined && (
          <TerminalDrawer
            tabId={tabId}
            label={server.label || server.target}
            shown={terminalShown}
            onHide={() => {
              useAppStore.getState().setTerminalShown(tabId, false)
              // R10: hidden, the keys go back to the input line.
              paneRef.current?.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus()
            }}
            {...(onOpenPalette ? { onOpenPalette } : {})}
          />
        )}
      </div>

      {mode !== 'hidden' && (
        <SidePanel
          data={panel}
          started={status !== 'stopped'}
          remote={remote}
          onRemote={(enabled) => void window.qclod.setRemote(tabId, enabled)}
          mode={mode}
          active={focused}
          onClose={closeDrawer}
          server={server}
          onServerLogin={() => setLoginOpen(true)}
        />
      )}
      {loginOpen && server && <ServerLoginDialog server={server} onClose={() => setLoginOpen(false)} />}
    </section>
  )
}
