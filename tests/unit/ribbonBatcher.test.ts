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

    for (let i = 0; i < 1000; i++) batcher.push({ tabId: 'a', rev: i + 1, changes: [change(`i${i}`)] })
    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(20)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.changes).toHaveLength(1000)
  })

  test('порядок изменений сохраняется', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', rev: 1, changes: [change('первое')] })
    batcher.push({ tabId: 'a', rev: 1, changes: [change('второе')] })
    vi.advanceTimersByTime(20)

    expect(sent[0]!.changes.map((c) => (c.kind === 'append' ? c.item.id : ''))).toEqual([
      'первое',
      'второе'
    ])
  })

  test('вкладки не смешиваются', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', rev: 1, changes: [change('из a')] })
    batcher.push({ tabId: 'b', rev: 1, changes: [change('из b')] })
    vi.advanceTimersByTime(20)

    expect(sent).toHaveLength(2)
    expect(sent.map((e) => e.tabId)).toEqual(['a', 'b'])
  })

  test('пустая пачка не превращается в сообщение', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', rev: 1, changes: [] })
    vi.advanceTimersByTime(20)

    expect(sent).toEqual([])
  })

  test('следующая пачка начинается с чистого листа', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', rev: 1, changes: [change('первая волна')] })
    vi.advanceTimersByTime(20)
    batcher.push({ tabId: 'a', rev: 1, changes: [change('вторая волна')] })
    vi.advanceTimersByTime(20)

    expect(sent).toHaveLength(2)
    expect(sent[1]!.changes).toHaveLength(1)
  })

  test('пачка несёт ревизию последнего своего изменения', () => {
    const sent: RibbonEvent[] = []
    const batcher = new RibbonBatcher((event) => sent.push(event))

    batcher.push({ tabId: 'a', rev: 3, changes: [change('третье')] })
    batcher.push({ tabId: 'b', rev: 4, changes: [change('из b')] })
    batcher.push({ tabId: 'a', rev: 7, changes: [change('седьмое')] })
    vi.advanceTimersByTime(20)

    expect(sent.find((e) => e.tabId === 'a')?.rev).toBe(7)
    expect(sent.find((e) => e.tabId === 'b')?.rev).toBe(4)
  })
})
