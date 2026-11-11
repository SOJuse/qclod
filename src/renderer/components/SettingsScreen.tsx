import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { ERROR_ICON } from '../ui/icons'
import { reasonOf, StateView } from '../ui/StateView'
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
import { useModalFocus } from '../ui/modalFocus'
import './SettingsScreen.css'

interface PermissionRuleView {
  id: string
  toolName: string
  target?: string
}

interface Props {
  /** `null` until the main process has answered; the sheet opens anyway and says it is loading. */
  settings: AppSettings | null
  /** Why the settings could not be read; `onRetryLoad` asks again. */
  loadError?: string | null
  onRetryLoad?: () => void
  version: string
  /** Models the active tab's session offers; empty until it has started. */
  models: ModelOption[]
  onPatch: (patch: Partial<AppSettings>) => Promise<AppSettings>
  onClose: () => void
  /** Closing gives focus back to the opener; this runs when the opener is gone. */
  onFocusLost?: () => void
  /** A field to start in, selected: the setup screen opens settings for the agent path. */
  focusField?: 'agentPath'
}

export function SettingsScreen({
  settings,
  loadError = null,
  onRetryLoad,
  version,
  models,
  onPatch: save,
  onClose,
  onFocusLost,
  focusField
}: Props): JSX.Element {
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyRegistration | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [rules, setRules] = useState<PermissionRuleView[]>([])
  const [rulesError, setRulesError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  const sheet = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const trap = useModalFocus(sheet, onFocusLost)

  const loadHotkey = useCallback((): void => {
    setHotkeyError(null)
    window.qclod.hotkeyStatus().then(setHotkeyStatus, (err) => setHotkeyError(reasonOf(err)))
  }, [])
  useEffect(loadHotkey, [settings?.globalHotkey, loadHotkey])

  const loadRules = useCallback((): void => {
    setRulesError(null)
    window.qclod.permissionRules().then(setRules, (err) => setRulesError(reasonOf(err)))
  }, [])
  useEffect(loadRules, [loadRules])

  /** A «Повторить» goes with its error; focus stays in the sheet rather than falling to the page. */
  const retry = (run: () => void) => (): void => {
    closeButton.current?.focus()
    run()
  }

  useEffect(() => {
    // Focus inside the sheet is what lets Esc reach it. It lands on a control, not
    // on the sheet itself, so the ring shows where Tab goes from here. A field that
    // asked for focus keeps it; it is inside the sheet, so Esc still works.
    if (!focusField) closeButton.current?.focus()
    return () => clearTimeout(savedTimer.current)
  }, [])

  // The indicator follows the answer, not the click: it shows what the main process kept.
  // A refusal stays in its place until a later change is kept.
  const onPatch = (patch: Partial<AppSettings>): void => {
    save(patch).then(
      () => {
        setSaveError(null)
        setSaved(true)
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 2000)
      },
      (err) => {
        clearTimeout(savedTimer.current)
        setSaved(false)
        setSaveError(reasonOf(err))
      }
    )
  }

  // Blurring first lets a field that is still being edited save before the screen goes.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape') return trap(e)
    e.stopPropagation()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    onClose()
  }

  const model = settings?.defaults.model ?? ''
  const modelKnown = model === '' || models.some((m) => m.value === model)

  return (
    <div className="settings-backdrop" data-testid="settings" onMouseDown={onClose}>
      <section
        className="settings"
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="settings-head">
          <h2>Настройки</h2>
          <div className="settings-head-end">
            {saveError !== null ? (
              <span className="settings-saved is-failed" data-testid="settings-save-failed" role="alert">
                <ERROR_ICON size={14} aria-hidden="true" />
                Не сохранилось: {saveError}
              </span>
            ) : (
              saved && (
                <span className="settings-saved" data-testid="settings-saved" role="status">
                  <Check size={14} aria-hidden="true" />
                  Сохранено
                </span>
              )
            )}
            <button
              ref={closeButton}
              type="button"
              className="settings-close"
              data-testid="close-settings"
              aria-label="Закрыть настройки"
              title="Закрыть настройки"
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {settings === null ? (
          <div className="settings-body">
            {loadError !== null ? (
              <StateView
                kind="error"
                title="Не удалось прочитать настройки"
                hint={loadError}
                {...(onRetryLoad ? { action: { label: 'Повторить', onClick: retry(onRetryLoad) } } : {})}
              />
            ) : (
              <StateView kind="loading" title="Загружаю настройки…" />
            )}
          </div>
        ) : (
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
              {hotkeyError !== null ? (
                <StateView
                  kind="error"
                  testId="hotkey-status-error"
                  title="Не удалось проверить сочетание"
                  hint={hotkeyError}
                  action={{ label: 'Повторить', onClick: retry(loadHotkey) }}
                />
              ) : (
                hotkeyStatus &&
                !hotkeyStatus.ok && (
                  <p className="settings-warning" data-testid="hotkey-warning">
                    {hotkeyStatus.reason}
                  </p>
                )
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
                  autoFocus={focusField === 'agentPath'}
                  onFocus={focusField === 'agentPath' ? (e) => e.target.select() : undefined}
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
              {rulesError !== null ? (
                <StateView
                  kind="error"
                  testId="rules-error"
                  title="Не удалось прочитать правила"
                  hint={rulesError}
                  action={{ label: 'Повторить', onClick: retry(loadRules) }}
                />
              ) : rules.length === 0 ? (
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
                        title={`Забыть правило для ${rule.toolName}`}
                        onClick={() => {
                          window.qclod
                            .deletePermissionRule(rule.id)
                            .then(() => window.qclod.permissionRules())
                            .then(setRules, (err) => setRulesError(reasonOf(err)))
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
        )}
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
