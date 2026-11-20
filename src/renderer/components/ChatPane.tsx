import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { SessionSummary, UserInput } from '../../shared/types'
import { EMPTY_PANEL, useAppStore, type PaneLayerState } from '../state/useAppStore'
import { useHeldDrafts } from '../state/heldDrafts'
import { compactNow, sendCommand } from '../input/slash'
import { REMOTE_BLOCK_TEXT, REMOTE_OFF, isRemoteLive } from '../../shared/remote'
import {
  draftWithReturned,
  pendingFromSent,
  prepareAttachment,
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
import { cardAnswers } from '../chat/cardAnswers'
import { StateView } from '../ui/StateView'
import { PANE_PANEL_MIN_WIDTH, nextOverride, panelMode, type PanelOverride } from '../app/panelVisibility'
import { ChatHeader } from './ChatHeader'
import { PaneLayer } from './PaneLayer'
import { SidePanel } from './SidePanel'
import './ChatPane.css'

/** Ctrl+\ for the pane it acts on: that pane's panel button, pressed from the keyboard. */
export interface PanelRequest {
  tabId: string
  /** Grows with every request: a pane acts on a number it has not seen. */
  n: number
}

/**
 * What a layer over the ribbon shows, by kind — one line per stage. A kind
 * with nothing to show draws no layer: in этап 2 there is none yet.
 */
function paneLayerView(layer: PaneLayerState): { title: string; body: ReactNode } | null {
  switch (layer.kind) {
    case 'agents': // этап 4: the pane's subagents, layer.agentId opened
      return null
    case 'file': // этап 6: layer.path at layer.line
      return null
    case 'git': // этап 7: the folder's changes
      return null
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
  onRetryRibbon
}: Props): JSX.Element {
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
  const panel = useAppStore((s) => s.panelByTab[tabId]) ?? EMPTY_PANEL

  const busySinceByTab = useAppStore((s) => s.busySinceByTab)
  // A tab with history is not empty just because its ribbon has not arrived yet.
  const ribbonLoaded = useAppStore((s) => s.ribbonRevByTab[tabId] !== undefined)
  const tab = tabs.find((t) => t.id === tabId)
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
   * choice made with the button in a narrow pane is this pane's alone and
   * lasts until the pane crosses the threshold; it is never saved.
   */
  const paneRef = useRef<HTMLElement | null>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const widthRef = useRef(0)
  const [override, setOverride] = useState<PanelOverride>(null)
  useLayoutEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = (): void => {
      const before = widthRef.current
      const after = el.getBoundingClientRect().width
      if (after === before) return
      widthRef.current = after
      // The first measure is not a change of shape.
      if (before > 0) setOverride((was) => nextOverride(was, before, after))
      setPaneWidth(after)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const setting = useAppStore((s) => s.settings?.panelOpen === true)
  const mode = panelMode({ setting, paneWidth, override })
  const shown = mode !== 'hidden'

  /**
   * The panel button. In a wide pane it flips the saved setting; in a narrow
   * one, where the panel folds by itself, it slides it out or back for this
   * pane only.
   */
  const togglePanel = useCallback((): void => {
    if (widthRef.current < PANE_PANEL_MIN_WIDTH) {
      setOverride(shown ? 'closed' : 'open')
    } else {
      setOverride(null)
      void window.qclod.setSettings({ panelOpen: !shown }).then((next) => useAppStore.getState().setSettings(next))
    }
    // Opened, it shows the whole panel, not only what events brought meanwhile.
    if (!shown) {
      void window.qclod.panel(tabId).then((snapshot) => useAppStore.getState().setPanelSnapshot(tabId, snapshot))
    }
  }, [shown, tabId])
  /** A drawer closed by Esc or a press past it; the pane is narrow, so it simply folds. */
  const closeDrawer = useCallback((): void => setOverride(null), [])

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
    if (enable && !shown) togglePanel()
  }

  // ------------------------------------------------ the floating input

  /** The ribbon and a layer keep room under their last line for the dock, by its real height. */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const body = bodyRef.current
    const dock = dockRef.current
    if (!body || !dock) return
    const measure = (): void => {
      // From the dock's top to the body's bottom: its height and the gap under it.
      body.style.setProperty('--dock-h', `${Math.max(0, body.clientHeight - dock.offsetTop)}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  const layer = useAppStore((s) => s.layerByTab[tabId] ?? null)
  const layerView = layer ? paneLayerView(layer) : null
  const items = ribbonByTab[tabId]
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

  /**
   * «Стоп» handed the queue back: its texts go into the field before what is
   * already typed, its attachments back as chips — nothing the user wrote is
   * lost by stopping.
   */
  function takeBack(returned: UserInput[]): void {
    if (returned.length === 0) return
    const state = useAppStore.getState()
    setDraft(tabId, draftWithReturned(returned.map((r) => r.text), state.draftByTab[tabId] ?? ''))
    const chips = returned.flatMap((r) => r.attachments.map(pendingFromSent))
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
          // этап 4: onOpenAgents={() => setPaneLayer(tabId, { kind: 'agents' })} and agentsCount, the running subagents.
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

            <PinnedCards tabId={tabId} items={ribbonByTab[tabId] ?? []} answers={answers} />

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

            <Composer
              tabId={tabId}
              status={status}
              draft={draft}
              sentTexts={sentTexts}
              attachments={attachmentsByTab[tabId] ?? []}
              fileIndex={fileIndexByTab[tabId] ?? []}
              started={status !== 'stopped'}
              commands={commands ?? []}
              recentCommands={recentCommands}
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
              onRestart={() => {
                // The new session's panel replaces the old one's whole: its cost and
                // limits are not this session's. The snapshot outranks them.
                void window.qclod
                  .restartTab(tabId)
                  .then(() => window.qclod.panel(tabId))
                  .then((snapshot) => useAppStore.getState().setPanelSnapshot(tabId, snapshot))
              }}
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

            <StatusLine
              tabId={tabId}
              data={panel}
              started={status !== 'stopped'}
              remote={remote}
              onToggleRemote={toggleRemote}
            />
          </div>
        </div>
      </div>

      {mode !== 'hidden' && (
        <SidePanel
          data={panel}
          started={status !== 'stopped'}
          remote={remote}
          onRemote={(enabled) => void window.qclod.setRemote(tabId, enabled)}
          mode={mode}
          onClose={closeDrawer}
        />
      )}
    </section>
  )
}
