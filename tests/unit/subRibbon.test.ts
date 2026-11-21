import { describe, expect, test } from 'vitest'
import type { RibbonItem } from '../../src/shared/types'
import { subRibbon } from '../../src/renderer/agents/subRibbon'

const text = (id: string, parentId?: string): RibbonItem => ({
  kind: 'agentText',
  id,
  text: id,
  streaming: false,
  ...(parentId ? { parentId } : {})
})
const sub = (id: string, parentId?: string): RibbonItem => ({
  kind: 'subagent',
  id,
  toolUseId: `tu-${id}`,
  name: 'Explore',
  task: id,
  state: 'running',
  summary: '',
  ...(parentId ? { parentId } : {})
})

describe('subRibbon', () => {
  const items: RibbonItem[] = [
    text('main-1'),
    sub('a'),
    sub('b'),
    text('a-1', 'a'),
    text('b-1', 'b'),
    sub('a-inner', 'a'),
    text('inner-1', 'a-inner'),
    { kind: 'agentMessage', id: 'm', parentId: 'a', from: 'person', text: 'привет', state: 'sent' },
    text('main-2')
  ]

  test('прямые дети — без parentId, внуки — с ним; чужие не входят', () => {
    const out = subRibbon(items, 'a')
    expect(out.map((i) => i.id)).toEqual(['a-1', 'a-inner', 'inner-1', 'm'])
    expect(out.find((i) => i.id === 'a-1')!.parentId).toBeUndefined()
    expect(out.find((i) => i.id === 'a-inner')!.parentId).toBeUndefined()
    expect(out.find((i) => i.id === 'm')!.parentId).toBeUndefined()
    expect(out.find((i) => i.id === 'inner-1')!.parentId).toBe('a-inner')
  })

  test('исходные элементы не меняются', () => {
    subRibbon(items, 'a')
    expect(items[3]!.parentId).toBe('a')
  })

  test('неизвестная карточка — пусто', () => {
    expect(subRibbon(items, 'nope')).toEqual([])
  })
})
