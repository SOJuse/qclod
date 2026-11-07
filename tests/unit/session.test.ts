import { afterEach, describe, expect, test } from 'vitest'
import { Session } from '@main/sessions/Session'
import { SessionManager } from '@main/sessions/SessionManager'
import { AgentNotFoundError } from '@main/sessions/resolveExecutable'
import { DEFAULT_SETTINGS } from '@main/store/settingsStore'
import { FAKE_AGENT } from './helpers/pty'

const NODE = process.execPath
const PIPE = '\\\\.\\pipe\\qclod-test'

const open: Array<{ disposeAll?: () => Promise<void>; dispose?: () => Promise<void> }> = []

afterEach(async () => {
  for (const item of open.splice(0)) {
    await (item.disposeAll?.() ?? item.dispose?.())
  }
})

function makeSession(): Session {
  const s = new Session({
    tabId: 'tab-1',
    cwd: process.cwd(),
    file: NODE,
    args: [FAKE_AGENT]
  })
  open.push(s)
  return s
}

function waitFor(read: () => string, needle: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = setInterval(() => {
      if (read().includes(needle)) {
        clearInterval(tick)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick)
        reject(new Error(`timed out waiting for "${needle}" in:\n${read()}`))
      }
    }, 25)
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('Session', () => {
  test('start поднимает процесс и отдаёт вывод через onData', async () => {
    const s = makeSession()
    let out = ''
    s.onData((c) => (out += c))
    s.start()
    await waitFor(() => out, 'fake-agent ready')
    expect(s.pid).toBeGreaterThan(0)
  })

  test('write доставляет текст агенту', async () => {
    const s = makeSession()
    let out = ''
    s.onData((c) => (out += c))
    s.start()
    await waitFor(() => out, 'fake-agent ready')
    s.write('hello\r')
    await waitFor(() => out, '[submit 1]')
    expect(out).toContain('"hello"')
  })

  test('resize меняет размеры pty', async () => {
    const s = makeSession()
    let out = ''
    s.onData((c) => (out += c))
    s.start()
    await waitFor(() => out, 'fake-agent ready')
    expect(() => s.resize(120, 40)).not.toThrow()
    expect(s.size).toEqual({ cols: 120, rows: 40 })
  })

  test('resize до старта запоминается и применяется при старте', () => {
    const s = makeSession()
    s.resize(133, 44)
    s.start()
    expect(s.size).toEqual({ cols: 133, rows: 44 })
  })

  test('завершение агента приходит в onExit с его кодом', async () => {
    const s = makeSession()
    let out = ''
    let code: number | undefined
    s.onData((c) => (out += c))
    s.onExit((c) => (code = c))
    s.start()
    await waitFor(() => out, 'fake-agent ready')
    s.write('/exit 3\r')
    await waitFor(() => String(code), '3')
    expect(code).toBe(3)
  })

  test('dispose убивает процесс', async () => {
    const s = makeSession()
    let out = ''
    s.onData((c) => (out += c))
    s.start()
    await waitFor(() => out, 'fake-agent ready')
    const pid = s.pid
    await s.dispose()
    expect(alive(pid)).toBe(false)
  })

  test('отсутствующий исполняемый файл даёт понятную ошибку, а не падение', () => {
    const s = new Session({
      tabId: 'tab-x',
      cwd: process.cwd(),
      file: 'definitely-not-installed-agent',
      args: [],
      env: { PATH: '', PATHEXT: '.EXE' }
    })
    expect(() => s.start()).toThrow(AgentNotFoundError)
    expect(s.pid).toBe(0)
  })
})

describe('SessionManager', () => {
  function makeManager(): SessionManager {
    const m = new SessionManager({
      getSettings: () => ({ ...DEFAULT_SETTINGS, agentPath: NODE }),
      getUserHooks: () => undefined,
      pipePath: PIPE,
      // The fake agent is argv[0] for node; real launch args follow it.
      prefixArgs: [FAKE_AGENT]
    })
    open.push(m)
    return m
  }

  test('create поднимает сессию, доступную по id вкладки', async () => {
    const m = makeManager()
    let out = ''
    const s = m.create('t1', process.cwd(), {})
    s.onData((c) => (out += c))
    s.start()
    await waitFor(() => out, 'fake-agent ready')
    expect(m.get('t1')).toBe(s)
  })

  test('close гасит процесс и забывает вкладку', async () => {
    const m = makeManager()
    let out = ''
    const s = m.create('t1', process.cwd(), {})
    s.onData((c) => (out += c))
    s.start()
    await waitFor(() => out, 'fake-agent ready')
    const pid = s.pid
    await m.close('t1')
    expect(m.get('t1')).toBeUndefined()
    expect(alive(pid)).toBe(false)
  })

  test('disposeAll убивает все сессии и не оставляет сирот', async () => {
    const m = makeManager()
    const pids: number[] = []
    for (const id of ['a', 'b', 'c']) {
      let out = ''
      const s = m.create(id, process.cwd(), {})
      s.onData((c) => (out += c))
      s.start()
      await waitFor(() => out, 'fake-agent ready')
      pids.push(s.pid)
    }
    await m.disposeAll()
    for (const pid of pids) expect(alive(pid)).toBe(false)
    expect(m.get('a')).toBeUndefined()
  })

  test('аргументы запуска включают --settings с нашими хуками', () => {
    const m = makeManager()
    const s = m.create('t1', process.cwd(), { model: 'haiku' })
    expect(s.args).toContain('--settings')
    const settingsJson = s.args[s.args.indexOf('--settings') + 1]
    expect(settingsJson).toContain('Stop')
    expect(settingsJson).toContain('t1')
    expect(s.args[s.args.indexOf('--model') + 1]).toBe('haiku')
  })
})
