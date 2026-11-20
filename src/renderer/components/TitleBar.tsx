import { Columns2, Minus, PanelLeftClose, PanelLeftOpen, Settings, Square, TriangleAlert, X } from 'lucide-react'
import { hint } from '../app/shortcuts'
import { CHROME_ICON_SIZE } from '../ui/icons'
import type { HotkeyRegistration } from '../../shared/types'
import './TitleBar.css'

interface Props {
  /** The active chat's title; shown in the middle while there is one pane. */
  chatTitle: string | null
  sidebarOpen: boolean
  onToggleSidebar: () => void
  hotkey: HotkeyRegistration | null
  onOpenSettings: () => void
  onToggleSplit: () => void
  splitOpen: boolean
}

/**
 * The frameless window's bar: the sidebar's button and the mark on the left,
 * the chat's title in the middle, the split, the settings and the window's
 * own buttons on the right. The rest of it drags the window.
 */
export function TitleBar({
  chatTitle,
  sidebarOpen,
  onToggleSidebar,
  hotkey,
  onOpenSettings,
  onToggleSplit,
  splitOpen
}: Props): JSX.Element {
  const sidebarLabel = sidebarOpen ? 'Скрыть боковую панель' : 'Показать боковую панель'
  const SidebarIcon = sidebarOpen ? PanelLeftClose : PanelLeftOpen
  return (
    <header className="title-bar" data-testid="title-bar">
      <button
        type="button"
        className="window-button title-bar-sidebar"
        data-testid="sidebar-toggle"
        aria-label={sidebarLabel}
        title={hint(sidebarLabel, 'toggleSidebar')}
        onClick={onToggleSidebar}
      >
        <SidebarIcon size={CHROME_ICON_SIZE} aria-hidden="true" />
      </button>
      <span className="title-bar-mark" aria-hidden />
      <span className="title-bar-name">Qclod</span>
      {chatTitle && (
        <div className="title-bar-title" data-testid="title-bar-chat">
          {chatTitle}
        </div>
      )}
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
          aria-label="Сплит: открыть рядом или закрыть"
          title={hint('Сплит: открыть рядом или закрыть', 'toggleSplit')}
          onClick={onToggleSplit}
        >
          <Columns2 size={CHROME_ICON_SIZE} aria-hidden="true" />
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
 * The first-run screen has no chats yet, but the window still has to be dragged,
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
