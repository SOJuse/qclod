import { Columns2, TriangleAlert, History, Minus, Settings, Square, X } from 'lucide-react'
import { hint } from '../app/shortcuts'
import { CHROME_ICON_SIZE } from '../ui/icons'
import { TabStrip } from './TabStrip'
import type { HotkeyRegistration, TabId, TabState } from '../../shared/types'
import './TitleBar.css'

interface Props {
  tabs: TabState[]
  activeTabId: TabId
  onActivate: (id: TabId) => void
  onClose: (id: TabId) => void
  onCreate: () => void
  hotkey: HotkeyRegistration | null
  onOpenSettings: () => void
  onOpenHistory: () => void
  onToggleSplit: () => void
  splitOpen: boolean
}

export function TitleBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onCreate,
  hotkey,
  onOpenSettings,
  onOpenHistory,
  onToggleSplit,
  splitOpen
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
      />
      <div className="title-bar-spacer" />
      {hotkey && !hotkey.ok && (
        <button
          type="button"
          className="hotkey-warning"
          data-testid="hotkey-warning-pip"
          title={hotkey.reason}
          onClick={onOpenSettings}
        >
          <TriangleAlert size={12} aria-hidden="true" /> хоткей занят
        </button>
      )}
      <div className="window-controls">
        <button
          type="button"
          className={`window-button${splitOpen ? ' is-on' : ''}`}
          data-testid="toggle-split"
          aria-label="Два разговора рядом"
          title={hint('Два разговора рядом', 'toggleSplit')}
          onClick={onToggleSplit}
        >
          <Columns2 size={CHROME_ICON_SIZE} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-button"
          data-testid="open-history"
          aria-label="Прошлые разговоры"
          title={hint('Прошлые разговоры', 'history')}
          onClick={onOpenHistory}
        >
          <History size={CHROME_ICON_SIZE} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="window-button"
          data-testid="open-settings"
          aria-label="Настройки"
          title={hint('Настройки', 'settings')}
          onClick={onOpenSettings}
        >
          <Settings size={CHROME_ICON_SIZE} aria-hidden="true" />
        </button>
        <WindowButtons />
      </div>
    </header>
  )
}

/** Minimise, maximise, close: the frameless window's own buttons. */
function WindowButtons(): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="window-button"
        data-testid="window-minimize"
        aria-label="Свернуть"
        title="Свернуть"
        onClick={() => void window.qclod.minimize()}
      >
        <Minus size={CHROME_ICON_SIZE} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-button"
        data-testid="window-maximize"
        aria-label="Развернуть"
        title="Развернуть или вернуть размер"
        onClick={() => void window.qclod.toggleMaximize()}
      >
        <Square size={CHROME_ICON_SIZE} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-button is-close"
        data-testid="window-close"
        aria-label="Закрыть"
        title="Закрыть окно"
        onClick={() => void window.qclod.closeWindow()}
      >
        <X size={CHROME_ICON_SIZE} aria-hidden="true" />
      </button>
    </>
  )
}

/**
 * The first-run screen has no tabs yet, but the window still has to be dragged,
 * minimised and closed: a bar with the mark and the window buttons only.
 */
export function SetupTitleBar(): JSX.Element {
  return (
    <header className="title-bar" data-testid="setup-title-bar">
      <span className="title-bar-mark" aria-hidden />
      <div className="title-bar-spacer" />
      <div className="window-controls">
        <WindowButtons />
      </div>
    </header>
  )
}
