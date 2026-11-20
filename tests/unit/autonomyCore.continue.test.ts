import { describe, expect, test } from 'vitest'
import { harness, HOUR, MINUTE, type Harness } from './autonomyHarness'
import {
  CRASH_MAX,
  CRASH_WINDOW_MS,
  LIMIT_CONTINUES_MAX,
  LIMIT_FALLBACK_MS,
  LIMIT_JITTER_MS,
  REMOTE_RESUME_CHECK_MS,
  REMOTE_RETRY_MAX,
  REMOTE_RETRY_MS
} from '../../src/core/autonomy/constants'
import type { TabAutonomyRecord } from '../../src/shared/types'

const rejected = (resetsAtMs: number | null, rateLimitType = 'five_hour'): unknown => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    ...(resetsAtMs === null ? {} : { resetsAt: resetsAtMs / 1000 }),
    rateLimitType
  }
})
const allowed = (): unknown => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })
const result = (isError: boolean): unknown => ({
  type: 'result',
  subtype: isError ? 'error_during_execution' : 'success',
  is_error: isError
})
const rateLimitedAnswer = (): unknown => ({
  type: 'assistant',
  error: 'rate_limit',
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text: 'limit' }] }
})

function sdk(h: Harness, message: unknown): void {
  h.core.handle({ type: 'sdk', message })
}

/** A turn that ran into the five-hour limit, resetting in `inMs`. */
function hitLimit(h: Harness, inMs: number | null = HOUR, type?: string): void {
  h.core.handle({ type: 'status', status: 'busy' })
  sdk(h, rejected(inMs === null ? null : h.clock.now() + inMs, type))
  sdk(h, result(true))
  h.core.handle({ type: 'status', status: 'idle' })
}

const continues = (h: Harness): unknown[] => h.commands().filter((c) => c.type === 'sendContinue')

describe('AutonomyCore: падения', () => {
  test('падение во время работы: restartProcess, на processUp — sendContinue crash', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    h.core.handle({ type: 'status', status: 'error' })
    h.clear()
    h.core.handle({ type: 'processDied', cause: 'crash' })
    expect(h.commands()).toEqual([{ type: 'restartProcess' }])
    expect(h.notices()).toEqual([
      { notice: { kind: 'crashRestart', attempt: 1, willContinue: true }, alert: false }
    ])
    h.core.handle({ type: 'status', status: 'starting' })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(h.commands()).toEqual([{ type: 'restartProcess' }, { type: 'sendContinue', reason: 'crash' }])
    // The flag goes with the first process up.
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(continues(h)).toHaveLength(1)
  })

  test('падение в простое: restartProcess без sendContinue', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    h.core.handle({ type: 'status', status: 'idle' })
    h.core.handle({ type: 'status', status: 'error' })
    h.clear()
    h.core.handle({ type: 'processDied', cause: 'crash' })
    expect(h.commands()).toEqual([{ type: 'restartProcess' }])
    expect(h.notices()[0]!.notice).toEqual({ kind: 'crashRestart', attempt: 1, willContinue: false })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(continues(h)).toHaveLength(0)
  })

  test('processUp с carried 2 — без «продолжай»', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'waiting' })
    h.core.handle({ type: 'processDied', cause: 'crash' })
    h.core.handle({ type: 'processUp', carried: 2 })
    expect(h.commands()).toEqual([{ type: 'restartProcess' }])
  })

  test('сообщение человека, пока процесс поднимается, заменяет «продолжай» — и после падения, и при восстановлении', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    // Said while the process was up: a crash later still carries on.
    h.core.handle({ type: 'personActed' })
    h.core.handle({ type: 'processDied', cause: 'crash' })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(continues(h)).toHaveLength(1)
    h.core.handle({ type: 'status', status: 'busy' })
    h.core.handle({ type: 'processDied', cause: 'crash' })
    // Typed while the new process starts (held in its queue, so not carried).
    h.core.handle({ type: 'personActed' })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(continues(h)).toHaveLength(1)

    const r = harness({ record: { working: true } })
    r.core.handle({ type: 'personActed' })
    r.core.handle({ type: 'processUp', carried: 0 })
    expect(continues(r)).toEqual([])
    expect(r.notices().map((n) => n.notice.kind)).not.toContain('restoreContinue')
  })

  test('четвёртое падение за 10 минут: нет restartProcess, crashGaveUp с alert', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    for (let i = 1; i <= CRASH_MAX; i++) {
      h.core.handle({ type: 'status', status: 'busy' })
      h.core.handle({ type: 'processDied', cause: 'crash' })
      h.core.handle({ type: 'processUp', carried: 0 })
      h.clock.advance(2 * MINUTE)
    }
    expect(h.commands().filter((c) => c.type === 'restartProcess')).toHaveLength(3)
    expect(h.notices().map((n) => n.notice)).toEqual([1, 2, 3].map((attempt) => ({
      kind: 'crashRestart',
      attempt,
      willContinue: true
    })))
    h.clear()
    h.core.handle({ type: 'status', status: 'busy' })
    h.core.handle({ type: 'processDied', cause: 'crash' })
    expect(h.commands()).toEqual([])
    expect(h.notices()).toEqual([{ notice: { kind: 'crashGaveUp' }, alert: true }])
    expect(h.core.view.gaveUp).toBe('crashes')
    expect(h.views().at(-1)!.gaveUp).toBe('crashes')
    // A process the person starts again gets no «продолжай» from the core.
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(continues(h)).toHaveLength(0)
    h.core.handle({ type: 'personActed' })
    expect(h.core.view.gaveUp).toBeNull()
  })

  test('падения реже раза в 10 минут не копятся', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    for (let i = 0; i < 4; i++) {
      h.core.handle({ type: 'processDied', cause: 'crash' })
      h.core.handle({ type: 'processUp', carried: 0 })
      h.clock.advance(11 * MINUTE)
    }
    expect(h.commands().filter((c) => c.type === 'restartProcess')).toHaveLength(4)
    expect(h.notices().map((n) => n.notice.kind)).toEqual(Array(4).fill('crashRestart'))
    expect(CRASH_WINDOW_MS).toBe(10 * MINUTE)
  })

  test('cause login: ничего', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    h.clear()
    h.core.handle({ type: 'processDied', cause: 'login' })
    h.core.handle({ type: 'processUp', carried: 0 })
    h.clock.advance(HOUR)
    expect(h.commands()).toEqual([])
    expect(h.notices()).toEqual([])
  })
})

describe('AutonomyCore: лимиты', () => {
  test('лимит: rejected + result is_error — ждёт resetsAt + 60 с, затем sendContinue limit', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    const resetsAt = h.clock.now() + HOUR
    hitLimit(h, HOUR)
    const continueAt = resetsAt + 60_000
    expect(LIMIT_JITTER_MS).toBe(120_000)
    expect(h.core.view.limitWait).toEqual({ resetsAt, continueAt, weekly: false })
    expect(h.notices()).toEqual([
      { notice: { kind: 'limitWait', resetsAt, continueAt, weekly: false }, alert: false }
    ])
    expect(h.persists().at(-1)).toEqual({ working: true, limitUntil: continueAt })
    expect(h.core.record).toEqual({ working: true, limitUntil: continueAt })

    h.clock.advance(continueAt - h.clock.now() - 1)
    expect(continues(h)).toHaveLength(0)
    h.clear()
    h.clock.advance(1)
    expect(h.notices()).toEqual([{ notice: { kind: 'limitOver' }, alert: false }])
    expect(h.commands()).toEqual([{ type: 'sendContinue', reason: 'limit' }])
    expect(h.core.view.limitWait).toBeNull()
    expect(h.core.record).toEqual({ working: true })
    expect(h.persists().at(-1)).toEqual({ working: true })
  })

  test('rejected, но ход успешен (overage) — ожидания нет', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    sdk(h, rejected(h.clock.now() + HOUR))
    sdk(h, result(false))
    expect(h.core.view.limitWait).toBeNull()
    // The turn's signs go with its result: a later failed turn is no limit.
    h.core.handle({ type: 'status', status: 'busy' })
    sdk(h, result(true))
    expect(h.core.view.limitWait).toBeNull()
    // Nor is one where the limit was lifted again before the end.
    sdk(h, rejected(h.clock.now() + HOUR))
    sdk(h, allowed())
    sdk(h, result(true))
    expect(h.core.view.limitWait).toBeNull()
    h.clock.advance(3 * HOUR)
    expect(h.commands()).toEqual([])
  })

  test('assistant error rate_limit без rate_limit_event — ждёт 30 минут', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    sdk(h, rateLimitedAnswer())
    sdk(h, result(true))
    const continueAt = h.clock.now() + LIMIT_FALLBACK_MS
    expect(LIMIT_FALLBACK_MS).toBe(30 * MINUTE)
    expect(h.core.view.limitWait).toEqual({ resetsAt: null, continueAt, weekly: false })
    h.clock.advance(30 * MINUTE - 1)
    expect(continues(h)).toHaveLength(0)
    h.clock.advance(1)
    expect(continues(h)).toEqual([{ type: 'sendContinue', reason: 'limit' }])
  })

  test('сброс уже в прошлом — только разброс', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    sdk(h, rejected(h.clock.now() - MINUTE))
    sdk(h, result(true))
    expect(h.core.view.limitWait!.continueAt).toBe(h.clock.now() + 60_000)
  })

  test('недельный лимит: weekly true, notice с alert', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    const resetsAt = h.clock.now() + 3 * 24 * HOUR
    hitLimit(h, 3 * 24 * HOUR, 'seven_day_opus')
    expect(h.core.view.limitWait).toEqual({ resetsAt, continueAt: resetsAt + 60_000, weekly: true })
    expect(h.notices()).toEqual([
      { notice: { kind: 'limitWait', resetsAt, continueAt: resetsAt + 60_000, weekly: true }, alert: true }
    ])
  })

  test('«Стоп» (personActed) посреди хода с rejected: результат с ошибкой ожидания не начинает', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    sdk(h, rejected(h.clock.now() + HOUR))
    sdk(h, rateLimitedAnswer())
    h.core.handle({ type: 'personActed' })
    sdk(h, result(true))
    h.core.handle({ type: 'status', status: 'idle' })
    expect(h.core.view.limitWait).toBeNull()
    h.clock.advance(3 * HOUR)
    expect(continues(h)).toEqual([])
  })

  test('успешный ход между лимитами обнуляет счёт подряд: пять лимитов — пять продолжений', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    for (let i = 0; i < LIMIT_CONTINUES_MAX + 2; i++) {
      hitLimit(h)
      h.clock.advance(2 * HOUR)
      expect(continues(h)).toHaveLength(i + 1)
      // The «продолжай» turn works for hours before the next limit.
      h.core.handle({ type: 'status', status: 'busy' })
      sdk(h, result(false))
      h.core.handle({ type: 'status', status: 'idle' })
      h.clock.advance(5 * HOUR)
    }
    expect(h.core.view.gaveUp).toBeNull()
    expect(h.notices().map((n) => n.notice.kind)).not.toContain('limitGaveUp')
  })

  test('четвёртый лимит подряд без человека — limitGaveUp; после personActed снова ждёт', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    for (let i = 0; i < LIMIT_CONTINUES_MAX; i++) {
      hitLimit(h)
      h.clock.advance(2 * HOUR)
    }
    expect(continues(h)).toHaveLength(3)
    h.clear()
    hitLimit(h)
    expect(h.notices()).toEqual([{ notice: { kind: 'limitGaveUp' }, alert: true }])
    expect(h.core.view.gaveUp).toBe('limits')
    expect(h.core.view.limitWait).toBeNull()
    expect(h.core.record.working).toBeUndefined()
    expect(h.core.record.limitUntil).toBeUndefined()
    h.clock.advance(3 * HOUR)
    expect(continues(h)).toHaveLength(0)

    h.core.handle({ type: 'personActed' })
    expect(h.core.view.gaveUp).toBeNull()
    hitLimit(h)
    expect(h.core.view.limitWait).not.toBeNull()
    h.clock.advance(2 * HOUR)
    expect(continues(h)).toHaveLength(1)
  })

  test('personActed во время ожидания снимает его, sendContinue не приходит', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    hitLimit(h)
    h.core.handle({ type: 'personActed' })
    expect(h.core.view.limitWait).toBeNull()
    expect(h.core.record.limitUntil).toBeUndefined()
    expect(h.persists().at(-1)).not.toHaveProperty('limitUntil')
    h.clock.advance(3 * HOUR)
    expect(continues(h)).toHaveLength(0)
  })

  test('сон за срок лимита: на systemResumed одна sendContinue', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    hitLimit(h)
    h.clock.jump(5 * HOUR)
    h.core.handle({ type: 'systemResumed' })
    expect(continues(h)).toEqual([{ type: 'sendContinue', reason: 'limit' }])
    h.clock.flush()
    h.clock.advance(HOUR)
    expect(continues(h)).toHaveLength(1)
  })
})

describe('AutonomyCore: признак working', () => {
  test('working: busy ставит, idle снимает, в ожидании лимита остаётся; persist только при изменении', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    expect(h.persists()).toEqual([{ working: true }])
    h.core.handle({ type: 'status', status: 'waiting' })
    h.core.handle({ type: 'status', status: 'busy' })
    expect(h.persists()).toHaveLength(1)
    h.core.handle({ type: 'status', status: 'error' })
    h.core.handle({ type: 'status', status: 'stopped' })
    expect(h.persists()).toHaveLength(1)
    expect(h.core.record).toEqual({ working: true })
    h.core.handle({ type: 'status', status: 'idle' })
    expect(h.persists()).toEqual([{ working: true }, {}])

    hitLimit(h)
    expect(h.core.record.working).toBe(true)
    h.core.handle({ type: 'status', status: 'idle' })
    expect(h.core.record.working).toBe(true)
    const count = h.persists().length
    h.core.handle({ type: 'status', status: 'idle' })
    expect(h.persists()).toHaveLength(count)
  })
})

describe('AutonomyCore: восстановление', () => {
  test('восстановление с working: restoreContinue и sendContinue restore на первом processUp, на втором — нет', () => {
    const h = harness({ record: { working: true } })
    expect(h.out).toEqual([])
    h.core.handle({ type: 'status', status: 'starting' })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(h.notices()).toEqual([{ notice: { kind: 'restoreContinue' }, alert: false }])
    expect(h.commands()).toEqual([{ type: 'sendContinue', reason: 'restore' }])
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(h.commands()).toHaveLength(1)
    expect(h.notices()).toHaveLength(1)
  })

  test('восстановление: idle до первого processUp не стирает working — «продолжай» всё равно уходит', () => {
    const h = harness({ record: { working: true } })
    h.core.handle({ type: 'status', status: 'starting' })
    h.core.handle({ type: 'status', status: 'idle' })
    expect(h.persists()).toEqual([])
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(h.commands()).toEqual([{ type: 'sendContinue', reason: 'restore' }])
  })

  test('восстановление: перенесённые сообщения человека заменяют «продолжай»', () => {
    const h = harness({ record: { working: true } })
    h.core.handle({ type: 'processUp', carried: 1 })
    expect(h.commands()).toEqual([])
  })

  test('чистая сессия вместо неоткрывшейся переписки: «продолжай» нет ни после падения, ни при восстановлении', () => {
    const r = harness({ record: { working: true, limitUntil: 10 * HOUR } })
    r.core.handle({ type: 'processUp', carried: 0, clean: true })
    expect(continues(r)).toEqual([])
    r.clock.advance(24 * HOUR)
    expect(continues(r)).toEqual([])
    expect(r.core.record.limitUntil).toBeUndefined()

    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'status', status: 'busy' })
    h.core.handle({ type: 'processDied', cause: 'crash' })
    h.core.handle({ type: 'processUp', carried: 0, clean: true })
    expect(continues(h)).toEqual([])
  })

  test('без working восстановления нет', () => {
    const h = harness({ record: { remote: true } })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(continues(h)).toEqual([])
  })

  test('восстановление с limitUntil в будущем: «продолжай» не раньше limitUntil и не тратит счёт подряд', () => {
    const start = 1_700_000_000_000
    const limitUntil = start + 20 * MINUTE
    const h = harness({ start, record: { working: true, limitUntil } })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(continues(h)).toEqual([])
    expect(h.core.view.limitWait).toEqual({ resetsAt: null, continueAt: limitUntil, weekly: false })
    expect(h.notices()).toEqual([
      { notice: { kind: 'limitWait', resetsAt: null, continueAt: limitUntil, weekly: false }, alert: false }
    ])
    expect(h.core.record).toEqual({ working: true, limitUntil })
    // Nothing to write: the record is what tabs.json already holds.
    expect(h.persists()).toEqual([])
    h.clock.advance(20 * MINUTE - 1)
    expect(continues(h)).toEqual([])
    h.clock.advance(1)
    expect(continues(h)).toEqual([{ type: 'sendContinue', reason: 'limit' }])
    expect(h.core.record).toEqual({ working: true })

    // The restored wait was already counted before the restart: three more go by themselves.
    for (let i = 0; i < LIMIT_CONTINUES_MAX; i++) {
      hitLimit(h)
      h.clock.advance(2 * HOUR)
    }
    expect(continues(h)).toHaveLength(1 + LIMIT_CONTINUES_MAX)
    hitLimit(h)
    expect(h.core.view.gaveUp).toBe('limits')
  })

  test('восстановление с limitUntil в прошлом — продолжает сразу', () => {
    const start = 1_700_000_000_000
    const h = harness({ start, record: { working: true, limitUntil: start - MINUTE } })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(h.commands()).toEqual([{ type: 'sendContinue', reason: 'restore' }])
    expect(h.core.record).toEqual({ working: true })
    h.clock.advance(HOUR)
    expect(continues(h)).toHaveLength(1)
  })

  test('personQuit снимает working и limitUntil, remote оставляет', () => {
    const h = harness()
    h.core.handle({ type: 'remoteWanted', wanted: true })
    h.core.handle({ type: 'processUp', carried: 0 })
    hitLimit(h)
    expect(h.core.record).toEqual({ remote: true, working: true, limitUntil: expect.any(Number) })
    h.core.handle({ type: 'personQuit' })
    expect(h.core.record).toEqual({ remote: true })
    expect(h.persists().at(-1)).toEqual({ remote: true })
  })
})

describe('AutonomyCore: Remote Control', () => {
  const failed = (problem?: string, blocked?: 'cli'): Parameters<Harness['core']['handle']>[0] => ({
    type: 'remote',
    info: { state: 'failed', ...(problem ? { problem } : {}), ...(blocked ? { blocked } : {}) }
  })
  const enables = (h: Harness): number => h.commands().filter((c) => c.type === 'enableRemote').length

  test('remoteWanted пишет remote в запись', () => {
    const h = harness()
    h.core.handle({ type: 'remoteWanted', wanted: true })
    expect(h.persists()).toEqual([{ remote: true }])
    h.core.handle({ type: 'remoteWanted', wanted: true })
    expect(h.persists()).toHaveLength(1)
    h.core.handle({ type: 'remoteWanted', wanted: false })
    expect(h.persists()).toEqual([{ remote: true }, {}])
  })

  test('remote в записи: enableRemote на каждом processUp', () => {
    const h = harness({ record: { remote: true } })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(h.commands()).toEqual([{ type: 'enableRemote' }])
    // The first start after a plain launch says nothing; a restarted session does.
    expect(h.notices()).toEqual([])
    h.core.handle({ type: 'processDied', cause: 'login' })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(enables(h)).toBe(2)
    expect(h.notices()).toEqual([{ notice: { kind: 'remoteAgain' }, alert: false }])
  })

  test('remote в записи при восстановлении: notice и на первом подъёме', () => {
    const h = harness({ record: { remote: true, working: true } })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(h.commands()).toEqual([{ type: 'enableRemote' }, { type: 'sendContinue', reason: 'restore' }])
    expect(h.notices().map((n) => n.notice.kind)).toEqual(['remoteAgain', 'restoreContinue'])
  })

  test('без remote в записи RC не включается', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle(failed('нет сети'))
    h.clock.advance(HOUR)
    expect(enables(h)).toBe(0)
  })

  test('мост failed: повтор через 60 с, не больше 3, затем remoteGaveUp; on обнуляет счёт', () => {
    const h = harness({ record: { remote: true } })
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(enables(h)).toBe(1)
    for (let i = 1; i <= REMOTE_RETRY_MAX; i++) {
      h.core.handle(failed('нет сети'))
      h.clock.advance(REMOTE_RETRY_MS - 1)
      expect(enables(h)).toBe(i)
      h.clock.advance(1)
      expect(enables(h)).toBe(i + 1)
    }
    expect(h.notices()).toEqual([])
    h.core.handle(failed('нет сети'))
    expect(h.notices()).toEqual([{ notice: { kind: 'remoteGaveUp', problem: 'нет сети' }, alert: true }])
    h.clock.advance(HOUR)
    expect(enables(h)).toBe(1 + REMOTE_RETRY_MAX)
    // Said once, not on every further failure.
    h.core.handle(failed('нет сети'))
    expect(h.notices()).toHaveLength(1)

    h.core.handle({ type: 'remote', info: { state: 'on', url: 'https://claude.ai/code/x' } })
    h.core.handle({ type: 'remote', info: { state: 'off', problem: 'мост закрыт' } })
    h.clock.advance(REMOTE_RETRY_MS)
    expect(enables(h)).toBe(2 + REMOTE_RETRY_MAX)
  })

  test('off без problem — не сбой, повтора нет', () => {
    const h = harness({ record: { remote: true } })
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'remote', info: { state: 'off' } })
    h.clock.advance(HOUR)
    expect(enables(h)).toBe(1)
  })

  test('remoteGaveUp без problem', () => {
    const h = harness({ record: { remote: true } })
    h.core.handle({ type: 'processUp', carried: 0 })
    for (let i = 0; i <= REMOTE_RETRY_MAX; i++) {
      h.core.handle(failed())
      h.clock.advance(REMOTE_RETRY_MS)
    }
    expect(h.notices()).toEqual([{ notice: { kind: 'remoteGaveUp' }, alert: true }])
  })

  test('blocked: повторов нет', () => {
    const h = harness({ record: { remote: true } })
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle(failed('этот Claude Code не умеет', 'cli'))
    h.clock.advance(HOUR)
    expect(enables(h)).toBe(1)
    expect(h.notices()).toEqual([])
  })

  test('мёртвый процесс: повтор не идёт', () => {
    const h = harness({ record: { remote: true } })
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle(failed('нет сети'))
    h.core.handle({ type: 'processDied', cause: 'login' })
    h.clock.advance(HOUR)
    expect(enables(h)).toBe(1)
  })

  test('systemResumed: через 30 с enableRemote, если мост off; если on — нет', () => {
    const off = harness({ record: { remote: true } })
    off.core.handle({ type: 'processUp', carried: 0 })
    off.core.handle({ type: 'remote', info: { state: 'off' } })
    off.core.handle({ type: 'systemResumed' })
    off.clock.advance(REMOTE_RESUME_CHECK_MS - 1)
    expect(enables(off)).toBe(1)
    off.clock.advance(1)
    expect(enables(off)).toBe(2)
    expect(REMOTE_RESUME_CHECK_MS).toBe(30_000)

    const on = harness({ record: { remote: true } })
    on.core.handle({ type: 'processUp', carried: 0 })
    on.core.handle({ type: 'remote', info: { state: 'on' } })
    on.core.handle({ type: 'systemResumed' })
    on.clock.advance(HOUR)
    expect(enables(on)).toBe(1)

    // The bridge dropped after waking but before the check: the check sees it.
    const late = harness({ record: { remote: true } })
    late.core.handle({ type: 'processUp', carried: 0 })
    late.core.handle({ type: 'remote', info: { state: 'on' } })
    late.core.handle({ type: 'systemResumed' })
    late.core.handle({ type: 'remote', info: { state: 'reconnecting' } })
    late.core.handle({ type: 'remote', info: { state: 'off' } })
    late.clock.advance(REMOTE_RESUME_CHECK_MS)
    expect(enables(late)).toBe(2)
  })

  test('systemResumed без remote в записи — ничего', () => {
    const h = harness()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'remote', info: { state: 'off' } })
    h.core.handle({ type: 'systemResumed' })
    h.clock.advance(HOUR)
    expect(enables(h)).toBe(0)
  })
})

describe('AutonomyCore: запись', () => {
  test('record — копия, а не живое состояние', () => {
    const record: TabAutonomyRecord = { remote: true }
    const h = harness({ record })
    const copy = h.core.record
    copy.working = true
    expect(h.core.record).toEqual({ remote: true })
    h.core.handle({ type: 'status', status: 'busy' })
    expect(record).toEqual({ remote: true })
  })
})
