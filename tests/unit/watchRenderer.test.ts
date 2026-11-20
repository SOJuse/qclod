import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { watchMount, watchRenderer } from '../../src/main/window'
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

describe('watchRenderer: giving up', () => {
  let onGiveUp: ReturnType<typeof vi.fn>
  let handle: { reset(): void }
  beforeEach(() => {
    contents = new Fake()
    log = []
    onGiveUp = vi.fn()
    handle = watchRenderer(contents as never, { log: (e) => log.push(e), now: () => t, hangMs: 15000, onGiveUp })
  })

  test('four crashes in a minute: three reloads, then one give-up', () => {
    for (let i = 0; i < 4; i++) {
      gone('crashed')
      t += 5000
    }
    expect(contents.reload).toHaveBeenCalledTimes(3)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledWith('crashes')
    expect(log.at(-1)!.message).toContain('giving up')
  })

  test('the page that was shown instead crashing too does not call it again', () => {
    for (let i = 0; i < 6; i++) gone('crashed')
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  test('reset() clears the count: the fifth crash reloads again', () => {
    for (let i = 0; i < 4; i++) gone('crashed')
    handle.reset()
    gone('crashed')
    expect(contents.reload).toHaveBeenCalledTimes(4)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  test('after reset() a new run of crashes can give up again', () => {
    for (let i = 0; i < 4; i++) gone('crashed')
    handle.reset()
    for (let i = 0; i < 4; i++) gone('crashed')
    expect(onGiveUp).toHaveBeenCalledTimes(2)
  })

  test('destroyed with the hang timer armed: the renderer is not crashed afterwards', () => {
    contents.emit('unresponsive')
    contents.emit('destroyed')
    vi.advanceTimersByTime(60000)
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled()
  })

  const failLoad = (code: number, mainFrame = true): boolean =>
    contents.emit('did-fail-load', {}, code, 'ERR', 'file:///x', mainFrame)

  test('the main page failing to load gives up at once', () => {
    failLoad(-6)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledWith('load')
    expect(log[0]!.message).toContain('did-fail-load')
  })

  test('an aborted navigation, or a subframe failing, is not a failure', () => {
    failLoad(-3)
    failLoad(-6, false)
    expect(onGiveUp).not.toHaveBeenCalled()
  })
})

describe('watchMount', () => {
  class Page extends EventEmitter {
    stuck = true
    executeJavaScript = vi.fn(async () => this.stuck)
  }
  let page: Page
  let giveUp: ReturnType<typeof vi.fn>
  const navigate = (): boolean => page.emit('did-start-navigation', {}, 'file:///index.html', false, true)
  beforeEach(() => {
    page = new Page()
    log = []
    giveUp = vi.fn()
    watchMount(page as never, { log: (e) => log.push(e), ms: 15000, onGiveUp: giveUp })
  })

  test('the boot screen still up after the bound: logged, given up', async () => {
    navigate()
    await vi.advanceTimersByTimeAsync(14999)
    expect(giveUp).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(giveUp).toHaveBeenCalledTimes(1)
    expect(giveUp).toHaveBeenCalledWith('mount')
    expect(log[0]!.message).toContain('did not mount')
  })

  test('a page that mounted is left alone', async () => {
    page.stuck = false
    navigate()
    await vi.advanceTimersByTimeAsync(20000)
    expect(giveUp).not.toHaveBeenCalled()
  })

  test('a page that cannot be asked counts as not mounted', async () => {
    page.executeJavaScript.mockRejectedValue(new Error('no frame'))
    navigate()
    await vi.advanceTimersByTimeAsync(15000)
    expect(giveUp).toHaveBeenCalledTimes(1)
  })

  test('a new navigation restarts the wait; a subframe or in-page one does not', async () => {
    navigate()
    await vi.advanceTimersByTimeAsync(10000)
    page.emit('did-start-navigation', {}, 'file:///f', false, false)
    page.emit('did-start-navigation', {}, 'file:///index.html#x', true, true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(giveUp).toHaveBeenCalledTimes(1)
    navigate()
    await vi.advanceTimersByTimeAsync(10000)
    navigate()
    await vi.advanceTimersByTimeAsync(10000)
    expect(giveUp).toHaveBeenCalledTimes(1)
  })

  test('destroyed disarms it', async () => {
    navigate()
    page.emit('destroyed')
    await vi.advanceTimersByTimeAsync(20000)
    expect(page.executeJavaScript).not.toHaveBeenCalled()
  })
})
