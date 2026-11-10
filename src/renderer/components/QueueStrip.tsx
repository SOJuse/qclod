import { Clock, X } from 'lucide-react'
import type { QueuedMessage } from '../../shared/types'
import './QueueStrip.css'

interface Props {
  queue: QueuedMessage[]
  onCancel: (id: string) => void
}

/**
 * What was sent while the agent worked, above the input: each message waits
 * here until the agent is free and goes on its own. The cross takes one back
 * before it goes. Not in the ribbon — it has not been said yet.
 */
export function QueueStrip({ queue, onCancel }: Props): JSX.Element | null {
  if (queue.length === 0) return null
  return (
    <ul className="queue-strip" data-testid="queue-strip" aria-label="Очередь сообщений">
      {queue.map((item) => (
        <li key={item.id} className="queue-item" data-testid="queue-item">
          <Clock size={14} aria-hidden="true" />
          <span className="queue-text">
            {item.text !== '' ? (
              <>
                В очереди: «{item.text}»
                {item.attachments > 0 && (
                  <span className="queue-attachments"> + вложений: {item.attachments}</span>
                )}
              </>
            ) : (
              // Only attachments: no empty quotes to show.
              <>В очереди — вложений: {item.attachments}</>
            )}
          </span>
          <button
            type="button"
            className="queue-cancel"
            data-testid="queue-cancel"
            aria-label={`Убрать из очереди: ${item.text !== '' ? item.text : `вложений: ${item.attachments}`}`}
            title="Убрать из очереди"
            onClick={() => onCancel(item.id)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )
}
