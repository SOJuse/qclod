import { useState } from 'react'
import type { AppSettings, LaunchOverrides, TabState } from '../../shared/types'
import './SettingsScreen.css'

interface Props {
  tab: TabState
  globalDefaults: AppSettings['defaults']
  onSave: (overrides: LaunchOverrides) => void
  onClose: () => void
}

/**
 * Per-tab launch flags. Every field is optional: left blank, the tab inherits
 * the global default, and the placeholder says what that is.
 */
export function TabSettingsDialog({
  tab,
  globalDefaults,
  onSave,
  onClose
}: Props): JSX.Element {
  const [draft, setDraft] = useState<LaunchOverrides>({ ...tab.overrides })

  const field = (
    key: keyof LaunchOverrides,
    label: string,
    inheritedFrom?: string
  ): JSX.Element => (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type="text"
        data-testid={`tab-setting-${key}`}
        placeholder={inheritedFrom ? `наследуется: ${inheritedFrom}` : 'как у CLI'}
        value={draft[key] ?? ''}
        onChange={(e) => setDraft((current) => ({ ...current, [key]: e.target.value }))}
      />
    </label>
  )

  return (
    <div className="settings-backdrop" data-testid="tab-settings" onMouseDown={onClose}>
      <section className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Вкладка: {tab.title}</h2>
          <button
            type="button"
            className="settings-close"
            data-testid="tab-settings-close"
            aria-label="Закрыть"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="settings-body">
          <p className="settings-version" style={{ margin: '8px 0 0' }}>
            {tab.cwd}
          </p>
          <section className="settings-group">
            {field('model', 'Модель', globalDefaults.model)}
            {field('permissionMode', 'Режим разрешений', globalDefaults.permissionMode)}
            {field('mcpConfig', 'Конфиг MCP', globalDefaults.mcpConfig)}
            {field('extraFlags', 'Дополнительные флаги', globalDefaults.extraFlags)}
          </section>
          <p className="settings-version">
            Изменения применятся при следующем запуске сессии этой вкладки.
          </p>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-button"
              data-testid="tab-settings-save"
              onClick={() => onSave(draft)}
            >
              Сохранить
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
