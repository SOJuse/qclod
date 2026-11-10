import { CircleAlert } from 'lucide-react'
import { contextLevel } from '../chat/contextLevel'
import './StatusLine.css'

interface Props {
  percent: number
  onCompact: () => void
  /** The agent is working: a compaction now would wait behind it. */
  disabled?: boolean
}

/**
 * The warning before the session compacts by itself: at 90% the next long
 * answer may not fit, and it is better to choose the moment than to have it
 * chosen mid-task.
 */
export function ContextBanner({ percent, onCompact, disabled = false }: Props): JSX.Element | null {
  if (contextLevel(percent) !== 'critical') return null
  return (
    <div className="context-banner" data-testid="context-banner" role="status">
      <CircleAlert size={14} aria-hidden="true" className="context-banner-icon" />
      <span className="context-banner-text">Контекст почти заполнен — {Math.round(percent)}%</span>
      <button
        type="button"
        className="context-banner-action"
        data-testid="context-compact"
        disabled={disabled}
        title="Сжать разговор в краткий пересказ (/compact)"
        onClick={onCompact}
      >
        Сжать сейчас
      </button>
    </div>
  )
}
