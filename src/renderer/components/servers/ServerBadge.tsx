import { ShieldAlert } from 'lucide-react'
import type { ServerView } from '../../../shared/types'
import { connectionLabel } from '../../../shared/serverTexts'
import './servers.css'

/** The server a chat runs on: its label, edged in its colour (data-colour, no inline style). */
export function ServerBadge({ server }: { server: Pick<ServerView, 'label' | 'colour' | 'target'> }): JSX.Element {
  return (
    <span className="server-badge" data-testid="server-badge" data-colour={server.colour} title={server.target}>
      {server.label}
    </span>
  )
}

/**
 * The channel's state in a word; «Повторить» / «Подключиться» when it is down;
 * a changed host key in the colour of danger, opening the checklist (R5).
 */
export function ServerLink({
  state,
  onRetry,
  onConnect,
  onChecklist
}: {
  state: ServerView['state']
  onRetry?: () => void
  onConnect?: () => void
  onChecklist?: () => void
}): JSX.Element {
  const label = connectionLabel(state)
  const act =
    label.action === 'retry'
      ? onRetry
      : label.action === 'connect'
        ? onConnect
        : label.action === 'checklist'
          ? onChecklist
          : undefined
  const danger = label.action === 'checklist'
  if (act) {
    return (
      <button
        type="button"
        className="server-link"
        data-testid="server-link"
        data-state={state}
        {...(danger ? { 'data-danger': 'true' } : {})}
        onClick={act}
      >
        {danger && <ShieldAlert size={12} aria-hidden="true" />}
        {label.text}
      </button>
    )
  }
  return (
    <span className="server-link" data-testid="server-link" data-state={state} {...(danger ? { 'data-danger': 'true' } : {})}>
      {danger && <ShieldAlert size={12} aria-hidden="true" />}
      {label.text}
    </span>
  )
}
