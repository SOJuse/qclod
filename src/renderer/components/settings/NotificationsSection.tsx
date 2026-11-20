import { Group, save, Toggle } from './parts'
import type { SettingsSectionProps } from './types'

export function NotificationsSection({ settings, patch }: SettingsSectionProps): JSX.Element {
  return (
    <Group>
      <Toggle
        id="notificationsEnabled"
        label="Сообщать, когда агент закончил или ждёт ответа"
        checked={settings.notificationsEnabled}
        onChange={(notificationsEnabled) => save(patch, { notificationsEnabled })}
      />
      <Toggle
        id="soundEnabled"
        label="Со звуком"
        checked={settings.soundEnabled}
        onChange={(soundEnabled) => save(patch, { soundEnabled })}
      />
    </Group>
  )
}
