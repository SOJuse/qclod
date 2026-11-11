import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../../shared/types'
import { useModalFocus } from '../ui/modalFocus'
import { StateView } from '../ui/StateView'
import './HistoryScreen.css'

interface Props {
  cwd: string
  /** `null` while the list is being read. */
  sessions: SessionSummary[] | null
  /** Why the list could not be read; it is read again by `onRetry`. */
  error?: string | null
  onRetry?: () => void
  onOpen: (session: SessionSummary) => void
  onClose: () => void
  /** Closing gives focus back to the opener; this runs when the opener is gone. */
  onFocusLost?: () => void
}

export function when(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `сегодня, ${time}`

  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `вчера, ${time}`

  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + `, ${time}`
}

/**
 * Past conversations in this folder.
 *
 * The list comes from the CLI's own session store through the SDK — Qclod
 * keeps no copy of anyone's conversation and reads no internal files of its
 * own invention (spec 6.9, constraint 5.4). Opening one puts it in a new tab,
 * through the same resume path a restart uses.
 */
export function HistoryScreen({
  cwd,
  sessions,
  error = null,
  onRetry,
  onOpen,
  onClose,
  onFocusLost
}: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const field = useRef<HTMLInputElement | null>(null)
  const sheet = useRef<HTMLElement | null>(null)
  const trap = useModalFocus(sheet, onFocusLost)

  // Esc from anywhere in the sheet, not only the search field.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    trap(e)
  }

  useEffect(() => field.current?.focus(), [])

  const needle = query.trim().toLowerCase()
  const shown = (sessions ?? []).filter(
    (session) =>
      needle === '' ||
      session.title.toLowerCase().includes(needle) ||
      session.firstMessage.toLowerCase().includes(needle)
  )

  return (
    <div className="history-backdrop" data-testid="history-screen" onMouseDown={onClose}>
      <section
        ref={sheet}
        className="history"
        role="dialog"
        aria-modal="true"
        aria-label="История"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="history-head">
          <div>
            <h2>История</h2>
            <span className="history-cwd">{cwd}</span>
          </div>
          <button
            type="button"
            data-testid="history-close"
            aria-label="Закрыть историю"
            title="Закрыть (Esc)"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <input
          ref={field}
          className="history-query"
          data-testid="history-query"
          placeholder="Найти в прошлых разговорах…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {error !== null ? (
          <StateView
            kind="error"
            title="Не удалось прочитать историю"
            hint={error}
            {...(onRetry
              ? {
                  action: {
                    label: 'Повторить',
                    onClick: () => {
                      // The button goes with the error; focus stays in the sheet.
                      field.current?.focus()
                      onRetry()
                    }
                  }
                }
              : {})}
          />
        ) : sessions === null ? (
          <StateView kind="loading" title="Читаю историю…" />
        ) : shown.length === 0 ? (
          <StateView
            kind="empty"
            testId="history-empty"
            title={
              sessions.length === 0
                ? 'В этой папке ещё не было разговоров'
                : `Ничего не нашлось по «${query.trim()}»`
            }
          />
        ) : (
          <ul className="history-list">
            {shown.map((session) => (
              <li key={session.id}>
                {/* A button, so Tab reaches it and Enter opens it. */}
                <button
                  type="button"
                  data-testid="history-item"
                  className="history-item"
                  title={session.title}
                  onClick={() => onOpen(session)}
                >
                  <span className="history-title">{session.title}</span>
                  {session.firstMessage && (
                    <span className="history-first">{session.firstMessage}</span>
                  )}
                  <span className="history-when">{when(session.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
