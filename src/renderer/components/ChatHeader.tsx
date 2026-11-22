import { Bot, PanelRightClose, PanelRightOpen, SquareTerminal, X } from 'lucide-react'
import type { ServerView, SessionStatus } from '../../shared/types'
import { ServerBadge, ServerLink } from './servers/ServerBadge'
import { hint } from '../app/shortcuts'
import { STATUS_LABEL } from '../labels'
import { PANEL_TOGGLE_ATTR } from './SidePanel'
import './ChatHeader.css'

interface Props {
  title: string
  cwd: string
  status: SessionStatus
  /** Two panes or more: then the pane says which chat it is (alone, the title bar does). */
  split: boolean
  /** The pane's own right-hand panel is out, docked or slid over. */
  panelShown: boolean
  onTogglePanel: () => void
  /** Takes this chat out of the split; only in a split. */
  onUnsplit?: () => void
  /** Opens the subagents' layer over the ribbon (этап 4); without it there is no button. */
  onOpenAgents?: () => void
  /** How many subagents are working now (этап 4). */
  agentsCount?: number
  /** Stage 6: the server this chat runs on — its badge and the channel's state. */
  server?: ServerView | undefined
  /** «Повторить» / «Подключиться» of a server that is not on line. */
  onReconnect?: () => void
  /** A changed host key: the checklist that says what to do (R5). */
  onShowChecklist?: () => void
  /** The chat's server was removed from the list (R9). */
  serverGone?: boolean
  /** Stage 6: «Терминал» of a server chat — the drawer under the ribbon. */
  onToggleTerminal?: () => void
  terminalOpen?: boolean
}

/** The folder's own name: the path is in the hint. */
function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/**
 * A pane's quiet first line: which chat in a split, its folder, its state in
 * a word, and the pane's own buttons — the right-hand panel, «Агенты» (решение
 * 16), out of the split.
 */
export function ChatHeader({
  title,
  cwd,
  status,
  split,
  panelShown,
  onTogglePanel,
  onUnsplit,
  onOpenAgents,
  agentsCount = 0,
  server,
  onReconnect,
  onShowChecklist,
  serverGone = false,
  onToggleTerminal,
  terminalOpen = false
}: Props): JSX.Element {
  const panelLabel = panelShown ? 'Скрыть панель' : 'Показать панель'
  // A new chat is named after its folder: the name once is enough.
  const folder = cwd ? folderName(cwd) : ''
  const showFolder = folder !== '' && folder !== title
  return (
    <header className="chat-header" data-testid="chat-header">
      {split && (
        <span className="chat-header-title" data-testid="pane-title" title={title}>
          {title}
        </span>
      )}
      {showFolder && (
        <span className="chat-header-cwd" title={cwd}>
          {folder}
        </span>
      )}
      {server && (
        <>
          <ServerBadge server={server} />
          <ServerLink
            state={server.state}
            {...(onReconnect ? { onRetry: onReconnect, onConnect: onReconnect } : {})}
            {...(onShowChecklist ? { onChecklist: onShowChecklist } : {})}
          />
        </>
      )}
      {!server && serverGone && (
        <span className="server-badge is-gone" data-testid="server-badge-gone">
          Сервер удалён
        </span>
      )}
      <span className="chat-header-status" data-testid="chat-header-status" data-status={status}>
        {STATUS_LABEL[status]}
      </span>
      <span className="chat-header-gap" />
      {onToggleTerminal && (
        <button
          type="button"
          className="chat-header-button is-text"
          data-testid="open-terminal"
          aria-pressed={terminalOpen}
          onClick={onToggleTerminal}
        >
          <SquareTerminal size={14} aria-hidden="true" />
          <span>Терминал</span>
        </button>
      )}
      {onOpenAgents && (
        <button
          type="button"
          className="chat-header-button is-text"
          data-testid="open-agents"
          title="Сабагенты этого чата: граф и таймлайн"
          onClick={onOpenAgents}
        >
          <Bot size={14} aria-hidden="true" />
          <span>{agentsCount > 0 ? `Агенты (${agentsCount})` : 'Агенты'}</span>
        </button>
      )}
      {onUnsplit && (
        <button
          type="button"
          className="chat-header-button"
          data-testid="pane-unsplit"
          aria-label="Убрать из сплита"
          title="Убрать из сплита"
          onClick={onUnsplit}
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="chat-header-button"
        data-testid={panelShown ? 'panel-close' : 'panel-open'}
        aria-label={panelLabel}
        aria-pressed={panelShown}
        title={hint(panelLabel, 'togglePanel')}
        onClick={onTogglePanel}
        {...{ [PANEL_TOGGLE_ATTR]: '' }}
      >
        {panelShown ? <PanelRightClose size={14} aria-hidden="true" /> : <PanelRightOpen size={14} aria-hidden="true" />}
      </button>
    </header>
  )
}
