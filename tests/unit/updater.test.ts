import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  UpdateFlow,
  UPDATE_FIRST_CHECK_MS,
  UPDATE_RECHECK_MS,
  type UpdateSource
} from '../../src/main/update/updater'
import { restartWarning } from '../../src/renderer/components/UpdateBanner'
import type { UpdateState } from '../../src/shared/types'

/** A source the test drives by hand: it says when a download is done or a check failed. */
function fakeSource(check: () => Promise<unknown> = async () => null) {
  let downloaded: ((version: string) => void) | null = null
  let errored: ((err: Error) => void) | null = null
  const source = {
    checkForUpdates: vi.fn(check),
    quitAndInstall: vi.fn<(isSilent: boolean, isForceRunAfter: boolean) => void>(),
    onDownloaded: (cb: (version: string) => void) => {
      downloaded = cb
    },
    onError: (cb: (err: Error) => void) => {
      errored = cb
    }
  } satisfies UpdateSource
  return {
    source,
    download: (version: string) => downloaded?.(version),
    fail: (err: Error) => errored?.(err)
  }
}

/** Timers that run only when the test says so. */
function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = []
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      pending.push({ fn, ms })
      return pending.length
    },
    /** Runs the oldest timer still waiting. */
    fire: () => pending.shift()!.fn()
  }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

function makeFlow(src = fakeSource()) {
  const timers = manualTimers()
  const states: UpdateState[] = []
  const logs: string[] = []
  const flow = new UpdateFlow({
    source: src.source,
    onState: (s) => states.push(s),
    log: (m) => logs.push(m),
    setTimer: timers.setTimer
  })
  return { flow, timers, states, logs, src }
}

describe('UpdateFlow', () => {
  test('первая проверка через UPDATE_FIRST_CHECK_MS, затем каждые UPDATE_RECHECK_MS', async () => {
    const { flow, timers, src } = makeFlow()
    expect(UPDATE_FIRST_CHECK_MS).toBe(10000)
    expect(UPDATE_RECHECK_MS).toBe(6 * 60 * 60 * 1000)

    flow.start()
    expect(src.source.checkForUpdates).not.toHaveBeenCalled()
    expect(timers.pending.map((t) => t.ms)).toEqual([UPDATE_FIRST_CHECK_MS])

    timers.fire()
    await flush()
    expect(src.source.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(timers.pending.map((t) => t.ms)).toEqual([UPDATE_RECHECK_MS])

    timers.fire()
    await flush()
    expect(src.source.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(timers.pending.map((t) => t.ms)).toEqual([UPDATE_RECHECK_MS])
  })

  test('start(0) проверяет без задержки', async () => {
    const { flow, timers, src } = makeFlow()
    flow.start(0)
    expect(timers.pending.map((t) => t.ms)).toEqual([0])
    timers.fire()
    await flush()
    expect(src.source.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  test('скачанное обновление: state ready, onState один раз, плановых проверок больше нет', async () => {
    const { flow, timers, states, src } = makeFlow()
    flow.start()
    expect(flow.state).toEqual({ kind: 'idle' })

    src.download('0.2.0')
    expect(flow.state).toEqual({ kind: 'ready', version: '0.2.0' })
    expect(states).toEqual([{ kind: 'ready', version: '0.2.0' }])

    // The timer already set fires, but checks nothing and sets nothing new.
    timers.fire()
    await flush()
    expect(src.source.checkForUpdates).not.toHaveBeenCalled()
    expect(timers.pending).toEqual([])

    src.download('0.2.0')
    expect(states).toHaveLength(1)
  })

  describe('сеть/TLS', () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }
    afterEach(() => {
      process.off('unhandledRejection', onUnhandled)
      seen.length = 0
    })

    test('отказ проверки и событие error оставляют idle, пишут в лог и не роняют процесс', async () => {
      process.on('unhandledRejection', onUnhandled)
      const err = new Error('certificate is not yet valid')
      const src = fakeSource(() => Promise.reject(err))
      const { flow, timers, states, logs } = makeFlow(src)

      flow.start()
      timers.fire()
      src.fail(err)
      await flush()
      await flush()

      expect(flow.state).toEqual({ kind: 'idle' })
      expect(states).toEqual([])
      expect(logs.some((m) => m.includes('certificate is not yet valid'))).toBe(true)
      expect(logs.filter((m) => m.includes('certificate is not yet valid'))).toHaveLength(2)
      expect(seen).toEqual([])
      // The next check is still on the schedule.
      expect(timers.pending.map((t) => t.ms)).toEqual([UPDATE_RECHECK_MS])
    })

    test('проверка, бросившая синхронно, тоже не роняет и перепланируется', async () => {
      process.on('unhandledRejection', onUnhandled)
      const src = fakeSource(() => {
        throw new Error('net::ERR_INTERNET_DISCONNECTED')
      })
      const { flow, timers, logs } = makeFlow(src)
      flow.start()
      timers.fire()
      await flush()
      expect(flow.state).toEqual({ kind: 'idle' })
      expect(logs.some((m) => m.includes('ERR_INTERNET_DISCONNECTED'))).toBe(true)
      expect(seen).toEqual([])
      expect(timers.pending.map((t) => t.ms)).toEqual([UPDATE_RECHECK_MS])
    })
  })

  test('restart до ready — false и без установки; в ready — true и quitAndInstall(true, true)', () => {
    const { flow, src } = makeFlow()
    flow.start()
    expect(flow.restart()).toBe(false)
    expect(src.source.quitAndInstall).not.toHaveBeenCalled()

    src.download('0.2.0')
    expect(flow.restart()).toBe(true)
    expect(src.source.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(src.source.quitAndInstall).toHaveBeenCalledWith(true, true)
  })
})

describe('restartWarning', () => {
  const text = 'Во вкладках идёт работа — перезапуск её прервёт.'
  test('без работы — null', () => {
    expect(restartWarning(['idle'])).toBeNull()
    expect(restartWarning([])).toBeNull()
    expect(restartWarning(['stopped', 'error', 'starting'])).toBeNull()
  })
  test('агент работает или ждёт ответа — предупреждение', () => {
    expect(restartWarning(['idle', 'busy'])).toBe(text)
    expect(restartWarning(['waiting'])).toBe(text)
  })
})
