import { describe, expect, test } from 'vitest'
import { isRecommended, pickAnswers, shownLabel } from '../../src/core/autonomy/pickAnswers'

describe('pickAnswers', () => {
  test('один вопрос: первый рекомендованный, подпись как пришла', () => {
    expect(pickAnswers([{ question: 'Q', options: ['A', 'B (Recommended)'], multiSelect: false }])).toEqual({
      Q: 'B (Recommended)'
    })
  })

  test('без рекомендованного — первый вариант', () => {
    expect(pickAnswers([{ question: 'Q', options: ['A', 'B'], multiSelect: false }])).toEqual({ Q: 'A' })
  })

  test('мультивыбор: все рекомендованные через запятую', () => {
    expect(
      pickAnswers([
        { question: 'Q', options: ['A (Recommended)', 'B', 'C (Recommended)'], multiSelect: true }
      ])
    ).toEqual({ Q: 'A (Recommended), C (Recommended)' })
  })

  test('мультивыбор без рекомендованных — первый вариант', () => {
    expect(pickAnswers([{ question: 'Q', options: ['A', 'B', 'C'], multiSelect: true }])).toEqual({ Q: 'A' })
  })

  test('несколько вопросов отвечаются каждый; вопрос без вариантов пропускается', () => {
    expect(
      pickAnswers([
        { question: 'Q1', options: ['Да (Рекомендуется)', 'Нет'], multiSelect: false },
        { question: 'Q2', options: [], multiSelect: false },
        { question: 'Q3', options: ['x', 'y'], multiSelect: false }
      ])
    ).toEqual({ Q1: 'Да (Рекомендуется)', Q3: 'x' })
  })

  test('shownLabel и isRecommended', () => {
    expect(shownLabel('Да (Recommended)')).toBe('Да')
    expect(shownLabel('Да (рекомендуется) ')).toBe('Да')
    expect(shownLabel('Да')).toBe('Да')
    expect(isRecommended('B (recommended)')).toBe(true)
    expect(isRecommended('B')).toBe(false)
    // Only a suffix counts.
    expect(isRecommended('(Recommended) B')).toBe(false)
  })
})
