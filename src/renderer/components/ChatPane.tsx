import { useAppStore } from '../state/useAppStore'
import { Ribbon } from './Ribbon'
import { Composer } from './Composer'
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
  onOpenPalette: () => void
  onCycleMode: () => void
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
  onOpenPalette,
  onCycleMode
}: Props): JSX.Element {
  const tabs = useAppStore((s) => s.tabs)
  const ribbonByTab = useAppStore((s) => s.ribbonByTab)
  const todoByTab = useAppStore((s) => s.todoByTab)
  const draftByTab = useAppStore((s) => s.draftByTab)
  const attachmentsByTab = useAppStore((s) => s.attachmentsByTab)
  const fileIndexByTab = useAppStore((s) => s.fileIndexByTab)
  const setDraft = useAppStore((s) => s.setDraft)
  const setAttachments = useAppStore((s) => s.setAttachments)

  const status = tabs.find((t) => t.id === tabId)?.status ?? 'stopped'

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
        todo={todoByTab[tabId] ?? []}
        onAnswerPermission={(requestId, behavior, remember) => {
          void window.qclod.answerPermission(requestId, {
            behavior,
            ...(remember ? { remember: true } : {})
          })
        }}
        onAnswerQuestion={(toolUseId, choice) =>
          void window.qclod.answerQuestion(tabId, toolUseId, choice)
        }
        onAnswerPlan={(requestId, approve) =>
          void window.qclod.answerPlan(tabId, requestId, approve)
        }
      />

      <Composer
        tabId={tabId}
        status={status}
        draft={draftByTab[tabId] ?? ''}
        attachments={attachmentsByTab[tabId] ?? []}
        fileIndex={fileIndexByTab[tabId] ?? []}
        focusToken={focusToken}
        autoFocus={focused}
        onDraftChange={(text) => setDraft(tabId, text)}
        onAttachmentsChange={(items) => setAttachments(tabId, items)}
        onSubmit={(text, attachments) => {
          void window.qclod.send(tabId, { text, attachments })
        }}
        onInterrupt={() => void window.qclod.interrupt(tabId)}
        onCycleMode={onCycleMode}
        onRestart={() => void window.qclod.restartTab(tabId)}
        onOpenPalette={onOpenPalette}
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
    </section>
  )
}
