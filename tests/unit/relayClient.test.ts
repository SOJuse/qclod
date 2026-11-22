import { afterEach, describe, expect, test } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { RelayDaemon } from '../../src/relay/daemon'
import { Journal } from '../../src/relay/journal'
import { relayPaths, type RelayPaths } from '../../src/relay/paths'
import {
  CALL_TIMEOUT_MS,
  PONG_DEADLINE_MS,
  RelayCallError,
  RelayClient,
  STABLE_LINK_MS,
  localDeadline,
  type SessionSink
} from '../../src/main/ssh/relayClient'
import { socketTransport, type RelayTransport, type TransportFactory } from '../../src/main/ssh/transport'
import {
  LineDecoder,
  encodeFrame,
  type AttachResult,
  type RelayAutonomyView,
  type RelayFrame,
  type RelaySnapshot
} from '../../src/shared/relayProtocol'
import type { FakeScript } from '../fixtures/fake-sdk/index.mjs'
import { cleanTemps, fakeFactory, manualClock, tempDir, until } from './relayHarness'

type Ev = Extract<RelayFrame, { t: 'ev' }>
type Live = Extract<RelayFrame, { t: 'live' }>

const daemons: RelayDaemon[] = []
const clients: RelayClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.stop()
  cleanTemps()
})

function daemonAt(root: string, script: FakeScript = {}, now?: () => number) {
  const paths = relayPaths(root, process.platform, join(root, '.qclod'))
  const fake = fakeFactory(script)
  const daemon = new RelayDaemon({
    paths,
    version: '1.0.0-test',
    createDriver: fake.factory,
    claudePath: () => '/home/u/.local/bin/claude',
    exit: () => undefined,
    home: root,
    ...(now ? { now } : {})
  })
  daemons.push(daemon)
  return { paths, fake, daemon }
}

/** Real timers, but the reconnect ladder and pings 50 times faster; call timeouts as they are. */
const fastTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms < CALL_TIMEOUT_MS ? ms / 50 : ms)
  t.unref?.()
  return t
}

/** The socket transport, with the live ones kept so a test can break one. */
function tracked(paths: RelayPaths) {
  const made: RelayTransport[] = []
  const factory: TransportFactory = (o) => {
    const t = socketTransport(paths.socket)(o)
    made.push(t)
    return t
  }
  return { factory, made }
}

function client(factory: TransportFactory, extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
  const c = new RelayClient({ hostId: 'h1', appVersion: '1.0.0', clientName: 'vitest', transport: factory, setTimer: fastTimer, ...extra })
  clients.push(c)
  return c
}

function sink() {
  const evs: Ev[] = []
  const lives: Live[] = []
  const reattached: AttachResult[] = []
  const s: SessionSink = {
    onEvent: (f) => evs.push(f),
    onLive: (f) => lives.push(f),
    onReattached: (r) => reattached.push(r)
  }
  return { s, evs, lives, reattached }
}

const isResult = (e: Ev): boolean => (e.d as { type?: string }).type === 'result'

describe('RelayClient', () => {
  test('hello/welcome и вызов session.list', async () => {
    const d = daemonAt(tempDir('qclod-rc-'))
    await d.daemon.start()
    const c = client(socketTransport(d.paths.socket))
    const states: string[] = []
    c.onState((s) => states.push(s))
    const welcome = await c.connect(true)
    expect(welcome).toMatchObject({ t: 'welcome', proto: 1, relay: '1.0.0-test' })
    expect(c.state).toBe('online')
    expect(states).toEqual(['connecting', 'online'])
    expect(await c.call<RelaySnapshot[]>('session.list', {})).toEqual([])
    await expect(c.call('session.attach', { s: 'nope', after: 0 })).rejects.toMatchObject({ code: 'not_found' })
  })

  test('обрыв посреди хода: переподключение и дочитывание без потерь и дублей', async () => {
    const d = daemonAt(tempDir('qclod-rc-'), {
      nextTurn: [{ kind: 'textStream', pieces: Array.from({ length: 12 }, (_v, i) => `кусок ${i} `), pauseMs: 15 }]
    })
    await d.daemon.start()
    const t = tracked(d.paths)
    const c = client(t.factory)
    await c.connect(true)
    const k = sink()
    let broke = false
    const counting: SessionSink = {
      ...k.s,
      onEvent: (f) => {
        k.s.onEvent(f)
        if (k.evs.length === 3 && !broke) {
          broke = true
          t.made.at(-1)!.kill()
        }
      }
    }
    const opened = await c.open({ cwd: tempDir('qclod-rc-cwd-'), mode: 'default' }, counting)
    const s = opened.snapshot.s
    await c.call('drv', { s, op: 'send', args: [{ text: 'пиши', attachments: [] }] })
    await until(() => broke, 8000, 'обрыв')
    await until(() => c.state === 'online' && k.evs.some(isResult), 15000, 'дочитали до result')
    const list = await c.call<RelaySnapshot[]>('session.list', {})
    const last = list.find((x) => x.s === s)!.lastSeq
    await until(() => (k.evs.at(-1)?.q ?? 0) >= last, 5000, 'все записи')
    expect(k.evs.map((e) => e.q)).toEqual(Array.from({ length: last }, (_v, i) => i + 1))
    expect(t.made.length).toBeGreaterThanOrEqual(2)
    expect(k.reattached).toHaveLength(1)
    expect(k.reattached[0]!.gap).toBe(false)
  })

  test('gap даёт onReattached с gap: true', async () => {
    const root = tempDir('qclod-rc-')
    const first = daemonAt(root, { nextTurn: [{ kind: 'text', text: 'привет' }] })
    await first.daemon.start()
    const c = client(socketTransport(first.paths.socket))
    await c.connect(true)
    const k = sink()
    const s = (await c.open({ cwd: tempDir('qclod-rc-cwd-'), mode: 'default' }, k.s)).snapshot.s
    await c.call('drv', { s, op: 'send', args: [{ text: 'раз', attachments: [] }] })
    await until(() => k.evs.some(isResult), 8000, 'result')
    const seen = c.lastSeq(s)
    // The relay goes away; meanwhile the journal grows past 4 KiB and drops its older half.
    await first.daemon.stop()
    daemons.splice(daemons.indexOf(first.daemon), 1)
    await until(() => c.state !== 'online', 5000, 'обрыв')
    const journal = Journal.open(join(first.paths.sessions, s), { maxBytes: 4096 })
    for (let i = 0; i < 80; i++) journal.append('notice', { kind: 'text', text: `запись ${i} `.repeat(4), tone: 'info' })
    expect(journal.firstSeq).toBeGreaterThan(seen + 1)
    journal.close()
    const second = daemonAt(root)
    await second.daemon.start()
    await until(() => k.reattached.length === 1, 15000, 'onReattached')
    expect(k.reattached[0]!.gap).toBe(true)
  })

  test('журнал посредника пропал — gap, и новые записи с его номерами доходят', async () => {
    const root = tempDir('qclod-rc-')
    const first = daemonAt(root, { nextTurn: [{ kind: 'text', text: 'привет' }] })
    await first.daemon.start()
    const c = client(socketTransport(first.paths.socket))
    await c.connect(true)
    const k = sink()
    const s = (await c.open({ cwd: tempDir('qclod-rc-cwd-'), mode: 'default' }, k.s)).snapshot.s
    await c.call('drv', { s, op: 'send', args: [{ text: 'раз', attachments: [] }] })
    await until(() => k.evs.some(isResult), 8000, 'result')
    expect(c.lastSeq(s)).toBeGreaterThan(1)
    await first.daemon.stop()
    daemons.splice(daemons.indexOf(first.daemon), 1)
    await until(() => c.state !== 'online', 5000, 'обрыв')
    // The disk lost the journal: the relay starts it again from 1.
    rmSync(join(first.paths.sessions, s, 'journal.jsonl'), { force: true })
    const second = daemonAt(root, { nextTurn: [{ kind: 'text', text: 'снова' }] })
    await second.daemon.start()
    await until(() => k.reattached.length === 1, 15000, 'onReattached')
    expect(k.reattached[0]!.gap).toBe(true)
    const before = k.evs.length
    await c.call('drv', { s, op: 'send', args: [{ text: 'два', attachments: [] }] })
    await until(() => k.evs.slice(before).some(isResult), 8000, 'result после сброса')
    expect(k.evs.slice(before)[0]!.q).toBe(1)
  })

  test('authFailed не переподключается сам', async () => {
    let made = 0
    const refusing: TransportFactory = () => {
      made++
      const stdout = new PassThrough()
      let cb: ((code: number | null, stderr: string) => void) | null = null
      setTimeout(() => cb?.(255, 'me@box: Permission denied (publickey,password).\n'), 5)
      return { stdin: new PassThrough(), stdout, kill: () => undefined, onExit: (f) => void (cb = f) }
    }
    const c = client(refusing)
    await expect(c.connect(false)).rejects.toBeInstanceOf(RelayCallError)
    expect(c.state).toBe('needsAuth')
    await new Promise((r) => setTimeout(r, 300))
    expect(made).toBe(1)
  })

  test('вызов при обрыве — offline, send ждёт связи', async () => {
    const root = tempDir('qclod-rc-')
    const first = daemonAt(root)
    await first.daemon.start()
    const c = client(socketTransport(first.paths.socket))
    await c.connect(true)
    const k = sink()
    const s = (await c.open({ cwd: tempDir('qclod-rc-cwd-'), mode: 'default' }, k.s)).snapshot.s
    await first.daemon.stop()
    daemons.splice(daemons.indexOf(first.daemon), 1)
    await until(() => c.state === 'reconnecting' || c.state === 'offline', 5000, 'обрыв')
    await expect(c.call('session.list', {})).rejects.toMatchObject({ code: 'offline' })
    let sent = false
    const sending = c.call('drv', { s, op: 'send', args: [{ text: 'потом', attachments: [] }] }).then(() => {
      sent = true
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(sent).toBe(false)
    const second = daemonAt(root)
    await second.daemon.start()
    await sending
    expect(sent).toBe(true)
    await until(() => k.evs.some((e) => e.k === 'sent'), 8000, 'sent в журнале')
  })

  test('дедлайн при сдвиге часов ±10 мин', async () => {
    const SHIFT = 10 * 60_000
    for (const sign of [1, -1]) {
      const d = daemonAt(
        tempDir('qclod-rc-'),
        { nextTurn: [{ kind: 'askQuestion', question: 'Какой?', options: ['А', 'Б'] }] },
        () => Date.now() + sign * SHIFT
      )
      await d.daemon.start()
      const c = client(socketTransport(d.paths.socket))
      await c.connect(true)
      await c.call('autonomy.settings', { autoAnswerMs: 300_000 })
      const k = sink()
      const s = (await c.open({ cwd: tempDir('qclod-rc-cwd-'), mode: 'autoAllow' }, k.s)).snapshot.s
      await c.call('drv', { s, op: 'send', args: [{ text: 'спроси', attachments: [] }] })
      await until(
        () => k.lives.some((l) => l.k === 'autonomy' && (l.d as RelayAutonomyView).timers.length > 0),
        8000,
        'таймер'
      )
      const view = k.lives.filter((l) => l.k === 'autonomy').at(-1)!.d as RelayAutonomyView
      const remaining = view.timers[0]!.remainingMs
      expect(remaining).toBeGreaterThan(299_000)
      expect(remaining).toBeLessThanOrEqual(300_000)
      const here = Date.now()
      // The server's clock is ten minutes off; the deadline is not.
      expect(Math.abs(localDeadline(remaining, here) - (here + 300_000))).toBeLessThan(1000)
      c.close()
    }
  })

  test('канал, что рвётся сразу после hello, не сбрасывает лестницу пауз; устойчивый 30 с — сбрасывает', async () => {
    const clock = manualClock()
    const made: Array<{ exit: (code: number | null, stderr: string) => void }> = []
    const flaky: TransportFactory = () => {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const decoder = new LineDecoder()
      const rec = { exit: (_c: number | null, _s: string) => undefined as void }
      made.push(rec)
      stdin.on('data', (chunk: Buffer) => {
        for (const f of decoder.push(chunk)) {
          if (f.t === 'hello') stdout.write(encodeFrame({ t: 'welcome', proto: 1, relay: 'x', binary: 'x', startedAt: 0 }))
          if (f.t === 'ping') stdout.write(encodeFrame({ t: 'pong' }))
        }
      })
      return { stdin, stdout, kill: () => undefined, onExit: (cb) => void (rec.exit = cb) }
    }
    const settle = () => new Promise((r) => setTimeout(r, 10))
    const c = client(flaky, { now: clock.now, setTimer: clock.setTimeout })
    await c.connect(true)
    // Drops at once, every time.
    made[0]!.exit(255, 'Connection reset')
    clock.advance(1000)
    await until(() => made.length === 2 && c.state === 'online', 2000, 'вторая связь')
    made[1]!.exit(255, 'Connection reset')
    clock.advance(1000)
    await settle()
    // Not 1 s again: the ladder went on to 2 s.
    expect(made).toHaveLength(2)
    clock.advance(1000)
    await until(() => made.length === 3 && c.state === 'online', 2000, 'третья связь')
    // This one holds: after 30 s the ladder starts over.
    clock.advance(STABLE_LINK_MS)
    await settle()
    made[2]!.exit(255, 'Connection reset')
    clock.advance(1000)
    await until(() => made.length === 4, 2000, 'снова через 1 с')
  })

  test('исключение в обработчике кадра не теряет остальные кадры куска', async () => {
    let out: PassThrough | null = null
    const t: TransportFactory = () => {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      out = stdout
      const decoder = new LineDecoder()
      stdin.on('data', (chunk: Buffer) => {
        for (const f of decoder.push(chunk)) {
          if (f.t === 'hello') stdout.write(encodeFrame({ t: 'welcome', proto: 1, relay: 'x', binary: 'x', startedAt: 0 }))
          if (f.t === 'req' && f.m === 'session.attach') {
            stdout.write(encodeFrame({ t: 'res', id: f.id, ok: true, r: { snapshot: { s: 'S1' }, gap: false } }))
          }
        }
      })
      return { stdin, stdout, kill: () => undefined, onExit: () => undefined }
    }
    const c = client(t)
    await c.connect(true)
    const seen: number[] = []
    await c.attach('S1', 0, {
      onEvent: (f) => {
        seen.push(f.q)
        if (f.q === 1) throw new Error('сломался обработчик')
      },
      onLive: () => undefined,
      onReattached: () => undefined
    })
    const ev = (q: number) => encodeFrame({ t: 'ev', s: 'S1', q, k: 'notice', at: 1, d: { kind: 'text', text: 'x', tone: 'info' } })
    out!.write(ev(1) + ev(2) + ev(3))
    await until(() => seen.length === 3, 2000, 'все кадры')
    expect(seen).toEqual([1, 2, 3])
  })

  test('R4: пока вопрос ssh у человека, ожидание hello не истекает', async () => {
    const clock = manualClock()
    let asking = true
    let killed = false
    let stdout: PassThrough | null = null
    const t: TransportFactory = () => {
      stdout = new PassThrough()
      return { stdin: new PassThrough(), stdout, kill: () => void (killed = true), onExit: () => undefined, asking: () => asking }
    }
    const c = client(t, { now: clock.now, setTimer: clock.setTimeout })
    const connecting = c.connect(true)
    clock.advance(5 * 60_000)
    expect(killed).toBe(false)
    // The person answered; the relay greets.
    asking = false
    stdout!.write(encodeFrame({ t: 'welcome', proto: 1, relay: 'x', binary: 'x', startedAt: 0 }))
    await connecting
    expect(c.state).toBe('online')
    // Without a question, the 60 s hold as ever.
    const again = c.connect(true)
    clock.advance(60_000)
    await expect(again).rejects.toThrow('Посредник не ответил')
  })

  test('нет pong 45 с — переподключение', async () => {
    const clock = manualClock()
    const made: Array<{ stdin: PassThrough; killed: boolean; pings: number }> = []
    // A relay that welcomes and then goes silent: pings get no pong.
    const silent: TransportFactory = () => {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const rec = { stdin, killed: false, pings: 0 }
      made.push(rec)
      const decoder = new LineDecoder()
      let exit: ((code: number | null, stderr: string) => void) | null = null
      stdin.on('data', (chunk: Buffer) => {
        for (const f of decoder.push(chunk)) {
          if (f.t === 'hello') stdout.write(encodeFrame({ t: 'welcome', proto: 1, relay: 'x', binary: 'x', startedAt: 0 }))
          if (f.t === 'ping') rec.pings++
        }
      })
      return {
        stdin,
        stdout,
        kill: () => {
          rec.killed = true
          setTimeout(() => exit?.(null, ''), 0)
        },
        onExit: (cb) => void (exit = cb)
      }
    }
    const c = client(silent, { now: clock.now, setTimer: clock.setTimeout })
    await c.connect(true)
    expect(c.state).toBe('online')
    clock.advance(30_000)
    await new Promise((r) => setTimeout(r, 10))
    expect(made[0]!.pings).toBe(2)
    expect(made[0]!.killed).toBe(false)
    clock.advance(PONG_DEADLINE_MS - 30_000)
    await new Promise((r) => setTimeout(r, 10))
    expect(made[0]!.killed).toBe(true)
    expect(c.state).toBe('reconnecting')
    clock.advance(1000)
    await until(() => made.length === 2 && c.state === 'online', 2000, 'новая связь')
  })
})
