import { describe, expect, test } from 'vitest'

// The machine's time zone is what the texts use; the test fixes it before
// texts.ts is even loaded (a static import would be hoisted above this line).
process.env.TZ = 'Europe/Moscow'
const { noticeText } = await import('../../src/core/autonomy/texts')

/** Monday, 23 November 2026, 14:05 in Moscow. */
const resetsAt = Date.UTC(2026, 10, 23, 11, 5)
/** 14:07 in Moscow. */
const continueAt = Date.UTC(2026, 10, 23, 11, 7)
/** Tuesday, 24 November 2026, 12:00 in Moscow. */
const weeklyReset = Date.UTC(2026, 10, 24, 9, 0)

describe('noticeText', () => {
  test('падения', () => {
    expect(noticeText({ kind: 'crashRestart', attempt: 2, willContinue: true })).toBe(
      'Агент упал — перезапускаю вкладку и продолжаю (перезапуск 2 из 3 за 10 минут).'
    )
    expect(noticeText({ kind: 'crashRestart', attempt: 1, willContinue: false })).toBe(
      'Агент упал — перезапускаю вкладку (перезапуск 1 из 3 за 10 минут).'
    )
    expect(noticeText({ kind: 'crashGaveUp' })).toBe(
      'Агент упал в четвёртый раз за 10 минут. Qclod больше не перезапускает его сам.'
    )
  })

  test('лимиты', () => {
    expect(noticeText({ kind: 'limitWait', resetsAt, continueAt, weekly: false })).toBe(
      'Лимит подписки исчерпан. Сброс в 14:05 — Qclod продолжит сам около 14:07.'
    )
    expect(
      noticeText({ kind: 'limitWait', resetsAt: weeklyReset, continueAt: weeklyReset + 60_000, weekly: true })
    ).toBe('Недельный лимит исчерпан. Сброс вт, 24 ноября, 12:00 — Qclod подождёт и продолжит сам.')
    expect(noticeText({ kind: 'limitWait', resetsAt: null, continueAt, weekly: false })).toBe(
      'Лимит подписки исчерпан, время сброса неизвестно — Qclod попробует продолжить в 14:07.'
    )
    expect(noticeText({ kind: 'limitWait', resetsAt: null, continueAt, weekly: true })).toBe(
      'Лимит подписки исчерпан, время сброса неизвестно — Qclod попробует продолжить в 14:07.'
    )
    expect(noticeText({ kind: 'limitOver' })).toBe('Лимит сброшен — продолжаю.')
    expect(noticeText({ kind: 'limitGaveUp' })).toBe(
      'Лимит кончился снова. Qclod уже продолжал 3 раза подряд без вас и больше сам не продолжит.'
    )
  })

  test('восстановление и Remote Control', () => {
    expect(noticeText({ kind: 'restoreContinue' })).toBe('Qclod перезапустился, пока агент работал, — продолжаю.')
    expect(noticeText({ kind: 'remoteAgain' })).toBe('Включаю Remote Control снова — сессия перезапущена.')
    expect(noticeText({ kind: 'remoteGaveUp', problem: 'нет связи с сервером' })).toBe(
      'Remote Control не включается: нет связи с сервером. Включите его вручную, когда связь вернётся.'
    )
    expect(noticeText({ kind: 'remoteGaveUp' })).toBe(
      'Remote Control не включается. Включите его вручную, когда связь вернётся.'
    )
  })

  test('время — в часовом поясе машины', () => {
    process.env.TZ = 'Asia/Tokyo'
    try {
      expect(noticeText({ kind: 'limitWait', resetsAt: null, continueAt, weekly: false })).toContain('в 20:07.')
    } finally {
      process.env.TZ = 'Europe/Moscow'
    }
  })
})
