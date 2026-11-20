import { describe, expect, test } from 'vitest'
import {
  RECOMMENDED,
  canAdvance,
  collect,
  displayLabel,
  goTo,
  initialSteps,
  pick,
  setText
} from '../../src/renderer/chat/questionSteps'
import type { QuestionView } from '../../src/shared/types'

const single = (question = 'Q', labels = ['Быстро (Recommended)', 'Надёжно']): QuestionView => ({
  question,
  header: 'Как',
  options: labels.map((label) => ({ label, description: '' })),
  multiSelect: false
})
const multi = (question = 'M', labels = ['A', 'B', 'C']): QuestionView => ({
  ...single(question, labels),
  multiSelect: true
})

describe('questionSteps', () => {
  test('выбор и комментарий', () => {
    const qs = [single()]
    let state = pick(initialSteps(qs), qs[0]!, 'Быстро (Recommended)')
    state = setText(state, '  без тестов ')
    expect(collect(qs, state)).toEqual({ answers: { Q: 'Быстро (Recommended)' }, notes: { Q: 'без тестов' } })
  })

  test('свой ответ без выбора', () => {
    const qs = [single()]
    const state = setText(initialSteps(qs), 'свой текст')
    expect(collect(qs, state)).toEqual({ answers: { Q: 'свой текст' }, notes: {} })
  })

  test('множественный в порядке вариантов', () => {
    const qs = [multi()]
    let state = pick(initialSteps(qs), qs[0]!, 'C')
    state = pick(state, qs[0]!, 'A')
    expect(state.picks[0]).toEqual(['C', 'A'])
    expect(collect(qs, state)).toEqual({ answers: { M: 'A, C' }, notes: {} })
  })

  test('множественный: повторное нажатие снимает выбор', () => {
    const qs = [multi()]
    let state = pick(initialSteps(qs), qs[0]!, 'B')
    state = pick(state, qs[0]!, 'B')
    expect(state.picks[0]).toEqual([])
  })

  test('множественный с комментарием: «A, C» и текст в notes (П16)', () => {
    const qs = [multi()]
    let state = pick(pick(initialSteps(qs), qs[0]!, 'C'), qs[0]!, 'A')
    state = setText(state, 'оба')
    expect(collect(qs, state)).toEqual({ answers: { M: 'A, C' }, notes: { M: 'оба' } })
  })

  test('одиночный: другой вариант заменяет, тот же снова — снимает', () => {
    const qs = [single()]
    let state = pick(initialSteps(qs), qs[0]!, 'Надёжно')
    state = pick(state, qs[0]!, 'Быстро (Recommended)')
    expect(state.picks[0]).toEqual(['Быстро (Recommended)'])
    state = pick(state, qs[0]!, 'Быстро (Recommended)')
    expect(state.picks[0]).toEqual([])
  })

  test('canAdvance ложно без выбора и текста', () => {
    const qs = [single()]
    const empty = initialSteps(qs)
    expect(canAdvance(empty)).toBe(false)
    expect(canAdvance(setText(empty, '   '))).toBe(false)
    expect(canAdvance(setText(empty, 'да'))).toBe(true)
    expect(canAdvance(pick(empty, qs[0]!, 'Надёжно'))).toBe(true)
  })

  test('шаги: выбор и текст у каждого вопроса свои', () => {
    const qs = [single('Q1'), multi('Q2')]
    let state = pick(initialSteps(qs), qs[0]!, 'Надёжно')
    state = goTo(state, 1)
    expect(state.step).toBe(1)
    expect(canAdvance(state)).toBe(false)
    state = setText(pick(state, qs[1]!, 'B'), 'потом')
    state = goTo(state, 0)
    expect(state.picks).toEqual([['Надёжно'], ['B']])
    expect(state.texts).toEqual(['', 'потом'])
    expect(collect(qs, state)).toEqual({ answers: { Q1: 'Надёжно', Q2: 'B' }, notes: { Q2: 'потом' } })
  })

  test('displayLabel прячет суффикс (Recommended)', () => {
    expect(displayLabel('Быстро (Recommended)')).toEqual({ text: 'Быстро', recommended: true })
    expect(displayLabel('Быстро (recommended) ')).toEqual({ text: 'Быстро', recommended: true })
    expect(displayLabel('Надёжно')).toEqual({ text: 'Надёжно', recommended: false })
    expect(RECOMMENDED.test('(Recommended) в начале')).toBe(false)
  })
})
