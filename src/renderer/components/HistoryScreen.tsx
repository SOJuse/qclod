import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SessionSummary } from '../../shared/types'
import './HistoryScreen.css'

interface Props {
  cwd: string
  sessions: SessionSummary[] | null
  onOpen: (session: SessionSummary) => void
  onClose: () => void
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
export function HistoryScreen({ cwd, sessions, onOpen, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const field = useRef<HTMLInputElement | null>(null)

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
      <section className="history" onMouseDown={(e) => e.stopPropagation()}>
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
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        />

        {sessions === null ? (
          <div className="history-empty">Читаю…</div>
        ) : shown.length === 0 ? (
          <div className="history-empty" data-testid="history-empty">
            {sessions.length === 0
              ? 'В этой папке ещё не было разговоров'
              : 'Ничего не нашлось'}
          </div>
        ) : (
          <ul className="history-list">
            {shown.map((session) => (
              <li
                key={session.id}
                data-testid="history-item"
                className="history-item"
                onClick={() => onOpen(session)}
              >
                <div className="history-title">{session.title}</div>
                {session.firstMessage && (
                  <div className="history-first">{session.firstMessage}</div>
                )}
                <div className="history-when">{when(session.updatedAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
