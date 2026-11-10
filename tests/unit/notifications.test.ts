import { describe, expect, test } from 'vitest'
import { notificationFor, shouldRaiseWindowForPermission } from '@main/notifications'
import { DEFAULT_SETTINGS } from '@main/store/settingsStore'

const base = {
  tabTitle: 'мой проект',
  isWindowFocused: false,
  settings: DEFAULT_SETTINGS
}

describe('notificationFor', () => {
  test('окно в фокусе — уведомления нет', () => {
    expect(notificationFor({ ...base, isWindowFocused: true, status: 'idle' })).toBeNull()
  })

  test('агент ждёт ответа — уведомление есть и звучит', () => {
    const note = notificationFor({ ...base, status: 'waiting' })
    expect(note?.title).toContain('мой проект')
    expect(note?.silent).toBe(false)
  })

  test('агент закончил — уведомление есть', () => {
    expect(notificationFor({ ...base, status: 'idle' })).not.toBeNull()
  })

  test('сессия прервалась — тоже сообщаем', () => {
    // Silence here would leave the user waiting for an answer that will never
    // come.
    expect(notificationFor({ ...base, status: 'error' })?.body).toContain('прерв')
  })

  test('уведомления выключены — ничего', () => {
    expect(
      notificationFor({
        ...base,
        settings: { ...DEFAULT_SETTINGS, notificationsEnabled: false },
        status: 'waiting'
      })
    ).toBeNull()
  })

  test('звук выключен — уведомление беззвучное', () => {
    const note = notificationFor({
      ...base,
      settings: { ...DEFAULT_SETTINGS, soundEnabled: false },
      status: 'waiting'
    })
    expect(note?.silent).toBe(true)
  })

  test('работа и запуск уведомления не рождают', () => {
    expect(notificationFor({ ...base, status: 'busy' })).toBeNull()
    expect(notificationFor({ ...base, status: 'starting' })).toBeNull()
    expect(notificationFor({ ...base, status: 'stopped' })).toBeNull()
  })

  test('текст отличает ожидание от завершения', () => {
    const waiting = notificationFor({ ...base, status: 'waiting' })
    const idle = notificationFor({ ...base, status: 'idle' })
    expect(waiting?.body).not.toBe(idle?.body)
  })
})

describe('shouldRaiseWindowForPermission', () => {
  test('вкладка запроса активна — окно показывается', () => {
    expect(shouldRaiseWindowForPermission('t1', 't1')).toBe(true)
  })

  test('фоновая вкладка — окно не всплывает, остаются бейдж и уведомление', () => {
    expect(shouldRaiseWindowForPermission('t1', 't2')).toBe(false)
  })

  test('активной вкладки нет — не всплывает', () => {
    expect(shouldRaiseWindowForPermission(null, 't2')).toBe(false)
  })
})
