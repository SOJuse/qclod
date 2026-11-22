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

/** The channel's state in a word; «Повторить» / «Подключиться» when it is down. */
export function ServerLink({
  state,
  onRetry,
  onConnect
}: {
  state: ServerView['state']
  onRetry?: () => void
  onConnect?: () => void
}): JSX.Element {
  const label = connectionLabel(state)
  const act = label.action === 'retry' ? onRetry : label.action === 'connect' ? onConnect : undefined
  if (act) {
    return (
      <button type="button" className="server-link" data-testid="server-link" data-state={state} onClick={act}>
        {label.text}
      </button>
    )
  }
  return (
    <span className="server-link" data-testid="server-link" data-state={state}>
      {label.text}
    </span>
  )
}
