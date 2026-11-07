import type { AppSettings } from '../shared/types'
import { mayNotify, type StatusState } from './sessions/sessionStatus'

export interface NotificationInput {
  state: StatusState
  tabTitle: string
  isWindowFocused: boolean
  settings: AppSettings
}

export interface NotificationPlan {
  title: string
  body: string
  silent: boolean
}

/**
 * Decides whether a status change deserves the user's attention, and what to
 * say. Nothing is announced while they are looking at the window, and nothing
 * is announced from a guessed status (see mayNotify).
 */
export function notificationFor(input: NotificationInput): NotificationPlan | null {
  if (input.isWindowFocused) return null
  if (!input.settings.notificationsEnabled) return null
  if (!mayNotify(input.state)) return null

  const waiting = input.state.status === 'waiting'
  return {
    title: `Qclod · ${input.tabTitle}`,
    body: waiting ? 'Агент ждёт вашего ответа' : 'Агент закончил работу',
    silent: !input.settings.soundEnabled
  }
}
