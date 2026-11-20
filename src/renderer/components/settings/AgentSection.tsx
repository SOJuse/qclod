import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type EffortLevel,
  type PermissionMode
} from '../../../shared/types'
import { EFFORT_LABEL, MODE_LABEL } from '../../labels'
import { Field, Group, save } from './parts'
import type { SettingsSectionProps } from './types'

export function AgentSection({ settings, patch, models, focusField }: SettingsSectionProps): JSX.Element {
  const model = settings.defaults.model ?? ''
  const modelKnown = model === '' || models.some((m) => m.value === model)

  return (
    <>
      <Group>
        <Field label="Путь к исполняемому файлу">
          <input
            type="text"
            className="field"
            data-testid="setting-agentPath"
            autoFocus={focusField === 'agentPath'}
            onFocus={focusField === 'agentPath' ? (e) => e.target.select() : undefined}
            defaultValue={settings.agentPath}
            onBlur={(e) => save(patch, { agentPath: e.target.value })}
          />
        </Field>
        <Field label="Модель по умолчанию">
          <select
            className="field"
            data-testid="setting-defaultModel"
            value={model}
            onChange={(e) => save(patch, { defaults: { model: e.target.value } })}
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
            className="field"
            data-testid="setting-defaultEffort"
            value={settings.defaults.effort ?? ''}
            onChange={(e) => save(patch, { defaults: { effort: e.target.value as EffortLevel } })}
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
            className="field"
            data-testid="setting-defaultPermissionMode"
            value={settings.defaults.permissionMode ?? 'default'}
            onChange={(e) => save(patch, { defaults: { permissionMode: e.target.value as PermissionMode } })}
          >
            {PERMISSION_MODES.filter((mode) => mode !== 'bypassPermissions' && mode !== 'autoAllow').map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABEL[mode]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Дополнительные флаги">
          <input
            type="text"
            className="field"
            data-testid="setting-defaultExtraFlags"
            placeholder="--verbose"
            defaultValue={settings.defaults.extraFlags ?? ''}
            onBlur={(e) => save(patch, { defaults: { extraFlags: e.target.value } })}
          />
        </Field>
      </Group>

      <Group title="Файлы в ответах">
        <Field label="Команда редактора">
          <input
            type="text"
            className="field"
            data-testid="setting-editorCommand"
            maxLength={1000}
            placeholder="code -g {path}:{line}"
            spellCheck={false}
            defaultValue={settings.editorCommand}
            onBlur={(e) => {
              if (e.target.value !== settings.editorCommand) save(patch, { editorCommand: e.target.value })
            }}
          />
        </Field>
        <p className="field-hint">
          Для пункта «Открыть в редакторе» в меню пути. Вместо {'{path}'} встанет файл, вместо {'{line}'} и{' '}
          {'{column}'} — строка и столбец. Пусто — пункта нет.
        </p>
      </Group>
    </>
  )
}
