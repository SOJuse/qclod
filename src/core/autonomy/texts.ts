import { CRASH_MAX, LIMIT_CONTINUES_MAX } from './constants'
import type { AutonomyNotice } from './types'

/**
 * Formatters are made on each call: the time zone is the machine's where the
 * text is shown, and it can change while Qclod runs.
 */
function clock(ms: number): string {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(ms)
}

/** «пн, 24 ноября, 12:00» */
function dayAndClock(ms: number): string {
  const day = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' }).format(ms)
  return `${day}, ${clock(ms)}`
}

const CRASH_COUNT = `из ${CRASH_MAX} за 10 минут`

/**
 * What a notice says, in Russian. The core sends structure, not text; each
 * host calls this where the text is shown.
 */
export function noticeText(n: AutonomyNotice): string {
  switch (n.kind) {
    case 'crashRestart':
      return n.willContinue
        ? `Агент упал — перезапускаю вкладку и продолжаю (перезапуск ${n.attempt} ${CRASH_COUNT}).`
        : `Агент упал — перезапускаю вкладку (перезапуск ${n.attempt} ${CRASH_COUNT}).`
    case 'crashGaveUp':
      return 'Агент упал в четвёртый раз за 10 минут. Qclod больше не перезапускает его сам.'
    case 'limitWait':
      if (n.resetsAt === null) {
        return `Лимит подписки исчерпан, время сброса неизвестно — Qclod попробует продолжить в ${clock(n.continueAt)}.`
      }
      if (n.weekly) {
        return `Недельный лимит исчерпан. Сброс ${dayAndClock(n.resetsAt)} — Qclod подождёт и продолжит сам.`
      }
      return `Лимит подписки исчерпан. Сброс в ${clock(n.resetsAt)} — Qclod продолжит сам около ${clock(n.continueAt)}.`
    case 'limitOver':
      return 'Лимит сброшен — продолжаю.'
    case 'limitGaveUp':
      return `Лимит кончился снова. Qclod уже продолжал ${LIMIT_CONTINUES_MAX} раза подряд без вас и больше сам не продолжит.`
    case 'restoreContinue':
      return 'Qclod перезапустился, пока агент работал, — продолжаю.'
    case 'remoteAgain':
      return 'Включаю Remote Control снова — сессия перезапущена.'
    case 'remoteGaveUp':
      return n.problem
        ? `Remote Control не включается: ${n.problem}. Включите его вручную, когда связь вернётся.`
        : 'Remote Control не включается. Включите его вручную, когда связь вернётся.'
  }
}
