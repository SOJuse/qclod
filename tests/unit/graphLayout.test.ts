import { describe, expect, test } from 'vitest'
import type { AgentNode } from '../../src/renderer/agents/agentModel'
import { COL_GAP, NODE_H, NODE_W, ROOT_W, ROW_GAP, layoutGraph } from '../../src/renderer/agents/graphLayout'

const node = (id: string, parentId: string | null = null, patch: Partial<AgentNode> = {}): AgentNode => ({
  id,
  parentId,
  depth: parentId ? 2 : 1,
  name: 'Explore',
  task: id,
  state: 'done',
  background: false,
  summary: '',
  runs: 1,
  ...patch
})

describe('layoutGraph', () => {
  test('значения из брифа', () => {
    expect([NODE_W, NODE_H, ROOT_W, COL_GAP, ROW_GAP]).toEqual([232, 76, 152, 56, 12])
  })

  test('три ребёнка корня — одна колонка, y 0/88/176, корень по середине', () => {
    const g = layoutGraph([node('a'), node('b'), node('c')])
    const xs = ['a', 'b', 'c'].map((id) => g.placed.get(id)!.x)
    expect(new Set(xs)).toEqual(new Set([ROOT_W + COL_GAP]))
    expect(['a', 'b', 'c'].map((id) => g.placed.get(id)!.y)).toEqual([0, 88, 176])
    expect(g.root).toEqual({ x: 0, y: 88 })
    expect(g.height).toBe(176 + NODE_H)
    expect(g.width).toBe(ROOT_W + COL_GAP + NODE_W)
  })

  test('внук — на колонку дальше, родитель по середине своих детей', () => {
    const g = layoutGraph([node('a'), node('a1', 'a', { depth: 2 }), node('a2', 'a', { depth: 2 }), node('b')])
    const a = g.placed.get('a')!
    const a1 = g.placed.get('a1')!
    const a2 = g.placed.get('a2')!
    const b = g.placed.get('b')!
    expect(a1.x).toBe(a.x + NODE_W + COL_GAP)
    expect(a1.y).toBe(0)
    expect(a2.y).toBe(88)
    expect(a.y).toBe(44)
    expect(b.y).toBe(176)
    // корень — по середине первой колонки: a (44) и b (176)
    expect(g.root.y).toBe(110)
    expect(g.width).toBe(ROOT_W + COL_GAP + 2 * NODE_W + COL_GAP)
  })

  test('рёбра от главного и от родителя; live только у работающих', () => {
    const g = layoutGraph([node('a', null, { state: 'running' }), node('a1', 'a', { depth: 2 }), node('b')])
    expect(g.edges).toEqual([
      { from: 'main', to: 'a', live: true },
      { from: 'a', to: 'a1', live: false },
      { from: 'main', to: 'b', live: false }
    ])
  })

  test('пусто — только корень', () => {
    const g = layoutGraph([])
    expect(g.placed.size).toBe(0)
    expect(g.edges).toEqual([])
    expect(g.root).toEqual({ x: 0, y: 0 })
  })
})
