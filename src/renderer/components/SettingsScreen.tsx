import { useEffect, useState } from 'react'
import type { AppSettings, HotkeyRegistration } from '../../shared/types'
import './SettingsScreen.css'

interface PermissionRuleView {
  id: string
  toolName: string
  target?: string
}

interface Props {
  settings: AppSettings
  version: string
  onPatch: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

export function SettingsScreen({ settings, version, onPatch, onClose }: Props): JSX.Element {
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyRegistration | null>(null)
  const [rules, setRules] = useState<PermissionRuleView[]>([])

  useEffect(() => {
    void window.qclod.hotkeyStatus().then(setHotkeyStatus)
  }, [settings.globalHotkey])

  useEffect(() => {
    void window.qclod.permissionRules().then(setRules)
  }, [])

  return (
    <div className="settings-backdrop" data-testid="settings" onMouseDown={onClose}>
      <section className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Настройки</h2>
          <button
            type="button"
            className="settings-close"
            data-testid="close-settings"
            aria-label="Закрыть настройки"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="settings-body">
          <Group title="Окно">
            <Field label="Вызов из любого места">
              <input
                type="text"
                data-testid="setting-globalHotkey"
                defaultValue={settings.globalHotkey}
                onBlur={(e) => onPatch({ globalHotkey: e.target.value })}
              />
            </Field>
            {hotkeyStatus && !hotkeyStatus.ok && (
              <p className="settings-warning" data-testid="hotkey-warning">
                {hotkeyStatus.reason}
              </p>
            )}
            <Toggle
              id="closeToTray"
              label="Закрытие окна сворачивает в трей"
              checked={settings.closeToTray}
              onChange={(closeToTray) => onPatch({ closeToTray })}
            />
          </Group>

          <Group title="Уведомления">
            <Toggle
              id="notificationsEnabled"
              label="Сообщать, когда агент закончил или ждёт ответа"
              checked={settings.notificationsEnabled}
              onChange={(notificationsEnabled) => onPatch({ notificationsEnabled })}
            />
            <Toggle
              id="soundEnabled"
              label="Со звуком"
              checked={settings.soundEnabled}
              onChange={(soundEnabled) => onPatch({ soundEnabled })}
            />
          </Group>

          <Group title="Поведение">
            <Field label="Размер шрифта терминала">
              <input
                type="number"
                min={9}
                max={28}
                data-testid="setting-fontSize"
                defaultValue={settings.fontSize}
                onBlur={(e) => onPatch({ fontSize: Number(e.target.value) || settings.fontSize })}
              />
            </Field>
          </Group>

          <Group title="Запуск агента">
            <Field label="Путь к исполняемому файлу">
              <input
                type="text"
                data-testid="setting-agentPath"
                defaultValue={settings.agentPath}
                onBlur={(e) => onPatch({ agentPath: e.target.value })}
              />
            </Field>
            <Field label="Модель по умолчанию">
              <input
                type="text"
                data-testid="setting-defaultModel"
                placeholder="как у CLI"
                defaultValue={settings.defaults.model ?? ''}
                onBlur={(e) => onPatch({ defaults: { model: e.target.value } })}
              />
            </Field>
            <Field label="Режим разрешений по умолчанию">
              <input
                type="text"
                data-testid="setting-defaultPermissionMode"
                placeholder="как у CLI"
                defaultValue={settings.defaults.permissionMode ?? ''}
                onBlur={(e) => onPatch({ defaults: { permissionMode: e.target.value as AppSettings['defaults']['permissionMode'] } })}
              />
            </Field>
            <Field label="Дополнительные флаги">
              <input
                type="text"
                data-testid="setting-defaultExtraFlags"
                placeholder="--verbose"
                defaultValue={settings.defaults.extraFlags ?? ''}
                onBlur={(e) => onPatch({ defaults: { extraFlags: e.target.value } })}
              />
            </Field>
          </Group>

          <Group title="Разрешено без вопросов">
            {rules.length === 0 ? (
              <p className="settings-note" data-testid="rules-empty">
                Пока ничего. Кнопка «Разрешить всё такое» в диалоге добавит сюда правило.
              </p>
            ) : (
              <ul className="settings-rules" data-testid="permission-rules">
                {rules.map((rule) => (
                  <li key={rule.id} data-testid="permission-rule">
                    <span className="settings-rule-tool">{rule.toolName}</span>
                    {rule.target && <span className="settings-rule-target">{rule.target}</span>}
                    <button
                      type="button"
                      data-testid="permission-rule-delete"
                      aria-label={`Забыть правило для ${rule.toolName}`}
                      onClick={() => {
                        void window.qclod
                          .deletePermissionRule(rule.id)
                          .then(() => window.qclod.permissionRules())
                          .then(setRules)
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="settings-note">
              Правила живут в хранилище Qclod. В папке вашего проекта ничего не меняется.
            </p>
          </Group>

          <p className="settings-version">Qclod {version} · обновления ставятся вручную</p>
        </div>
      </section>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="settings-group">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="settings-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function Toggle({
  id,
  label,
  checked,
  onChange
}: {
  id: string
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}): JSX.Element {
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        data-testid={`setting-${id}`}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}
