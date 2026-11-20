import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { watchRenderer } from '../../src/main/window'
import type { ErrorEntry } from '../../src/main/system/errorLog'

vi.mock('electron', () => ({ BrowserWindow: class {}, shell: {} }))

class Fake extends EventEmitter {
  reload = vi.fn()
  forcefullyCrashRenderer = vi.fn()
}

let contents: Fake
let log: ErrorEntry[]
let t: number
beforeEach(() => {
  vi.useFakeTimers()
  contents = new Fake()
  log = []
  t = 1000
  watchRenderer(contents as never, { log: (e) => log.push(e), now: () => t, hangMs: 15000 })
})
afterEach(() => vi.useRealTimers())

const gone = (reason: string): boolean => contents.emit('render-process-gone', {}, { reason })

describe('watchRenderer', () => {
  test('a crash is logged and the page reloaded', () => {
    gone('crashed')
    expect(contents.reload).toHaveBeenCalledTimes(1)
    expect(log[0]).toMatchObject({ source: 'main', scope: 'window' })
    expect(log[0]!.message).toContain('crashed')
  })

  test('a clean exit is left alone', () => {
    gone('clean-exit')
    expect(contents.reload).not.toHaveBeenCalled()
    expect(log).toHaveLength(0)
  })

  test('the fourth reload within 60 s is not made, but is logged', () => {
    for (let i = 0; i < 4; i++) {
      gone('crashed')
      t += 5000
    }
    expect(contents.reload).toHaveBeenCalledTimes(3)
    expect(log).toHaveLength(5) // four crashes and the refusal
  })

  test('reloads are allowed again once the minute has passed', () => {
    for (let i = 0; i < 3; i++) gone('crashed')
    t += 61000
    gone('crashed')
    expect(contents.reload).toHaveBeenCalledTimes(4)
  })

  test('unresponsive with no recovery crashes the renderer; the crash event brings the one reload', () => {
    contents.forcefullyCrashRenderer.mockImplementation(() => gone('crashed'))
    contents.emit('unresponsive')
    expect(log).toHaveLength(1)
    vi.advanceTimersByTime(14999)
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(contents.reload).toHaveBeenCalledTimes(1)
  })

  test('the hang path itself does not reload before the crash event arrives', () => {
    contents.emit('unresponsive')
    vi.advanceTimersByTime(15000)
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1)
    expect(contents.reload).not.toHaveBeenCalled()
    gone('crashed')
    expect(contents.reload).toHaveBeenCalledTimes(1)
  })

  test('a crash while unresponsive disarms the hang timer: the new page is not killed', () => {
    contents.emit('unresponsive')
    vi.advanceTimersByTime(5000)
    gone('oom')
    expect(contents.reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15000)
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(contents.reload).toHaveBeenCalledTimes(1)
  })

  test('responsive in time cancels it', () => {
    contents.emit('unresponsive')
    vi.advanceTimersByTime(10000)
    contents.emit('responsive')
    vi.advanceTimersByTime(60000)
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled()
    expect(contents.reload).not.toHaveBeenCalled()
  })
})

describe('watchRenderer: reload after a hang', () => {
  let afterHang: ReturnType<typeof vi.fn>
  beforeEach(() => {
    contents = new Fake()
    log = []
    afterHang = vi.fn()
    watchRenderer(contents as never, { log: (e) => log.push(e), now: () => t, hangMs: 15000, reloadAfterHang: afterHang })
    contents.forcefullyCrashRenderer.mockImplementation(() => gone('killed'))
  })

  test('the page killed for hanging comes back through reloadAfterHang, not a plain reload', () => {
    contents.emit('unresponsive')
    vi.advanceTimersByTime(15000)
    expect(afterHang).toHaveBeenCalledTimes(1)
    expect(contents.reload).not.toHaveBeenCalled()
  })

  test('a crash of its own is a plain reload', () => {
    gone('crashed')
    expect(contents.reload).toHaveBeenCalledTimes(1)
    expect(afterHang).not.toHaveBeenCalled()
  })

  test('only the crash we caused counts: the next crash is plain again', () => {
    contents.emit('unresponsive')
    vi.advanceTimersByTime(15000)
    gone('crashed')
    expect(afterHang).toHaveBeenCalledTimes(1)
    expect(contents.reload).toHaveBeenCalledTimes(1)
  })

  test('reloads after a hang count towards the three a minute', () => {
    for (let i = 0; i < 4; i++) {
      contents.emit('unresponsive')
      vi.advanceTimersByTime(15000)
    }
    expect(afterHang).toHaveBeenCalledTimes(3)
    expect(log.at(-1)!.message).toContain('not reloading')
  })
})
