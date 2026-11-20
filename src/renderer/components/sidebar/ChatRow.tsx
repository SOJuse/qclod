import { Smartphone, X } from 'lucide-react'
import { hint } from '../../app/shortcuts'
import { DRAG_CHAT } from '../../app/paneOps'
import type { SessionStatus, TabId, TabState } from '../../../shared/types'
import { REMOTE_STATE_LABEL } from '../../../shared/remote'

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'запускается',
  busy: 'работает',
  waiting: 'ждёт ответа',
  idle: 'простаивает',
  stopped: 'не запущена',
  error: 'ошибка'
}

/** The chat's Remote Control word, or null while it is off: then the row says nothing of it. */
function remoteWord(tab: TabState): string | null {
  return tab.remote && tab.remote.state !== 'off' ? REMOTE_STATE_LABEL[tab.remote.state] : null
}

interface Props {
  tab: TabState
  active: boolean
  /** Shown in a pane of the split, though not the active one. */
  inPane: boolean
  onActivate: (id: TabId) => void
  onClose: (id: TabId) => void
}

/**
 * One open chat under its project. It keeps the old tab's names (`tab`,
 * `.is-active`, `.tab-status`, `.tab-title`): a live chat is what a tab was.
 * A click makes it active; the middle button closes it. It can be dragged
 * onto a pane of the split (DRAG_CHAT): that is why a press alone does not
 * activate it — the chat would take the active pane's place before the drop.
 */
export function ChatRow({ tab, active, inPane, onActivate, onClose }: Props): JSX.Element {
  const remote = remoteWord(tab)
  return (
    <div
      data-testid="tab"
      data-tab={tab.id}
      className={`tab${active ? ' is-active' : ''}${inPane && !active ? ' is-in-pane' : ''}${
        tab.badge ? ' has-badge' : ''
      }`}
      title={`${tab.cwd}\n${STATUS_LABEL[tab.status]}${remote ? `\nRemote Control: ${remote}` : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_CHAT, tab.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onClose(tab.id)
        }
      }}
      onClick={(e) => {
        if (e.button === 0) onActivate(tab.id)
      }}
    >
      <span className={`tab-status is-${tab.status}`} aria-hidden />
      <span className="tab-title">{tab.title}</span>
      {tab.remote && remote && (
        // Its own icon, not a second dot: two dots side by side read as one.
        <Smartphone
          size={11}
          className="tab-remote"
          data-testid="tab-remote"
          data-state={tab.remote.state}
          aria-label={`Remote Control: ${remote}`}
        />
      )}
      {tab.badge && <span className="tab-badge" data-testid="tab-badge" aria-hidden />}
      <button
        type="button"
        className="tab-close"
        aria-label={`Закрыть чат ${tab.title}`}
        title={hint('Закрыть чат', 'closeTab')}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onClose(tab.id)
        }}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
