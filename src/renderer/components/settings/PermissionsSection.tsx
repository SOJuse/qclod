import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { reasonOf, StateView } from '../../ui/StateView'
import { Group, retryIn } from './parts'
import type { SettingsSectionProps } from './types'

interface PermissionRuleView {
  id: string
  toolName: string
  target?: string
}

export function PermissionsSection(_props: SettingsSectionProps): JSX.Element {
  const [rules, setRules] = useState<PermissionRuleView[]>([])
  const [rulesError, setRulesError] = useState<string | null>(null)

  const loadRules = useCallback((): void => {
    setRulesError(null)
    window.qclod.permissionRules().then(setRules, (err) => setRulesError(reasonOf(err)))
  }, [])
  useEffect(() => {
    loadRules()
  }, [loadRules])

  return (
    <Group title="Разрешено без вопросов">
      {rulesError !== null ? (
        <StateView
          kind="error"
          testId="rules-error"
          title="Не удалось прочитать правила"
          hint={rulesError}
          action={{ label: 'Повторить', onClick: retryIn(loadRules) }}
        />
      ) : rules.length === 0 ? (
        <p className="field-hint" data-testid="rules-empty">
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
                className="btn btn-ghost btn-sm"
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
      <p className="field-hint">Правила живут в хранилище Qclod. В папке вашего проекта ничего не меняется.</p>
    </Group>
  )
}
