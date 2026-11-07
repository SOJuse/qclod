import type { TabState } from '../../shared/types'
import './TabErrorPanel.css'

interface Props {
  tab: TabState
  onRestart: () => void
  onOpenSettings: () => void
}

/**
 * Takes the composer's place when a tab has no running agent. The terminal
 * above keeps everything that was already printed — a dead session must never
 * look like an empty black rectangle (anti-goal 5).
 */
export function TabErrorPanel({ tab, onRestart, onOpenSettings }: Props): JSX.Element {
  const notFound = tab.status === 'error'

  return (
    <div className="tab-error" data-testid="tab-error">
      <div className="tab-error-text">
        <p className="tab-error-title">
          {notFound ? 'Агент не запустился' : `Агент завершился с кодом ${tab.exitCode ?? '?'}`}
        </p>
        <p className="tab-error-detail">
          {tab.error ??
            'Сессия закрыта. Прочитанный вывод остался на месте — его можно скопировать.'}
        </p>
      </div>
      <div className="tab-error-actions">
        {notFound && (
          <button
            type="button"
            className="settings-button"
            data-testid="error-open-settings"
            onClick={onOpenSettings}
          >
            Открыть настройки
          </button>
        )}
        <button
          type="button"
          className="settings-button"
          data-testid="error-restart"
          onClick={onRestart}
        >
          Перезапустить
        </button>
      </div>
    </div>
  )
}
