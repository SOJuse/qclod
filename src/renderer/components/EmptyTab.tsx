import { useEffect, useState } from 'react'
import { Folder, MessageSquare } from 'lucide-react'
import type { SessionSummary, TabId } from '../../shared/types'
import { APP_ACTIONS } from '../app/shortcuts'
import { PathLink } from '../paths/PathLink'
import { when } from './HistoryScreen'
import './EmptyTab.css'

const RECENT_LIMIT = 5

function keysOf(id: 'actions' | 'cycleMode'): string {
  return APP_ACTIONS.find((a) => a.id === id)?.keys ?? ''
}

interface Props {
  tabId: TabId
  cwd: string
  onOpenSession: (session: SessionSummary) => void
}

/**
 * What a conversation with nothing in it shows: the folder it works in, the
 * last few conversations there, and the four keys worth knowing. Without past
 * conversations there is no line about them at all, not an empty one.
 */
export function EmptyTab({ tabId, cwd, onOpenSession }: Props): JSX.Element {
  const [recent, setRecent] = useState<SessionSummary[]>([])

  useEffect(() => {
    let current = true
    void window.qclod
      .listHistory(tabId)
      .then((sessions) => {
        if (current) setRecent(sessions.slice(0, RECENT_LIMIT))
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [tabId])

  const tips: Array<{ keys: string; text: string }> = [
    { keys: '/', text: 'команды' },
    { keys: '@', text: 'файлы' },
    { keys: keysOf('actions'), text: 'действия' },
    { keys: keysOf('cycleMode'), text: 'режим разрешений' }
  ]

  return (
    <div className="empty-tab" data-testid="empty-tab">
      <div className="empty-tab-inner">
        <div className="empty-tab-folder">
          <Folder size={15} aria-hidden="true" />
          <PathLink tabId={tabId} target={{ raw: cwd, absPath: cwd, isDir: true }}>
            {cwd}
          </PathLink>
        </div>

        {recent.length > 0 && (
          <ul className="empty-tab-recent" data-testid="empty-recent-list" aria-label="Недавние разговоры">
            {recent.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="empty-tab-session"
                  data-testid="empty-recent"
                  title={`Открыть разговор: ${session.title}`}
                  onClick={() => onOpenSession(session)}
                >
                  <MessageSquare size={14} aria-hidden="true" />
                  <span className="empty-tab-session-title">{session.title}</span>
                  <span className="empty-tab-session-when">{when(session.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <ul className="empty-tab-tips" data-testid="empty-tips">
          {tips.map((tip) => (
            <li key={tip.keys}>
              <kbd>{tip.keys}</kbd>
              <span>— {tip.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
