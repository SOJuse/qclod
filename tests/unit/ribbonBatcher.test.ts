import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { RibbonBatcher } from '../../src/main/ribbonBatcher'
import type { RibbonEvent } from '../../src/shared/types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function change(id: string): RibbonEvent['changes'][number] {
  return { kind: 'append', item: { kind: 'notice', id, text: id, tone: 'info' } }
}

describe('RibbonBatcher', () => {
  test('тысяча изменений уходит одним сообщением, а не тысячей', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    for (let i = 0; i < 1000; i++) batcher.push({ tabId: 'a', changes: [change(`i${i}`)] })
    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(20)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.changes).toHaveLength(1000)
  })

  test('порядок изменений сохраняется', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', changes: [change('первое')] })
    batcher.push({ tabId: 'a', changes: [change('второе')] })
    vi.advanceTimersByTime(20)

    expect(sent[0]!.changes.map((c) => (c.kind === 'append' ? c.item.id : ''))).toEqual([
      'первое',
      'второе'
    ])
  })

  test('вкладки не смешиваются', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', changes: [change('из a')] })
    batcher.push({ tabId: 'b', changes: [change('из b')] })
    vi.advanceTimersByTime(20)

    expect(sent).toHaveLength(2)
    expect(sent.map((e) => e.tabId)).toEqual(['a', 'b'])
  })

  test('пустая пачка не превращается в сообщение', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', changes: [] })
    vi.advanceTimersByTime(20)

    expect(sent).toEqual([])
  })

  test('следующая пачка начинается с чистого листа', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', changes: [change('первая волна')] })
    vi.advanceTimersByTime(20)
    batcher.push({ tabId: 'a', changes: [change('вторая волна')] })
    vi.advanceTimersByTime(20)

    expect(sent).toHaveLength(2)
    expect(sent[1]!.changes).toHaveLength(1)
  })
})
