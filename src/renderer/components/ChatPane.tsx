import { useEffect, useMemo, useRef } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { SessionSummary, UserInput } from '../../shared/types'
import { EMPTY_PANEL, useAppStore } from '../state/useAppStore'
import { compactNow, sendCommand } from '../input/slash'
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
import './ChatPane.css'

interface Props {
  tabId: string
  /** The pane the keyboard and the side panel belong to. */
  focused: boolean
  focusToken: number
  title: string
  /** Shown only when there are two panes: one of them has to say which is which. */
  showTitle: boolean
  onFocus: () => void
  onOpenHistory: () => void
  onCycleMode: () => void
  /** A past conversation picked on the empty tab opens in a tab of its own. */
  onOpenSession: (fromTabId: string, session: SessionSummary) => void
  /** A warning to show above the input, such as the close-tab guard. */
  notice?: { testId: string; text: string } | null
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
  showTitle,
  onFocus,
  onOpenHistory,
  onCycleMode,
  onOpenSession,
  notice
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
  const draft = draftByTab[tabId] ?? ''
  const items = ribbonByTab[tabId]
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
      className={`chat-pane${focused ? ' is-focused' : ''}`}
      data-testid="chat-pane"
      data-tab={tabId}
      onMouseDown={onFocus}
    >
      {showTitle && (
        <header className="chat-pane-title" data-testid="pane-title">
          {title}
        </header>
      )}

      <Ribbon
        key={tabId}
        items={ribbonByTab[tabId] ?? []}
        cwd={tab?.cwd ?? ''}
        tabId={tabId}
        whenEmpty={
          tab && ribbonLoaded ? (
            <EmptyTab tabId={tabId} cwd={tab.cwd} onOpenSession={(s) => onOpenSession(tabId, s)} />
          ) : null
        }
        onAnswerPermission={(requestId, behavior, remember) => {
          void window.qclod.answerPermission(requestId, {
            behavior,
            ...(remember ? { remember: true } : {})
          })
        }}
        onAnswerQuestion={(toolUseId, answers) =>
          void window.qclod.answerQuestion(tabId, toolUseId, answers)
        }
        onAnswerPlan={(requestId, approve) =>
          void window.qclod.answerPlan(tabId, requestId, approve)
        }
      />

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

      <QueueStrip queue={panel.queue ?? []} onCancel={(id) => void window.qclod.cancelQueued(tabId, id)} />

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
        onSetModel={(model) => void window.qclod.setModel(tabId, model)}
        onSetEffort={(level) => void window.qclod.setEffort(tabId, level)}
        focusToken={focusToken}
        autoFocus={focused}
        onDraftChange={(text) => setDraft(tabId, text)}
        onAttachmentsChange={(items) => setAttachments(tabId, items)}
        onSubmit={(text, attachments) => {
          void window.qclod.send(tabId, { text, attachments })
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

      <StatusLine tabId={tabId} data={panel} started={status !== 'stopped'} />
    </section>
  )
}
