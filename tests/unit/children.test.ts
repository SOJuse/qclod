import { describe, expect, test } from 'vitest'
import { childrenByParent } from '../../src/renderer/chat/children'
import type { RibbonItem } from '../../src/shared/types'

const text = (id: string, parentId?: string): RibbonItem => ({
  kind: 'agentText',
  id,
  text: id,
  streaming: false,
  ...(parentId ? { parentId } : {})
})

describe('childrenByParent', () => {
  test('дети собраны по родителю за один проход, порядок сохранён', () => {
    const items = [
      text('top1'),
      text('a1', 'agentA'),
      text('b1', 'agentB'),
      text('a2', 'agentA'),
      text('top2'),
      text('a3', 'agentA')
    ]
    const map = childrenByParent(items)
    expect(map.get('agentA')!.map((i) => i.id)).toEqual(['a1', 'a2', 'a3'])
    expect(map.get('agentB')!.map((i) => i.id)).toEqual(['b1'])
    // Top-level items belong to no parent.
    expect([...map.keys()].sort()).toEqual(['agentA', 'agentB'])
  })

  test('вложенный подагент — ребёнок своего родителя, а его шаги — его', () => {
    const inner: RibbonItem = {
      kind: 'subagent',
      id: 'inner',
      parentId: 'outer',
      toolUseId: 't',
      name: 'Explore',
      task: 'глубже',
      state: 'running',
      summary: ''
    }
    const map = childrenByParent([text('x', 'outer'), inner, text('y', 'inner')])
    expect(map.get('outer')!.map((i) => i.id)).toEqual(['x', 'inner'])
    expect(map.get('inner')!.map((i) => i.id)).toEqual(['y'])
  })

  test('пустая лента — пустая карта', () => {
    expect(childrenByParent([]).size).toBe(0)
  })
})
