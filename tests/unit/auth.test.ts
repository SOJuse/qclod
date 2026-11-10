import { describe, expect, test, vi } from 'vitest'
import {
  AUTH_STATUS_TIMEOUT_MS,
  LOGIN_POLL_MS,
  LOGIN_WATCH_MAX_MS,
  LoginWatch,
  loginCommandLine,
  parseAuthStatus,
  readAuthStatus,
  type ExecLike
} from '@main/setup/auth'
import type { AuthStatus, LoginProgress } from '@shared/types'

describe('parseAuthStatus', () => {
  test.each([
    ['{"loggedIn":true,"authMethod":"claude.ai","email":"x@y.z"}', 0, 'in'],
    ['{"loggedIn":false}', 1, 'out'],
    ["error: unknown command 'auth'", 1, 'unknown'],
    ['что-то не то', 0, 'unknown'],
    ['{"authMethod":"claude.ai"}', 0, 'unknown']
  ])('parseAuthStatus(%s, %s) → %s', (out, code, want) => {
    expect(parseAuthStatus(out, code)).toBe(want)
  })
})

describe('loginCommandLine', () => {
  test('путь с пробелом и кириллицей уходит в кавычках', () => {
    expect(loginCommandLine('C:\\Users\\Иван Иванов\\.local\\bin\\claude.exe')).toBe(
      '"C:\\Users\\Иван Иванов\\.local\\bin\\claude.exe" auth login'
    )
  })
  test('старый cli.js запускается через node', () => {
    expect(loginCommandLine('C:\\npm\\cli.js')).toBe('node C:\\npm\\cli.js auth login')
  })
})

describe('readAuthStatus', () => {
  test('спрашивает auth status --json с таймаутом и читает «не вошёл»', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '{"loggedIn":false}', code: 1 }))
    await expect(readAuthStatus('C:\\a\\claude.exe', exec)).resolves.toBe('out')
    expect(exec).toHaveBeenCalledTimes(1)
    const [file, args, opts] = exec.mock.calls[0]
    expect(file).toBe('C:\\a\\claude.exe')
    expect(args).toEqual(['auth', 'status', '--json'])
    expect(opts.timeout).toBe(15000)
    expect(opts.windowsHide).toBe(true)
    expect(AUTH_STATUS_TIMEOUT_MS).toBe(15000)
  })

  test('cli.js спрашивается через node', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '{"loggedIn":true}', code: 0 }))
    await expect(readAuthStatus('C:\\npm\\cli.js', exec)).resolves.toBe('in')
    expect(exec.mock.calls[0][0]).toBe('node')
    expect(exec.mock.calls[0][1]).toEqual(['C:\\npm\\cli.js', 'auth', 'status', '--json'])
  })

  test('ENOENT — unknown, а не исключение', async () => {
    const exec: ExecLike = async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    }
    await expect(readAuthStatus('claude', exec)).resolves.toBe('unknown')
  })
})

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Manual clock and timers: a timer fires only when `tick` runs it. */
function fakeClock() {
  let time = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  let next = 1
  return {
    now: () => time,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = next++
      timers.set(id, { fn, at: time + ms })
      return id
    },
    clearTimer: (t: unknown): void => {
      timers.delete(t as number)
    },
    pending: () => timers.size,
    /** Advances to the earliest timer and runs it; false when none is left. */
    async tick(): Promise<boolean> {
      const first = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!first) return false
      const [id, timer] = first
      timers.delete(id)
      time = timer.at
      timer.fn()
      await flush()
      return true
    }
  }
}

async function drain(clock: ReturnType<typeof fakeClock>): Promise<void> {
  for (let n = 0; n < 100; n++) if (!(await clock.tick())) return
}

function watchWith(statuses: Array<AuthStatus | Error>, extra: { maxMs?: number } = {}) {
  const clock = fakeClock()
  const progress: LoginProgress[] = []
  let i = 0
  const check = vi.fn(async (): Promise<AuthStatus> => {
    const s = statuses[Math.min(i++, statuses.length - 1)]
    if (s instanceof Error) throw s
    return s
  })
  const watch = new LoginWatch({
    check,
    onProgress: (p) => progress.push(p),
    intervalMs: 100,
    ...extra,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  })
  return { clock, progress, check, watch }
}

describe('LoginWatch', () => {
  test('постоянные значения', () => {
    expect(LOGIN_POLL_MS).toBe(2000)
    expect(LOGIN_WATCH_MAX_MS).toBe(600000)
  })

  test('out, out, in → waiting и in, три проверки, после in таймеров нет', async () => {
    const { clock, progress, check, watch } = watchWith(['out', 'out', 'in'])
    watch.start()
    expect(watch.running).toBe(true)
    await drain(clock)
    expect(progress).toEqual(['waiting', 'in'])
    expect(check).toHaveBeenCalledTimes(3)
    expect(clock.pending()).toBe(0)
    expect(watch.running).toBe(false)
  })

  test('по истечении maxMs — timeout, и проверок больше нет', async () => {
    const { clock, progress, check, watch } = watchWith(['out'], { maxMs: 1000 })
    watch.start()
    await drain(clock)
    expect(progress).toEqual(['waiting', 'timeout'])
    const calls = check.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(11)
    expect(clock.pending()).toBe(0)
    expect(await clock.tick()).toBe(false)
    expect(check).toHaveBeenCalledTimes(calls)
    expect(watch.running).toBe(false)
  })

  test('start() дважды подряд — одна петля', async () => {
    const { clock, check, watch } = watchWith(['out', 'out', 'in'])
    watch.start()
    watch.start()
    expect(clock.pending()).toBe(1)
    await drain(clock)
    expect(check).toHaveBeenCalledTimes(3)
  })

  test('после in новый start начинает заново', async () => {
    const { clock, progress, check, watch } = watchWith(['in'])
    watch.start()
    await drain(clock)
    watch.start()
    expect(watch.running).toBe(true)
    await drain(clock)
    expect(progress).toEqual(['waiting', 'in', 'waiting', 'in'])
    expect(check).toHaveBeenCalledTimes(2)
  })

  test('check бросает — считается unknown, опрос продолжается', async () => {
    const { clock, progress, check, watch } = watchWith([new Error('boom'), 'in'])
    watch.start()
    await drain(clock)
    expect(check).toHaveBeenCalledTimes(2)
    expect(progress).toEqual(['waiting', 'in'])
  })

  test('следующая проверка планируется только после ответа предыдущей', async () => {
    const clock = fakeClock()
    let answer: ((s: AuthStatus) => void) | null = null
    const check = vi.fn(
      () =>
        new Promise<AuthStatus>((resolve) => {
          answer = resolve
        })
    )
    const watch = new LoginWatch({
      check,
      onProgress: () => undefined,
      intervalMs: 100,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    watch.start()
    await clock.tick()
    expect(check).toHaveBeenCalledTimes(1)
    expect(clock.pending()).toBe(0)
    answer!('out')
    await flush()
    expect(clock.pending()).toBe(1)
    watch.stop()
    expect(clock.pending()).toBe(0)
    expect(watch.running).toBe(false)
  })

  test('stop во время проверки — её ответ уже ничего не планирует и не сообщает', async () => {
    const clock = fakeClock()
    let answer: ((s: AuthStatus) => void) | null = null
    const progress: LoginProgress[] = []
    const watch = new LoginWatch({
      check: () =>
        new Promise<AuthStatus>((resolve) => {
          answer = resolve
        }),
      onProgress: (p) => progress.push(p),
      intervalMs: 100,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    watch.start()
    await clock.tick()
    watch.stop()
    answer!('in')
    await flush()
    expect(clock.pending()).toBe(0)
    expect(progress).toEqual(['waiting'])
  })
})
