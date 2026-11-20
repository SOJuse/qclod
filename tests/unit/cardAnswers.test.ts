import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cardAnswers } from '../../src/renderer/chat/cardAnswers'

const calls: Array<[string, ...unknown[]]> = []

beforeEach(() => {
  calls.length = 0
  const record =
    (name: string) =>
    (...args: unknown[]): Promise<void> => {
      calls.push([name, ...args])
      return Promise.resolve()
    }
  ;(globalThis as { window?: unknown }).window = {
    qclod: {
      answerPermission: record('answerPermission'),
      answerQuestion: record('answerQuestion'),
      answerPlan: record('answerPlan')
    }
  }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('cardAnswers: выбор окна — в ответ main', () => {
  test('разрешение: once, always → remember, session → forSession', () => {
    const answers = cardAnswers('t1')
    answers.permission('r1', { behavior: 'allow', scope: 'once' })
    answers.permission('r2', { behavior: 'allow', scope: 'always' })
    answers.permission('r3', { behavior: 'allow', scope: 'session' })
    expect(calls).toEqual([
      ['answerPermission', 'r1', { behavior: 'allow' }],
      ['answerPermission', 'r2', { behavior: 'allow', remember: true }],
      ['answerPermission', 'r3', { behavior: 'allow', forSession: true }]
    ])
  })

  test('отказ: причина → message, пустой — без неё', () => {
    const answers = cardAnswers('t1')
    answers.permission('r1', { behavior: 'deny', reason: 'не трогай main' })
    answers.permission('r2', { behavior: 'deny', reason: '' })
    answers.permission('r3', { behavior: 'deny' })
    expect(calls).toEqual([
      ['answerPermission', 'r1', { behavior: 'deny', message: 'не трогай main' }],
      ['answerPermission', 'r2', { behavior: 'deny' }],
      ['answerPermission', 'r3', { behavior: 'deny' }]
    ])
  })

  test('вопрос передаёт ответы и комментарии для своей вкладки', () => {
    cardAnswers('t1').question('q1', { 'Где?': 'Справа' }, { 'Где?': 'у окна' })
    expect(calls).toEqual([['answerQuestion', 't1', 'q1', { 'Где?': 'Справа' }, { 'Где?': 'у окна' }]])
  })

  test('план передаёт решение целиком', () => {
    cardAnswers('t2').plan('p1', { approve: false, comment: 'без миграций', plan: '1. …' })
    expect(calls).toEqual([
      ['answerPlan', 't2', 'p1', { approve: false, comment: 'без миграций', plan: '1. …' }]
    ])
  })
})
