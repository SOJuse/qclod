import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createGitStatusFeed, turnEnded } from '@renderer/components/git/useGitStatus'
import type { GitStatus } from '@shared/types'

const clean: GitStatus = { kind: 'ok', branch: 'main', detachedAt: null, initial: false, changes: [], truncated: false }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function feed() {
  const fetch = vi.fn(async () => clean)
  const seen: GitStatus[] = []
  const f = createGitStatusFeed({ fetch, onStatus: (s) => seen.push(s) })
  return { fetch, seen, f }
}

describe('createGitStatusFeed', () => {
  test('три refresh за 1 с после первого вызова дают один вызов gitStatus', async () => {
    const { fetch, f } = feed()
    f.refresh() // on mount
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    f.refresh()
    vi.advanceTimersByTime(300)
    f.refresh()
    vi.advanceTimersByTime(300)
    f.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_200)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  test('первый вызов — сразу, после паузы — снова сразу', async () => {
    const { fetch, seen, f } = feed()
    f.refresh()
    await vi.advanceTimersByTimeAsync(2_500)
    f.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toHaveLength(2)
    f.dispose()
  })

  test('refreshNow не ждёт паузы; после dispose ничего не приходит', async () => {
    const { fetch, seen, f } = feed()
    f.refresh()
    f.refreshNow()
    expect(fetch).toHaveBeenCalledTimes(2)
    f.dispose()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(seen).toHaveLength(0)
  })

  test('ход закончился: busy → idle', () => {
    expect(turnEnded('busy', 'idle')).toBe(true)
    expect(turnEnded('idle', 'busy')).toBe(false)
    expect(turnEnded('busy', 'waiting')).toBe(false)
    expect(turnEnded(undefined, 'idle')).toBe(false)
  })
})
