import type { AppSettings, SessionStatus } from '../shared/types'

export interface NotificationInput {
  status: SessionStatus
  tabTitle: string
  isWindowFocused: boolean
  settings: AppSettings
}

export interface NotificationPlan {
  title: string
  body: string
  silent: boolean
}

/** States worth interrupting someone for. */
function worthTelling(status: SessionStatus): boolean {
  return status === 'idle' || status === 'waiting' || status === 'error'
}

/**
 * Decides whether a status change deserves the user's attention, and what to
 * say. Nothing is announced while they are looking at the window.
 */
export function notificationFor(input: NotificationInput): NotificationPlan | null {
  if (input.isWindowFocused) return null
  if (!input.settings.notificationsEnabled) return null
  if (!worthTelling(input.status)) return null

  const body =
    input.status === 'waiting'
      ? 'Агент ждёт вашего ответа'
      : input.status === 'error'
        ? 'Сессия прервалась'
        : 'Агент закончил работу'

  return {
    title: `Qclod · ${input.tabTitle}`,
    body,
    silent: !input.settings.soundEnabled
  }
}

/**
 * Shows the notification, if the state deserves one. Clicking it brings the
 * tab that caused it to the front — a notification you cannot act on is noise.
 */
export function notifyIfNeeded(input: {
  settings: AppSettings
  tab: { title: string }
  status: SessionStatus
  isActive: boolean
  onActivate: () => void
}): void {
  const plan = notificationFor({
    status: input.status,
    tabTitle: input.tab.title,
    isWindowFocused: input.isActive,
    settings: input.settings
  })
  if (!plan) return

  const { Notification } = require('electron') as typeof import('electron')
  if (!Notification.isSupported()) return

  const notification = new Notification(plan)
  notification.on('click', input.onActivate)
  notification.show()
}
