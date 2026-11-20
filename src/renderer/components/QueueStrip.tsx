import { Clock, Loader2, Pencil, SendHorizontal, X } from 'lucide-react'
import type { QueuedMessage } from '../../shared/types'
import './QueueStrip.css'

interface Props {
  queue: QueuedMessage[]
  onSendNow: (id: string) => void
  onCancel: (id: string) => void
  onEdit: (id: string) => void
}

/** What the row says about the message: where it is on its way. */
function caption(item: QueuedMessage): string {
  const lead = item.state === 'waiting' ? 'Отправится, когда агент запустится' : 'Дойдёт после текущего шага'
  // Only attachments: no empty quotes to show.
  return item.text !== '' ? `${lead}: «${item.text}»` : `${lead} — вложений: ${item.attachments}`
}

/**
 * What was sent while the agent worked, above the input: the agent has not
 * read these yet. Each can go at once, come back into the field to be edited,
 * or be taken back. Not in the ribbon — it has not been said yet.
 */
export function QueueStrip({ queue, onSendNow, onCancel, onEdit }: Props): JSX.Element | null {
  if (queue.length === 0) return null
  return (
    <ul className="queue-strip" data-testid="queue-strip" aria-label="Очередь сообщений">
      {queue.map((item) => {
        const cancelling = item.state === 'cancelling'
        const what = item.text !== '' ? item.text : `вложений: ${item.attachments}`
        return (
          <li key={item.id} className="queue-item" data-testid="queue-item">
            {cancelling ? (
              <Loader2 size={14} className="queue-spinner" data-testid="queue-spinner" aria-hidden="true" />
            ) : (
              <Clock size={14} aria-hidden="true" />
            )}
            <span className="queue-text">
              {caption(item)}
              {item.text !== '' && item.attachments > 0 && (
                <span className="queue-attachments"> + вложений: {item.attachments}</span>
              )}
            </span>
            {item.canSendNow && (
              <button
                type="button"
                className="queue-action"
                data-testid="queue-send-now"
                aria-label={`Отправить сейчас: ${what}`}
                title="Отправить сейчас"
                disabled={cancelling}
                onClick={() => onSendNow(item.id)}
              >
                <SendHorizontal size={14} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="queue-action"
              data-testid="queue-edit"
              aria-label={`Изменить: ${what}`}
              title="Изменить"
              disabled={cancelling}
              onClick={() => onEdit(item.id)}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="queue-action"
              data-testid="queue-cancel"
              aria-label={`Убрать из очереди: ${what}`}
              title="Убрать из очереди"
              disabled={cancelling}
              onClick={() => onCancel(item.id)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
