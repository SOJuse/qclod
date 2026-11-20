import type { SettingsSectionDef } from './types'
import { AboutSection } from './AboutSection'
import { AgentSection } from './AgentSection'
import { AutonomySection } from './AutonomySection'
import { NotificationsSection } from './NotificationsSection'
import { PermissionsSection } from './PermissionsSection'
import { WindowSection } from './WindowSection'

/**
 * Every section of the settings screen, one line each. Stages 3, 5 and 6 add theirs here:
 *   autonomy «Автономность» 35, voice «Голос» 50, servers «Серверы» 60.
 * A section without props of its own is wrapped: `Component: () => <VoiceSection />`.
 */
export const SETTINGS_SECTIONS: SettingsSectionDef[] = [
  { id: 'window', title: 'Окно', order: 10, Component: WindowSection },
  { id: 'notifications', title: 'Уведомления', order: 20, Component: NotificationsSection },
  { id: 'agent', title: 'Запуск агента', order: 30, Component: AgentSection },
  { id: 'autonomy', title: 'Автономность', order: 35, Component: AutonomySection },
  { id: 'permissions', title: 'Разрешения', order: 40, Component: PermissionsSection },
  { id: 'about', title: 'О программе', order: 90, Component: AboutSection }
]

/** By `order`, then by title; the list given is not changed. */
export function sortedSections(list: SettingsSectionDef[] = SETTINGS_SECTIONS): SettingsSectionDef[] {
  return [...list].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'))
}
