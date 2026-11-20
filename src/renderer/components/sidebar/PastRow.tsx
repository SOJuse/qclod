import { shortWhen } from '../../../shared/format'
import type { SessionSummary } from '../../../shared/types'
import { DRAG_SESSION } from '../../app/paneOps'

/** How long a title made from the first message may be. */
const FIRST_MESSAGE_CHARS = 60

/** The row's words: the session's title, or the start of what was asked in it. */
export function pastLabel(session: SessionSummary): string {
  return session.title.trim() || session.firstMessage.trim().slice(0, FIRST_MESSAGE_CHARS)
}

interface Props {
  /** The project's folder: a dragged row opens there. */
  cwd: string
  session: SessionSummary
  onOpen: (session: SessionSummary) => void
}

/**
 * A past conversation of the project: its title on the left, when it was last
 * touched on the right. It can be dragged onto a pane of the split (DRAG_SESSION).
 */
export function PastRow({ cwd, session, onOpen }: Props): JSX.Element {
  const label = pastLabel(session)
  return (
    <button
      type="button"
      className="past-row"
      data-testid="sidebar-session"
      title={`Открыть разговор: ${label}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_SESSION, JSON.stringify({ cwd, sessionId: session.id, title: session.title }))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => onOpen(session)}
    >
      <span className="past-title">{label}</span>
      <span className="past-when">{shortWhen(session.updatedAt)}</span>
    </button>
  )
}
