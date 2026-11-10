import { useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type AppSettings,
  type EffortLevel,
  type HotkeyRegistration,
  type ModelOption,
  type PermissionMode
} from '../../shared/types'
import { EFFORT_LABEL, MODE_LABEL } from '../labels'
import './SettingsScreen.css'

interface PermissionRuleView {
  id: string
  toolName: string
  target?: string
}

interface Props {
  settings: AppSettings
  version: string
  /** Models the active tab's session offers; empty until it has started. */
  models: ModelOption[]
  onPatch: (patch: Partial<AppSettings>) => Promise<AppSettings>
  onClose: () => void
}

export function SettingsScreen({ settings, version, models, onPatch: save, onClose }: Props): JSX.Element {
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyRegistration | null>(null)
  const [rules, setRules] = useState<PermissionRuleView[]>([])
  const [saved, setSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  const sheet = useRef<HTMLElement>(null)

  useEffect(() => {
    void window.qclod.hotkeyStatus().then(setHotkeyStatus)
  }, [settings.globalHotkey])

  useEffect(() => {
    void window.qclod.permissionRules().then(setRules)
  }, [])

  useEffect(() => {
    // Focus inside the sheet is what lets Esc reach it.
    sheet.current?.focus()
    return () => clearTimeout(savedTimer.current)
  }, [])

  // The indicator follows the answer, not the click: it shows what the main process kept.
  const onPatch = (patch: Partial<AppSettings>): void => {
    void save(patch).then(() => {
      setSaved(true)
      clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setSaved(false), 2000)
    })
  }

  // Blurring first lets a field that is still being edited save before the screen goes.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    onClose()
  }

  const model = settings.defaults.model ?? ''
  const modelKnown = model === '' || models.some((m) => m.value === model)

  return (
    <div className="settings-backdrop" data-testid="settings" onMouseDown={onClose}>
      <section
        className="settings"
        ref={sheet}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="settings-head">
          <h2>Настройки</h2>
          <div className="settings-head-end">
            {saved && (
              <span className="settings-saved" data-testid="settings-saved" role="status">
                <Check size={14} aria-hidden="true" />
                Сохранено
              </span>
            )}
            <button
              type="button"
              className="settings-close"
              data-testid="close-settings"
              aria-label="Закрыть настройки"
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
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
              <select
                data-testid="setting-defaultModel"
                value={model}
                onChange={(e) => onPatch({ defaults: { model: e.target.value } })}
              >
                <option value="">Как у Claude Code</option>
                {!modelKnown && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Усилие по умолчанию">
              <select
                data-testid="setting-defaultEffort"
                value={settings.defaults.effort ?? ''}
                onChange={(e) => onPatch({ defaults: { effort: e.target.value as EffortLevel } })}
              >
                <option value="">Как у Claude Code</option>
                {EFFORT_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {EFFORT_LABEL[level]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Режим по умолчанию">
              <select
                data-testid="setting-defaultPermissionMode"
                value={settings.defaults.permissionMode ?? 'default'}
                onChange={(e) => onPatch({ defaults: { permissionMode: e.target.value as PermissionMode } })}
              >
                {PERMISSION_MODES.filter((mode) => mode !== 'bypassPermissions').map((mode) => (
                  <option key={mode} value={mode}>
                    {MODE_LABEL[mode]}
                  </option>
                ))}
              </select>
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

          <Group title="Файлы в ответах">
            <Field label="Команда редактора">
              <input
                type="text"
                data-testid="setting-editorCommand"
                maxLength={1000}
                placeholder="code -g {path}:{line}"
                spellCheck={false}
                defaultValue={settings.editorCommand}
                onBlur={(e) => {
                  if (e.target.value !== settings.editorCommand) onPatch({ editorCommand: e.target.value })
                }}
              />
            </Field>
            <p className="settings-note">
              Для пункта «Открыть в редакторе» в меню пути. Вместо {'{path}'} встанет файл, вместо {'{line}'} и{' '}
              {'{column}'} — строка и столбец. Пусто — пункта нет.
            </p>
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
                      <X size={14} aria-hidden="true" />
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
