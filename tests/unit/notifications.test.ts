import { describe, expect, test } from 'vitest'
import { notificationFor } from '@main/notifications'
import { DEFAULT_SETTINGS } from '@main/store/settingsStore'

const base = {
  tabTitle: 'мой проект',
  isWindowFocused: false,
  settings: DEFAULT_SETTINGS
}

describe('notificationFor', () => {
  test('окно в фокусе — уведомления нет', () => {
    expect(
      notificationFor({ ...base, isWindowFocused: true, state: { status: 'idle', degraded: false } })
    ).toBeNull()
  })

  test('окно не в фокусе и статус waiting — уведомление есть', () => {
    const note = notificationFor({ ...base, state: { status: 'waiting', degraded: false } })
    expect(note).not.toBeNull()
    expect(note?.title).toContain('мой проект')
    expect(note?.silent).toBe(false)
  })

  test('завершение работы тоже уведомляет', () => {
    expect(notificationFor({ ...base, state: { status: 'idle', degraded: false } })).not.toBeNull()
  })

  test('уведомления выключены в настройках — уведомления нет', () => {
    expect(
      notificationFor({
        ...base,
        settings: { ...DEFAULT_SETTINGS, notificationsEnabled: false },
        state: { status: 'waiting', degraded: false }
      })
    ).toBeNull()
  })

  test('звук выключен — уведомление беззвучное', () => {
    const note = notificationFor({
      ...base,
      settings: { ...DEFAULT_SETTINGS, soundEnabled: false },
      state: { status: 'waiting', degraded: false }
    })
    expect(note?.silent).toBe(true)
  })

  test('статус busy уведомления не рождает', () => {
    expect(notificationFor({ ...base, state: { status: 'busy', degraded: false } })).toBeNull()
  })

  test('оценочный статус не уведомляет', () => {
    expect(notificationFor({ ...base, state: { status: 'idle', degraded: true } })).toBeNull()
  })

  test('текст отличает ожидание от завершения', () => {
    const waiting = notificationFor({ ...base, state: { status: 'waiting', degraded: false } })
    const idle = notificationFor({ ...base, state: { status: 'idle', degraded: false } })
    expect(waiting?.body).not.toBe(idle?.body)
  })
})
