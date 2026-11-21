import { describe, expect, test } from 'vitest'
import { costRatesFrom, estimateCost } from '../../src/shared/agentCost'

const usage = (input: number, costUSD: number, extra: Record<string, number> = {}): Record<string, number> => ({
  inputTokens: input,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD,
  ...extra
})

describe('costRatesFrom', () => {
  test('ставка модели — costUSD на все токены', () => {
    const rates = costRatesFrom({ 'claude-haiku-5-5': usage(1000, 0.001) })
    expect(rates?.byModel['claude-haiku-5-5']).toBe(0.000001)
    expect(rates?.average).toBe(0.000001)
  })

  test('кэш и вывод входят в токены; average — по всем моделям', () => {
    const rates = costRatesFrom({
      'claude-opus-5': usage(1000, 0.03, { outputTokens: 500, cacheReadInputTokens: 400, cacheCreationInputTokens: 100 }),
      'claude-haiku-5-5': usage(2000, 0.002)
    })
    expect(rates?.byModel['claude-opus-5']).toBeCloseTo(0.000015, 12)
    expect(rates?.byModel['claude-haiku-5-5']).toBeCloseTo(0.000001, 12)
    expect(rates?.average).toBeCloseTo(0.032 / 4000, 12)
  })

  test('модель без токенов пропускается', () => {
    const rates = costRatesFrom({ 'claude-opus-5': usage(0, 0), 'claude-haiku-5-5': usage(1000, 0.001) })
    expect(Object.keys(rates!.byModel)).toEqual(['claude-haiku-5-5'])
  })

  test('мусор и пустота — null', () => {
    for (const bad of [undefined, null, 5, 'x', [], {}, { a: 1 }, { a: usage(0, 1) }, { a: { costUSD: 1 } }]) {
      expect(costRatesFrom(bad)).toBeNull()
    }
  })
})

describe('estimateCost', () => {
  const rates = costRatesFrom({
    'claude-haiku-5-5': usage(1000, 0.001),
    'claude-opus-5': usage(1000, 0.015)
  })

  test('точный ключ', () => {
    expect(estimateCost(10000, 'claude-haiku-5-5', rates)).toBeCloseTo(0.01, 12)
  })

  test('по семейству: haiku находит свой ключ', () => {
    expect(estimateCost(10000, 'haiku', rates)).toBeCloseTo(0.01, 12)
    expect(estimateCost(10000, 'claude-opus-4-1', rates)).toBeCloseTo(0.15, 12)
  })

  test('незнакомая модель или без модели — average', () => {
    expect(estimateCost(1000, 'gpt-x', rates)).toBeCloseTo(1000 * rates!.average, 12)
    expect(estimateCost(1000, undefined, rates)).toBeCloseTo(1000 * rates!.average, 12)
    // The family has no key in this session: the average again.
    expect(estimateCost(1000, 'sonnet', rates)).toBeCloseTo(1000 * rates!.average, 12)
  })

  test('нет токенов или ставок — null', () => {
    expect(estimateCost(0, 'haiku', rates)).toBeNull()
    expect(estimateCost(undefined, 'haiku', rates)).toBeNull()
    expect(estimateCost(-5, 'haiku', rates)).toBeNull()
    expect(estimateCost(100, 'haiku', null)).toBeNull()
  })
})
