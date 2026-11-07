import { TabStrip } from './TabStrip'
import type { TabId, TabState } from '../../shared/types'
import './TitleBar.css'

interface Props {
  tabs: TabState[]
  activeTabId: TabId
  onActivate: (id: TabId) => void
  onClose: (id: TabId) => void
  onCreate: () => void
  onConfigure: (id: TabId) => void
  onOpenSettings: () => void
}

export function TitleBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCreate,
  onConfigure,
  onOpenSettings
}: Props): JSX.Element {
  return (
    <header className="title-bar" data-testid="title-bar">
      <span className="title-bar-mark" aria-hidden />
      <TabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onActivate={onActivate}
        onClose={onClose}
        onCreate={onCreate}
        onConfigure={onConfigure}
      />
      <div className="title-bar-spacer" />
      <div className="window-controls">
        <button
          type="button"
          className="window-button"
          data-testid="open-settings"
          aria-label="Настройки"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
        <button
          type="button"
          className="window-button"
          data-testid="window-minimize"
          aria-label="Свернуть"
          onClick={() => void window.qclod.minimize()}
        >
          ‒
        </button>
        <button
          type="button"
          className="window-button"
          data-testid="window-maximize"
          aria-label="Развернуть"
          onClick={() => void window.qclod.toggleMaximize()}
        >
          ▢
        </button>
        <button
          type="button"
          className="window-button is-close"
          data-testid="window-close"
          aria-label="Закрыть"
          onClick={() => void window.qclod.closeWindow()}
        >
          ×
        </button>
      </div>
    </header>
  )
}
