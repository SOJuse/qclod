import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SILENCE_TIMEOUT_MS, StatusTracker } from '@main/sessions/statusTracker'
import type { StatusState } from '@main/sessions/sessionStatus'
import type { TabId } from '@shared/types'

let seen: Array<{ tabId: TabId; state: StatusState }>
let tracker: StatusTracker

beforeEach(() => {
  vi.useFakeTimers()
  seen = []
  tracker = new StatusTracker((tabId, state) => seen.push({ tabId, state }))
})

afterEach(() => {
  tracker.dispose()
  vi.useRealTimers()
})

function last(): StatusState | undefined {
  return seen[seen.length - 1]?.state
}

describe('StatusTracker', () => {
  test('отправка переводит в работу', () => {
    tracker.sent('t1')
    expect(last()).toEqual({ status: 'busy', degraded: false })
  })

  test('хук Stop переводит в простой', () => {
    tracker.sent('t1')
    tracker.hook('t1', { hook_event_name: 'Stop' })
    expect(last()).toEqual({ status: 'idle', degraded: false })
  })

  test('пока идёт вывод, состояние не портится', () => {
    // The agent is working and printing. A flat stopwatch would declare it
    // finished mid-turn; silence is the signal, not elapsed time.
    tracker.sent('t1')
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(SILENCE_TIMEOUT_MS - 1000)
      tracker.output('t1')
    }
    expect(last()).toEqual({ status: 'busy', degraded: false })
  })

  test('затишье без хука переводит в оценочный простой', () => {
    tracker.sent('t1')
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS + 10)
    expect(last()).toEqual({ status: 'idle', degraded: true })
  })

  test('вывод после затишья снова запускает отсчёт', () => {
    tracker.sent('t1')
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS + 10)
    expect(last()?.degraded).toBe(true)

    tracker.sent('t1')
    tracker.output('t1')
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS - 100)
    expect(last()).toEqual({ status: 'busy', degraded: false })
  })

  test('выход процесса переводит в exited и снимает таймер', () => {
    tracker.sent('t1')
    tracker.exited('t1')
    expect(last()).toEqual({ status: 'exited', degraded: false })

    const count = seen.length
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS * 3)
    // A dead tab must not come back to life as an idle one.
    expect(seen).toHaveLength(count)
  })

  test('забытая вкладка больше не присылает событий', () => {
    tracker.sent('t1')
    tracker.forget('t1')
    const count = seen.length
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS * 3)
    expect(seen).toHaveLength(count)
    expect(tracker.size).toBe(0)
  })

  test('хук для забытой вкладки игнорируется', () => {
    tracker.sent('t1')
    tracker.forget('t1')
    const count = seen.length
    tracker.hook('t1', { hook_event_name: 'Stop' })
    expect(seen).toHaveLength(count)
  })

  test('вкладки не мешают друг другу', () => {
    tracker.sent('a')
    tracker.sent('b')
    tracker.hook('a', { hook_event_name: 'Stop' })
    expect(tracker.get('a')?.status).toBe('idle')
    expect(tracker.get('b')?.status).toBe('busy')
  })

  test('одинаковое состояние не рассылается повторно', () => {
    tracker.sent('t1')
    const count = seen.length
    tracker.sent('t1')
    expect(seen).toHaveLength(count)
  })

  test('dispose снимает все таймеры', () => {
    tracker.sent('a')
    tracker.sent('b')
    tracker.dispose()
    const count = seen.length
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS * 3)
    expect(seen).toHaveLength(count)
    expect(tracker.size).toBe(0)
  })
})
