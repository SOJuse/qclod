import { describe, expect, test } from 'vitest'
import { TICK_MAX_MS } from '../../src/core/autonomy/constants'
import { harness, HOUR, MINUTE, type Harness } from './autonomyHarness'

const QUESTION = [{ question: 'Продолжить?', options: ['Да (Recommended)', 'Нет'], multiSelect: false }]

function inAutoAllow(): Harness {
  const h = harness()
  h.core.handle({ type: 'mode', mode: 'autoAllow' })
  return h
}

describe('AutonomyCore: авто-ответы по таймеру', () => {
  test('вопрос в авто-да: через 5 минут answerQuestion с рекомендованным', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.clock.advance(299_999)
    expect(h.commands()).toEqual([])
    h.clock.advance(1)
    expect(h.commands()).toEqual([
      { type: 'answerQuestion', cardId: 'toolu_1', answers: { 'Продолжить?': 'Да (Recommended)' } }
    ])
    // The card is closed in the core at once: no second answer, no timer left.
    expect(h.core.view.timers).toEqual([])
    h.core.handle({ type: 'waitClosed', cardId: 'toolu_1', by: 'auto' })
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(1)
  })

  test('новый процесс: старых карточек у него нет — таймеры прежних не заводятся заново', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'processUp', carried: 0 })
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.core.handle({ type: 'planOpened', cardId: 'plan_1' })
    expect(h.core.view.timers).toHaveLength(2)
    // «Начать заново»: the old process is gone without its waitClosed reaching the core.
    h.core.handle({ type: 'processUp', carried: 0 })
    expect(h.core.view.timers).toEqual([])
    h.core.handle({ type: 'mode', mode: 'default' })
    h.core.handle({ type: 'mode', mode: 'autoAllow' })
    expect(h.core.view.timers).toEqual([])
    h.clock.advance(HOUR)
    expect(h.commands()).toEqual([])
  })

  test('вне авто-да таймер не заводится', () => {
    const h = harness()
    h.core.handle({ type: 'mode', mode: 'default' })
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.core.handle({ type: 'planOpened', cardId: 'plan_1' })
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(0)
    expect(h.core.view.timers).toEqual([])
    expect(h.views().every((v) => v.timers.length === 0)).toBe(true)
  })

  test('выход из авто-да снимает таймер, вход заводит заново с этого момента', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.clock.advance(4 * MINUTE)
    h.core.handle({ type: 'mode', mode: 'acceptEdits' })
    expect(h.core.view.timers).toEqual([])
    h.clock.advance(10 * MINUTE)
    expect(h.commands()).toHaveLength(0)

    const enteredAt = h.clock.now()
    h.core.handle({ type: 'mode', mode: 'autoAllow' })
    expect(h.core.view.timers.map((t) => t.deadline)).toEqual([enteredAt + 5 * MINUTE])
    h.clock.advance(5 * MINUTE - 1)
    expect(h.commands()).toHaveLength(0)
    h.clock.advance(1)
    expect(h.commands()).toHaveLength(1)
  })

  test('hold снимает таймер насовсем', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.core.handle({ type: 'hold', cardId: 'toolu_1' })
    expect(h.core.view.timers).toEqual([])
    // Not even a way out and back into «авто-да» brings it back.
    h.core.handle({ type: 'mode', mode: 'default' })
    h.core.handle({ type: 'mode', mode: 'autoAllow' })
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(0)
    expect(h.core.view.timers).toEqual([])
  })

  test('answerNow после hold ничего не делает', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.core.handle({ type: 'hold', cardId: 'toolu_1' })
    h.core.handle({ type: 'answerNow', cardId: 'toolu_1' })
    expect(h.commands()).toHaveLength(0)
  })

  test('answerNow при идущем таймере отвечает сразу', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.clock.advance(MINUTE)
    h.core.handle({ type: 'answerNow', cardId: 'toolu_1' })
    expect(h.commands()).toEqual([
      { type: 'answerQuestion', cardId: 'toolu_1', answers: { 'Продолжить?': 'Да (Recommended)' } }
    ])
    expect(h.core.view.timers).toEqual([])
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(1)
    // An unknown card is nothing to answer.
    h.core.handle({ type: 'answerNow', cardId: 'nope' })
    expect(h.commands()).toHaveLength(1)
  })

  test('answerNow вне авто-да ничего не делает', () => {
    const h = harness()
    h.core.handle({ type: 'mode', mode: 'default' })
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.core.handle({ type: 'answerNow', cardId: 'toolu_1' })
    expect(h.commands()).toHaveLength(0)
  })

  test('waitClosed elsewhere снимает таймер — ответ с телефона побеждает', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.clock.advance(4 * MINUTE)
    h.core.handle({ type: 'waitClosed', cardId: 'toolu_1', by: 'elsewhere' })
    expect(h.core.view.timers).toEqual([])
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(0)
  })

  test('план в авто-да одобряется по тому же таймеру', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'planOpened', cardId: 'plan_1' })
    expect(h.core.view.timers).toEqual([
      { cardId: 'plan_1', kind: 'plan', deadline: h.clock.now() + 5 * MINUTE, label: 'Qclod одобрит план' }
    ])
    h.clock.advance(5 * MINUTE)
    expect(h.commands()).toEqual([{ type: 'approvePlan', cardId: 'plan_1' }])
  })

  test('view: deadline и label «Qclod выберет «Да»» без суффикса', () => {
    const h = inAutoAllow()
    const openedAt = h.clock.now()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    const expected = [
      { cardId: 'toolu_1', kind: 'question', deadline: openedAt + 5 * MINUTE, label: 'Qclod выберет «Да»' }
    ]
    expect(h.core.view.timers).toEqual(expected)
    expect(h.views().at(-1)!.timers).toEqual(expected)

    // Several questions: «; » between them, «, » inside a multiple choice.
    h.core.handle({
      type: 'questionOpened',
      cardId: 'toolu_2',
      questions: [
        { question: 'A?', options: ['Один', 'Два (Recommended)'], multiSelect: false },
        { question: 'B?', options: ['x (Recommended)', 'y', 'z (Рекомендуется)'], multiSelect: true }
      ]
    })
    expect(h.core.view.timers[1]!.label).toBe('Qclod выберет «Два; x, z»')
  })

  test('каждое изменение таймеров — событие view', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    expect(h.views()).toHaveLength(1)
    h.core.handle({ type: 'hold', cardId: 'toolu_1' })
    expect(h.views()).toHaveLength(2)
    expect(h.views()[1]!.timers).toEqual([])
    // Nothing changed — nothing said.
    h.core.handle({ type: 'hold', cardId: 'toolu_1' })
    expect(h.views()).toHaveLength(2)
  })

  test('сон: часы прыгнули на 2 часа за срок — на systemResumed ровно одна команда', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.core.handle({ type: 'planOpened', cardId: 'plan_1' })
    h.clock.jump(2 * HOUR)
    h.core.handle({ type: 'systemResumed' })
    expect(h.commands()).toEqual([
      { type: 'answerQuestion', cardId: 'toolu_1', answers: { 'Продолжить?': 'Да (Recommended)' } },
      { type: 'approvePlan', cardId: 'plan_1' }
    ])
    // The timer that was waiting when the machine went to sleep fires late: still nothing more.
    h.clock.flush()
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(2)
  })

  test('сон без systemResumed: срок исполняется на следующем тике, один раз', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.clock.jump(2 * HOUR)
    h.clock.flush()
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(1)
  })

  test('новое число минут не трогает уже заведённые таймеры', () => {
    let minutes = 5
    const h = harness({ autoAnswerMs: () => minutes * MINUTE })
    h.core.handle({ type: 'mode', mode: 'autoAllow' })
    const t0 = h.clock.now()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    minutes = 1
    h.core.handle({ type: 'planOpened', cardId: 'plan_1' })
    expect(h.core.view.timers.map((t) => [t.cardId, t.deadline])).toEqual([
      ['toolu_1', t0 + 5 * MINUTE],
      ['plan_1', t0 + MINUTE]
    ])
    h.clock.advance(MINUTE)
    expect(h.commands()).toEqual([{ type: 'approvePlan', cardId: 'plan_1' }])
    h.clock.advance(4 * MINUTE - 1)
    expect(h.commands()).toHaveLength(1)
    h.clock.advance(1)
    expect(h.commands()).toHaveLength(2)
  })

  test('таймер не дальше 60 с: setTimer никогда не получает ms > 60000', () => {
    const h = harness({ autoAnswerMs: () => 60 * MINUTE })
    h.core.handle({ type: 'mode', mode: 'autoAllow' })
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.clock.advance(2 * HOUR)
    expect(h.commands()).toHaveLength(1)
    expect(h.clock.requested.length).toBeGreaterThan(1)
    expect(Math.max(...h.clock.requested)).toBeLessThanOrEqual(TICK_MAX_MS)
    expect(TICK_MAX_MS).toBe(60_000)
    expect(Math.min(...h.clock.requested)).toBeGreaterThanOrEqual(0)
  })

  test('процесс умер — открытые карточки уходят вместе с ним', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.core.handle({ type: 'processDied', cause: 'login' })
    expect(h.core.view.timers).toEqual([])
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(0)
  })

  test('dispose снимает таймер часов', () => {
    const h = inAutoAllow()
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_1', questions: QUESTION })
    h.core.dispose()
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(0)
    h.core.handle({ type: 'questionOpened', cardId: 'toolu_2', questions: QUESTION })
    h.clock.advance(HOUR)
    expect(h.commands()).toHaveLength(0)
  })
})
