import { describe, expect, test } from 'vitest'
import type { AgentNode } from '../../src/renderer/agents/agentModel'
import { layoutTimeline } from '../../src/renderer/agents/timelineLayout'

const node = (id: string, patch: Partial<AgentNode> = {}): AgentNode => ({
  id,
  parentId: null,
  depth: 1,
  name: 'Explore',
  task: id,
  state: 'done',
  background: false,
  summary: '',
  runs: 1,
  ...patch
})

describe('layoutTimeline', () => {
  test('два агента 0–60 с и 30–90 с: left 0 и 1/3, width 2/3', () => {
    const t = layoutTimeline(
      [node('a', { startedAt: 0, endedAt: 60_000 }), node('b', { startedAt: 30_000, endedAt: 90_000 })],
      90_000
    )
    expect(t.start).toBe(0)
    expect(t.end).toBe(90_000)
    expect(t.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(t.rows[0]!.left).toBe(0)
    expect(t.rows[0]!.width).toBeCloseTo(2 / 3)
    expect(t.rows[1]!.left).toBeCloseTo(1 / 3)
    expect(t.rows[1]!.width).toBeCloseTo(2 / 3)
    expect(t.rows.every((r) => !r.open)).toBe(true)
  })

  test('работающий тянется до now и открыт', () => {
    const t = layoutTimeline(
      [node('a', { startedAt: 10_000, endedAt: 20_000 }), node('b', { startedAt: 20_000, state: 'running' })],
      50_000
    )
    expect(t.end).toBe(50_000)
    const b = t.rows.find((r) => r.id === 'b')!
    expect(b.open).toBe(true)
    expect(b.left + b.width).toBeCloseTo(1)
  })

  test('строки по startedAt, при равенстве — по порядку ленты', () => {
    const t = layoutTimeline(
      [node('c', { startedAt: 5000, endedAt: 9000 }), node('a', { startedAt: 1000, endedAt: 2000 }), node('b', { startedAt: 5000, endedAt: 6000 })],
      9000
    )
    expect(t.rows.map((r) => r.id)).toEqual(['a', 'c', 'b'])
  })

  test('узел без startedAt — в untimed; короткая полоса не тоньше 0.004', () => {
    const t = layoutTimeline([node('a', { startedAt: 0, endedAt: 100_000 }), node('b', { startedAt: 50_000, endedAt: 50_000 }), node('x')], 0)
    expect(t.untimed).toBe(1)
    expect(t.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(t.rows[1]!.width).toBe(0.004)
  })

  test('конец не раньше start + 1000', () => {
    const t = layoutTimeline([node('a', { startedAt: 7000, endedAt: 7100 })], 0)
    expect(t.end).toBe(8000)
  })

  test('70 с — деления по 10 с, 0:00 … 1:10', () => {
    const t = layoutTimeline([node('a', { startedAt: 0, endedAt: 70_000 })], 0)
    expect(t.ticks.map((k) => k.label)).toEqual(['0:00', '0:10', '0:20', '0:30', '0:40', '0:50', '1:00', '1:10'])
    expect(t.ticks[1]!.at).toBeCloseTo(1 / 7)
  })

  test('90 с — десяти делений по 10 с много (≤ 8), шаг 30 с: 0:00 … 1:30', () => {
    const t = layoutTimeline([node('a', { startedAt: 0, endedAt: 90_000 })], 0)
    expect(t.ticks.map((k) => k.label)).toEqual(['0:00', '0:30', '1:00', '1:30'])
  })

  test('от часа — ч:мм', () => {
    const t = layoutTimeline([node('a', { startedAt: 0, endedAt: 3 * 3_600_000 })], 0)
    // шаг 30 мин; до часа — м:сс, от часа — ч:мм
    expect(t.ticks.map((k) => k.label)).toEqual(['0:00', '30:00', '1:00', '1:30', '2:00', '2:30', '3:00'])
  })

  test('пусто — ни строк, ни делений', () => {
    const t = layoutTimeline([node('x')], 5000)
    expect(t.rows).toEqual([])
    expect(t.ticks).toEqual([])
    expect(t.untimed).toBe(1)
  })
})
