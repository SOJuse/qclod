import { useCallback, useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { HotkeyRegistration } from '../../../shared/types'
import { reasonOf, StateView } from '../../ui/StateView'
import { Field, Group, retryIn, save, Toggle } from './parts'
import type { SettingsSectionProps } from './types'

export function WindowSection({ settings, patch }: SettingsSectionProps): JSX.Element {
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyRegistration | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)

  const loadHotkey = useCallback((): void => {
    setHotkeyError(null)
    window.qclod.hotkeyStatus().then(setHotkeyStatus, (err) => setHotkeyError(reasonOf(err)))
  }, [])
  useEffect(() => {
    loadHotkey()
  }, [settings.globalHotkey, loadHotkey])

  return (
    <Group>
      <Field label="Вызов из любого места">
        <input
          type="text"
          className="field"
          data-testid="setting-globalHotkey"
          defaultValue={settings.globalHotkey}
          onBlur={(e) => save(patch, { globalHotkey: e.target.value })}
        />
      </Field>
      {hotkeyError !== null ? (
        <StateView
          kind="error"
          testId="hotkey-status-error"
          title="Не удалось проверить сочетание"
          hint={hotkeyError}
          action={{ label: 'Повторить', onClick: retryIn(loadHotkey) }}
        />
      ) : (
        hotkeyStatus &&
        !hotkeyStatus.ok && (
          <p className="settings-warning" data-testid="hotkey-warning">
            <TriangleAlert size={14} aria-hidden="true" />
            {hotkeyStatus.reason}
          </p>
        )
      )}
      <Toggle
        id="closeToTray"
        label="Закрытие окна сворачивает в трей"
        checked={settings.closeToTray}
        onChange={(closeToTray) => save(patch, { closeToTray })}
      />
    </Group>
  )
}
