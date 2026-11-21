import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runAttach } from '../../src/relay/attach'
import { RelayDaemon, RESTART_EXIT_CODE, type RelayDaemonOptions } from '../../src/relay/daemon'
import { relayPaths, type RelayPaths } from '../../src/relay/paths'
import { loadState } from '../../src/relay/stateStore'
import {
  LineDecoder,
  RELAY_PROTO,
  encodeFrame,
  type AttachResult,
  type RelayFrame,
  type RelayMethod
} from '../../src/shared/relayProtocol'
import type { FakeScript } from '../fixtures/fake-sdk/index.mjs'
import { cleanTemps, fakeFactory, manualClock, tempDir, until } from './relayHarness'

type Res = Extract<RelayFrame, { t: 'res' }>
type Ev = Extract<RelayFrame, { t: 'ev' }>

const daemons: RelayDaemon[] = []
const sockets: Socket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const d of daemons.splice(0)) await d.stop()
  cleanTemps()
})

class Client {
  readonly frames: RelayFrame[] = []
  closed = false
  private next = 1
  private readonly decoder = new LineDecoder()
  private constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.frames.push(...this.decoder.push(chunk)))
    socket.on('close', () => {
      this.closed = true
    })
  }

  static async open(paths: RelayPaths, hello: boolean | number = true): Promise<Client> {
    const socket = connect(paths.socket)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const client = new Client(socket)
    if (hello !== false) {
      const proto = typeof hello === 'number' ? hello : RELAY_PROTO
      client.write({ t: 'hello', proto, app: 'test', client: 'vitest' })
      if (proto === RELAY_PROTO) await until(() => client.frames.some((f) => f.t === 'welcome'), 5000, 'welcome')
    }
    return client
  }

  write(frame: RelayFrame): void {
    this.socket.write(encodeFrame(frame))
  }

  async request(m: RelayMethod, p: unknown = {}): Promise<Res> {
    const id = this.next++
    this.write({ t: 'req', id, m, p })
    await until(() => this.frames.some((f) => f.t === 'res' && f.id === id), 8000, `ответ на ${m}`)
    return this.frames.find((f) => f.t === 'res' && f.id === id) as Res
  }

  async ok<T>(m: RelayMethod, p: unknown = {}): Promise<T> {
    const res = await this.request(m, p)
    if (!res.ok) throw new Error(`${m}: ${res.e.code} ${res.e.message}`)
    return res.r as T
  }

  evs(s: string): Ev[] {
    return this.frames.filter((f): f is Ev => f.t === 'ev' && f.s === s)
  }

  async close(): Promise<void> {
    this.socket.end()
    await until(() => this.closed, 5000, 'закрытие')
  }
}

function setup(script: FakeScript = {}, extra: Partial<RelayDaemonOptions> = {}, base?: string) {
  const root = base ?? tempDir('qclod-daemon-')
  const paths = relayPaths(root, process.platform, join(root, '.qclod'))
  const fake = fakeFactory(script)
  const exits: number[] = []
  const daemon = new RelayDaemon({
    paths,
    version: '1.0.0-test',
    createDriver: fake.factory,
    claudePath: () => '/home/u/.local/bin/claude',
    exit: (code) => exits.push(code),
    home: root,
    ...extra
  })
  daemons.push(daemon)
  return { root, paths, fake, daemon, exits }
}

const isResult = (e: Ev): boolean => (e.d as { type?: string }).type === 'result'

describe('демон посредника', () => {
  test('welcome: протокол, версия, версия файла, время старта', async () => {
    const t = setup({}, { binaryVersion: async () => '1.0.1', now: () => 777 })
    expect(await t.daemon.start()).toBe(true)
    const c = await Client.open(t.paths)
    expect(c.frames.find((f) => f.t === 'welcome')).toEqual({
      t: 'welcome',
      proto: RELAY_PROTO,
      relay: '1.0.0-test',
      binary: '1.0.1',
      startedAt: 777
    })
    expect(t.daemon.clients).toBe(1)
  })

  test('без hello за 10 с соединение закрыто', async () => {
    const clock = manualClock()
    const t = setup({}, { clock })
    await t.daemon.start()
    const c = await Client.open(t.paths, false)
    await until(() => clock.pending > 0, 5000, 'таймер hello')
    clock.advance(9_999)
    await new Promise((r) => setTimeout(r, 30))
    expect(c.closed).toBe(false)
    clock.advance(1)
    await until(() => c.closed, 5000, 'закрытие')
    expect(c.frames).toContainEqual({ t: 'res', id: 0, ok: false, e: { code: 'proto', message: 'нет hello' } })
  })

  test('чужой proto — отказ proto', async () => {
    const t = setup()
    await t.daemon.start()
    const c = await Client.open(t.paths, 2)
    await until(() => c.closed, 5000, 'закрытие')
    const res = c.frames.find((f) => f.t === 'res') as Res
    expect(res.ok).toBe(false)
    expect(!res.ok && res.e.code).toBe('proto')
    expect(c.frames.some((f) => f.t === 'welcome')).toBe(false)
  })

  test('attach после обрыва дочитывает с after', async () => {
    const t = setup({ sessionId: 'sdk-a' })
    await t.daemon.start()
    const first = await Client.open(t.paths)
    const opened = await first.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default', title: 'Чат' })
    const s = opened.snapshot.s
    expect(opened.snapshot).toMatchObject({ cwd: t.root, title: 'Чат', mode: 'default', lastSeq: 0 })
    await first.ok('drv', { s, op: 'send', args: [{ text: 'раз', attachments: [] }] })
    await until(() => first.evs(s).some(isResult), 5000, 'первый result')
    const seen = first.evs(s).map((e) => e.q)
    const after = Math.max(...seen)
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => i + 1))
    await first.close()

    const second = await Client.open(t.paths)
    await second.ok('session.attach', { s, after })
    await second.ok('drv', { s, op: 'send', args: [{ text: 'два', attachments: [] }] })
    await until(() => second.evs(s).some(isResult), 5000, 'второй result')
    const last = Math.max(...second.evs(s).map((e) => e.q))

    const again = await Client.open(t.paths)
    const res = await again.ok<AttachResult>('session.attach', { s, after })
    expect(res.gap).toBe(false)
    expect(res.snapshot.lastSeq).toBe(last)
    await until(() => again.evs(s).length >= last - after, 5000, 'дочитывание')
    const missed = again.evs(s).map((e) => e.q)
    expect(missed).toEqual(Array.from({ length: last - after }, (_, i) => after + 1 + i))
    expect(again.evs(s).find((e) => e.k === 'sent')!.d).toMatchObject({ input: { text: 'два' } })
    // the answer came before the journal
    const resAt = again.frames.findIndex((f) => f.t === 'res')
    const firstEv = again.frames.findIndex((f) => f.t === 'ev')
    expect(resAt).toBeLessThan(firstEv)
  })

  test('два демона: второй выходит, первый работает', async () => {
    const a = setup()
    expect(await a.daemon.start()).toBe(true)
    const b = setup({}, {}, a.root)
    expect(await b.daemon.start()).toBe(false)
    const c = await Client.open(a.paths)
    c.write({ t: 'ping' })
    await until(() => c.frames.some((f) => f.t === 'pong'), 5000, 'pong')
    expect(existsSync(a.paths.lock)).toBe(true)
  })

  test('relay.restart idle ждёт, пока все сессии свободны', async () => {
    const t = setup({ nextTurn: [{ kind: 'tool', name: 'Bash', input: { command: 'make' }, result: 'ok', pauseMs: 400 }] })
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const { snapshot } = await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })
    const s = snapshot.s
    await c.ok('drv', { s, op: 'send', args: [{ text: 'собери', attachments: [] }] })
    expect(await c.ok('relay.restart', { when: 'idle' })).toEqual({ scheduled: true, busy: 1 })
    await new Promise((r) => setTimeout(r, 100))
    expect(t.exits).toEqual([])
    await until(() => t.exits.length > 0, 5000, 'выход')
    expect(t.exits).toEqual([RESTART_EXIT_CODE])
    expect(c.evs(s).some(isResult)).toBe(true)
    expect(existsSync(t.paths.lock)).toBe(false)
  })

  test('после перезапуска сессии восстановлены, wasRunning получает продолжай', async () => {
    const t = setup({
      sessionId: 'sdk-long',
      nextTurn: [{ kind: 'tool', name: 'Bash', input: { command: 'make' }, result: 'ok', pauseMs: 5000 }]
    })
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const { snapshot } = await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'acceptEdits' })
    const s = snapshot.s
    await c.ok('drv', { s, op: 'send', args: [{ text: 'собери', attachments: [] }] })
    await until(() => c.evs(s).some((e) => (e.d as { type?: string }).type === 'system'), 5000, 'init')
    expect(await c.ok('relay.restart', { when: 'now' })).toEqual({ scheduled: true, busy: 1 })
    await until(() => t.exits.length > 0, 5000, 'выход')
    const saved = loadState(t.paths.state).sessions.find((r) => r.s === s)!
    expect(saved).toMatchObject({ wasRunning: true, sdkSessionId: 'sdk-long', mode: 'acceptEdits' })
    expect(t.fake.drivers[0]!.disposed).toBe(true)

    const next = setup({}, {}, t.root)
    expect(await next.daemon.start()).toBe(true)
    expect(next.fake.options[0]!.resume).toBe('sdk-long')
    const c2 = await Client.open(next.paths)
    const list = await c2.ok<Array<{ s: string }>>('session.list')
    expect(list.map((x) => x.s)).toEqual([s])
    await c2.ok('session.attach', { s, after: 0 })
    await until(
      () => c2.evs(s).some((e) => e.k === 'sent' && (e.d as { by: string }).by === 'autonomy'),
      5000,
      'продолжай'
    )
    const continued = c2.evs(s).find((e) => e.k === 'sent' && (e.d as { by: string }).by === 'autonomy')!
    expect(continued.d).toMatchObject({ input: { text: 'продолжай' } })
  })

  test('ответ на неизвестный метод — bad_request, соединение живо', async () => {
    const t = setup()
    await t.daemon.start()
    const c = await Client.open(t.paths)
    c.socket.write('{"t":"req","id":5,"m":"rm.rf","p":{}}\n')
    await until(() => c.frames.some((f) => f.t === 'res' && f.id === 5), 5000, 'ответ')
    const res = c.frames.find((f) => f.t === 'res' && f.id === 5) as Res
    expect(!res.ok && res.e.code).toBe('bad_request')
    c.write({ t: 'ping' })
    await until(() => c.frames.some((f) => f.t === 'pong'), 5000, 'pong')
    expect(c.closed).toBe(false)
  })

  test('git.run до этапа 7 — unsupported; чужая операция drv — bad_request; нет сессии — not_found', async () => {
    const t = setup()
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const git = await c.request('git.run', { cwd: t.root, args: ['status'], timeoutMs: 1000, maxBytes: 10 })
    expect(!git.ok && git.e.code).toBe('unsupported')
    const { snapshot } = await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })
    const bad = await c.request('drv', { s: snapshot.s, op: 'dispose', args: [] })
    expect(!bad.ok && bad.e.code).toBe('bad_request')
    const missing = await c.request('session.attach', { s: 'nope', after: 0 })
    expect(!missing.ok && missing.e.code).toBe('not_found')
    const noDir = await c.request('session.open', { cwd: join(t.root, 'нет-такой'), mode: 'default' })
    expect(!noDir.ok && noDir.e.code).toBe('not_found')
  })

  test('нет claude на сервере — session.open говорит об этом', async () => {
    const t = setup({}, { claudePath: () => null })
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const res = await c.request('session.open', { cwd: t.root, mode: 'default' })
    expect(!res.ok && res.e).toEqual({ code: 'not_found', message: 'Claude Code на сервере не найден' })
  })

  test('разрешение уходит обоим клиентам, второй ответ не принят', async () => {
    const t = setup({ nextTurn: [{ kind: 'askPermission', name: 'Bash', input: { command: 'ls' } }] })
    await t.daemon.start()
    const pc = await Client.open(t.paths)
    const { snapshot } = await pc.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })
    const s = snapshot.s
    const mac = await Client.open(t.paths)
    await mac.ok('session.attach', { s, after: 0 })
    await pc.ok('drv', { s, op: 'send', args: [{ text: 'го', attachments: [] }] })
    const perm = (c: Client) => c.frames.find((f) => f.t === 'live' && f.k === 'perm')
    await until(() => !!perm(pc) && !!perm(mac), 5000, 'perm у обоих')
    const requestId = ((perm(pc) as Extract<RelayFrame, { t: 'live' }>).d as { requestId: string }).requestId
    expect(await mac.ok('perm.answer', { s, requestId, answer: { behavior: 'allow' } })).toEqual({ accepted: true })
    expect(await pc.ok('perm.answer', { s, requestId, answer: { behavior: 'deny' } })).toEqual({ accepted: false })
    await until(() => pc.evs(s).some(isResult), 5000, 'result')
  })

  test('правила и срок авто-ответа пишутся в state.json', async () => {
    const t = setup()
    await t.daemon.start()
    const c = await Client.open(t.paths)
    await c.ok('rules.sync', { rules: [{ id: 'r', toolName: 'Bash', target: 'ls', behavior: 'allow' }, { bad: 1 }] })
    await c.ok('autonomy.settings', { autoAnswerMs: 120_000 })
    const bad = await c.request('autonomy.settings', { autoAnswerMs: -5 })
    expect(!bad.ok && bad.e.code).toBe('bad_request')
    const state = JSON.parse(readFileSync(t.paths.state, 'utf8'))
    expect(state.rules).toEqual([{ id: 'r', toolName: 'Bash', target: 'ls', behavior: 'allow' }])
    expect(state.autoAnswerMs).toBe(120_000)
  })

  test('close останавливает агента, detach — нет', async () => {
    const t = setup()
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const a = (await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })).snapshot.s
    const b = (await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })).snapshot.s
    await until(() => t.fake.drivers.length === 2, 5000, 'два агента')
    await c.ok('session.detach', { s: a })
    await c.ok('session.close', { s: b })
    expect(t.fake.drivers[0]!.disposed).toBe(false)
    expect(t.fake.drivers[1]!.disposed).toBe(true)
    const list = await c.ok<Array<{ s: string }>>('session.list')
    expect(list.map((x) => x.s)).toEqual([a])
    expect(loadState(t.paths.state).sessions.find((r) => r.s === b)!.closedAt).toBeTypeOf('number')
  })
})

describe('attach', () => {
  test('stdio ↔ сокет; без демона — запуск и повтор', async () => {
    const t = setup()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const decoder = new LineDecoder()
    const out: RelayFrame[] = []
    stdout.on('data', (chunk: Buffer) => out.push(...decoder.push(chunk)))
    let started = 0
    const done = runAttach(t.paths, { stdin, stdout }, async () => {
      started++
      await t.daemon.start()
    })
    stdin.write(encodeFrame({ t: 'hello', proto: RELAY_PROTO, app: 'test', client: 'attach' }))
    await until(() => out.some((f) => f.t === 'welcome'), 8000, 'welcome через attach')
    expect(started).toBe(1)
    stdin.write(encodeFrame({ t: 'ping' }))
    await until(() => out.some((f) => f.t === 'pong'), 5000, 'pong')
    stdin.end()
    expect(await done).toBe(0)
  })

  test('демон не поднялся — код 1', async () => {
    const t = setup()
    const code = await runAttach(t.paths, { stdin: new PassThrough(), stdout: new PassThrough() }, async () => undefined, 300)
    expect(code).toBe(1)
  })
})
