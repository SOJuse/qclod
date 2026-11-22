import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import {
  awakeNeeded,
  electronBlocker,
  EXECUTION_STATE_FLAGS,
  executionStateHelper,
  KeepAwake,
  RELEASE_GRACE_MS,
  USE_EXECUTION_STATE_HELPER,
  WIN_HELPER_SCRIPT,
  type KeepAwakeBackend
} from '../../src/main/system/keepAwake'
import { NO_AUTONOMY, type AutonomyView } from '../../src/shared/types'

const backend = (): KeepAwakeBackend & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } => ({
  start: vi.fn(),
  stop: vi.fn()
})

describe('KeepAwake', () => {
  test('set(true) запускает каждый бэкенд один раз; повторный set(true) — нет', () => {
    const a = backend()
    const b = backend()
    const k = new KeepAwake([a, b])
    k.set(true)
    k.set(true)
    expect(a.start).toHaveBeenCalledTimes(1)
    expect(b.start).toHaveBeenCalledTimes(1)
    expect(k.active).toBe(true)
  })

  test('set(false) отпускает через 2 минуты; set(true) в это время отменяет отпуск', () => {
    vi.useFakeTimers()
    try {
      const a = backend()
      const k = new KeepAwake([a])
      const seen: boolean[] = []
      k.onChange((v) => seen.push(v))
      k.set(true)
      k.set(false)
      vi.advanceTimersByTime(RELEASE_GRACE_MS - 1)
      expect(a.stop).not.toHaveBeenCalled()
      k.set(true)
      vi.advanceTimersByTime(RELEASE_GRACE_MS * 2)
      expect(a.stop).not.toHaveBeenCalled()
      expect(k.active).toBe(true)
      k.set(false)
      vi.advanceTimersByTime(RELEASE_GRACE_MS)
      expect(a.stop).toHaveBeenCalledTimes(1)
      expect(k.active).toBe(false)
      expect(seen).toEqual([true, false])
    } finally {
      vi.useRealTimers()
    }
  })

  test('dispose отпускает сразу', () => {
    const a = backend()
    const k = new KeepAwake([a])
    k.set(true)
    k.dispose()
    expect(a.stop).toHaveBeenCalledTimes(1)
    expect(k.active).toBe(false)
  })

  test('упавший бэкенд не мешает остальным', () => {
    const bad = backend()
    bad.start.mockImplementation(() => {
      throw new Error('boom')
    })
    const good = backend()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    new KeepAwake([bad, good]).set(true)
    expect(good.start).toHaveBeenCalled()
  })
})

describe('бэкенды', () => {
  test('electronBlocker: prevent-app-suspension, stop по id', () => {
    const psb = { start: vi.fn(() => 7), stop: vi.fn(), isStarted: vi.fn(() => true) }
    const b = electronBlocker(psb)
    b.start()
    expect(psb.start).toHaveBeenCalledWith('prevent-app-suspension')
    b.stop()
    expect(psb.stop).toHaveBeenCalledWith(7)
  })

  test('executionStateHelper: powershell.exe с флагами 0x80000041 и pid Qclod, windowsHide; stop убивает процесс', () => {
    const child = { kill: vi.fn(), on: vi.fn() }
    const spawn = vi.fn(() => child)
    const b = executionStateHelper(spawn as never, 4242)
    b.start()
    b.start()
    expect(spawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>]
    expect(cmd).toBe('powershell.exe')
    expect(args.slice(0, -1)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-Command'
    ])
    const script = args.at(-1)!
    expect(script).toContain('0x80000041')
    expect(script).toContain('Get-Process -Id 4242')
    expect(script).toBe(WIN_HELPER_SCRIPT(4242))
    expect(EXECUTION_STATE_FLAGS).toBe(0x80000041)
    expect(opts).toMatchObject({ windowsHide: true, stdio: 'ignore' })
    b.stop()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})

describe('awakeNeeded', () => {
  const waitView: AutonomyView = {
    ...NO_AUTONOMY,
    limitWait: { resetsAt: null, continueAt: 1, weekly: false } as never
  }
  test('busy, waiting или limitWait — true; idle, stopped, error без ожидания — false', () => {
    expect(awakeNeeded(['busy'], [])).toBe(true)
    expect(awakeNeeded(['idle', 'waiting'], [])).toBe(true)
    expect(awakeNeeded(['idle'], [waitView])).toBe(true)
    expect(awakeNeeded(['idle', 'stopped', 'error'], [NO_AUTONOMY])).toBe(false)
    expect(awakeNeeded([], [])).toBe(false)
  })
})

test('USE_EXECUTION_STATE_HELPER совпадает с выводом 07-keep-awake-probe.md', (ctx) => {
  const path = process.env['QCLOD_PROBE_NOTE']
  if (!path || !existsSync(path)) return ctx.skip()
  const m = /USE_EXECUTION_STATE_HELPER\s*=\s*(true|false)/.exec(readFileSync(path, 'utf8'))
  expect(m).not.toBeNull()
  expect(USE_EXECUTION_STATE_HELPER).toBe(m![1] === 'true')
})
