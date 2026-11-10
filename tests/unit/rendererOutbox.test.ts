import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { RendererOutbox } from '../../src/main/rendererOutbox'
import { CHANNELS } from '../../src/shared/channels'
import type { RibbonEvent } from '../../src/shared/types'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function event(tabId: string, rev: number, id: string): RibbonEvent {
  return { tabId, rev, changes: [{ kind: 'append', item: { kind: 'notice', id, text: id, tone: 'info' } }] }
}

describe('RendererOutbox', () => {
  test('статус уходит после накопленной ленты той же вкладки', () => {
    const sent: Array<[string, unknown]> = []
    const outbox = new RendererOutbox((channel, payload) => sent.push([channel, payload]))

    outbox.ribbon(event('a', 1, 'хвост'))
    outbox.send(CHANNELS.statusChanged, { tabId: 'a', status: 'idle' })

    expect(sent.map(([channel]) => channel)).toEqual([CHANNELS.ribbonChanged, CHANNELS.statusChanged])
    expect((sent[0]![1] as RibbonEvent).rev).toBe(1)

    vi.advanceTimersByTime(50)
    expect(sent).toHaveLength(2)
  })

  test('без накопленной ленты статус уходит сразу и один', () => {
    const sent: string[] = []
    const outbox = new RendererOutbox((channel) => sent.push(channel))
    outbox.send(CHANNELS.statusChanged, { tabId: 'a', status: 'idle' })
    expect(sent).toEqual([CHANNELS.statusChanged])
  })

  test('лента без статуса уходит по таймеру одним сообщением', () => {
    const sent: Array<[string, unknown]> = []
    const outbox = new RendererOutbox((channel, payload) => sent.push([channel, payload]))
    outbox.ribbon(event('a', 1, 'один'))
    outbox.ribbon(event('a', 2, 'два'))
    expect(sent).toHaveLength(0)

    vi.advanceTimersByTime(20)
    expect(sent).toHaveLength(1)
    const batch = sent[0]![1] as RibbonEvent
    expect(batch.changes).toHaveLength(2)
    expect(batch.rev).toBe(2)
  })
})
