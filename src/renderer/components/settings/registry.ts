import { createElement } from 'react'
import type { SettingsSectionDef } from './types'
import { AboutSection } from './AboutSection'
import { AgentSection } from './AgentSection'
import { AutonomySection } from './AutonomySection'
import { NotificationsSection } from './NotificationsSection'
import { PermissionsSection } from './PermissionsSection'
import { ServersSection } from './ServersSection'
import { WindowSection } from './WindowSection'
import { VoiceSection } from './VoiceSection'
import { VpnSection } from './VpnSection'
import { isWindows } from '../../voice/platform'

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
  // 1.0.1: vpn
  { id: 'vpn', title: 'VPN', order: 45, Component: () => createElement(VpnSection) },
  // Voice is Windows-only in 1.0 (G11): isWindows() is window.qclod.platform === 'win32'.

  ...(isWindows() ? [{ id: 'voice', title: 'Голос', order: 50, Component: () => createElement(VoiceSection) }] : []),
  { id: 'servers', title: 'Серверы', order: 60, Component: ServersSection },
  { id: 'about', title: 'О программе', order: 90, Component: AboutSection }
]

/** By `order`, then by title; the list given is not changed. */
export function sortedSections(list: SettingsSectionDef[] = SETTINGS_SECTIONS): SettingsSectionDef[] {
  return [...list].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'ru'))
}
