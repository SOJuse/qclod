import { Plus, Smartphone, X } from 'lucide-react'
import { hint } from '../app/shortcuts'
import type { SessionStatus, TabId, TabState } from '../../shared/types'
import { REMOTE_STATE_LABEL } from '../../shared/remote'

/** The tab's Remote Control word, or null while it is off: then the tab says nothing of it. */
function remoteWord(tab: TabState): string | null {
  return tab.remote && tab.remote.state !== 'off' ? REMOTE_STATE_LABEL[tab.remote.state] : null
}

interface Props {
  tabs: TabState[]
  activeTabId: TabId
  onActivate: (id: TabId) => void
  onClose: (id: TabId) => void
  onCreate: () => void
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'запускается',
  busy: 'работает',
  waiting: 'ждёт ответа',
  idle: 'простаивает',
  stopped: 'не запущена',
  error: 'ошибка'
}

export function TabStrip({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCreate
}: Props): JSX.Element {
  return (
    <div className="tab-strip" data-testid="tab-strip">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-testid="tab"
          className={`tab${tab.id === activeTabId ? ' is-active' : ''}${
            tab.badge ? ' has-badge' : ''
          }`}
          title={`${tab.cwd}\n${STATUS_LABEL[tab.status]}${
            remoteWord(tab) ? `\nRemote Control: ${remoteWord(tab)}` : ''
          }`}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              onClose(tab.id)
            } else {
              onActivate(tab.id)
            }
          }}
        >
          <span
            className={`tab-status is-${tab.status}`}
            aria-hidden
          />
          <span className="tab-title">{tab.title}</span>
          {tab.remote && remoteWord(tab) && (
            // Its own icon, not a second dot: two dots side by side read as one.
            <Smartphone
              size={11}
              className="tab-remote"
              data-testid="tab-remote"
              data-state={tab.remote.state}
              aria-label={`Remote Control: ${remoteWord(tab)}`}
            />
          )}
          {tab.badge && <span className="tab-badge" data-testid="tab-badge" aria-hidden />}
          <button
            type="button"
            className="tab-close"
            aria-label={`Закрыть ${tab.title}`}
            title={hint('Закрыть вкладку', 'closeTab')}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.id)
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" className="tab-new" data-testid="tab-new" aria-label="Новая вкладка" title={hint('Новая вкладка', 'newTab')} onClick={onCreate}>
        <Plus size={15} aria-hidden="true" />
      </button>
    </div>
  )
}
