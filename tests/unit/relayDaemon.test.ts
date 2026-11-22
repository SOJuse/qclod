import { afterEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runAttach } from '../../src/relay/attach'
import {
  HOUSEKEEP_MS,
  RelayDaemon,
  RESTART_EXIT_CODE,
  TOO_LARGE_NOTICE,
  looksLikeRelayDaemon,
  type RelayDaemonOptions
} from '../../src/relay/daemon'
import { relayMethods } from '../../src/relay/methods'
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

describe('замок демона', () => {
  /** A lock as a dead daemon left it: written `ageMs` ago. */
  function leftLock(paths: RelayPaths, text: string, ageMs: number): void {
    mkdirSync(paths.run, { recursive: true })
    writeFileSync(paths.lock, text)
    const at = new Date(Date.now() - ageMs)
    utimesSync(paths.lock, at, at)
  }

  test('в замке pid чужого живого процесса, сокета нет → демон стартует', async () => {
    const t = setup()
    // The parent of this test process: alive, ours, and no relay daemon (a pid reused after a crash).
    leftLock(t.paths, String(process.ppid), 60 * 60_000)
    expect(await t.daemon.start()).toBe(true)
    expect(readFileSync(t.paths.lock, 'utf8')).toBe(String(process.pid))
    const c = await Client.open(t.paths)
    c.write({ t: 'ping' })
    await until(() => c.frames.some((f) => f.t === 'pong'), 5000, 'pong')
  })

  test('в замке pid этого же процесса (тот же pid после перезагрузки) → демон стартует', async () => {
    const t = setup()
    leftLock(t.paths, String(process.pid), 60 * 60_000)
    expect(await t.daemon.start()).toBe(true)
  })

  test('пустой замок — не удаляется: его демон ещё пишет pid', async () => {
    const t = setup({}, { lockWaitMs: 300 })
    leftLock(t.paths, '', 0)
    expect(await t.daemon.start()).toBe(false)
    expect(existsSync(t.paths.lock)).toBe(true)
    expect(readFileSync(t.paths.lock, 'utf8')).toBe('')
  })

  test('пустой замок давнего сбоя — снят', async () => {
    const t = setup({}, { lockWaitMs: 300 })
    leftLock(t.paths, '', 60 * 60_000)
    expect(await t.daemon.start()).toBe(true)
  })

  test('замок занят, но демон его отвечает — второй выходит, замок цел', async () => {
    const a = setup()
    expect(await a.daemon.start()).toBe(true)
    const before = readFileSync(a.paths.lock, 'utf8')
    const b = setup({}, { lockWaitMs: 300 }, a.root)
    expect(await b.daemon.acquire()).toBe(false)
    expect(readFileSync(a.paths.lock, 'utf8')).toBe(before)
  })

  test('cmdline: qclod-relay daemon — да, чужая программа — нет, нет /proc — неизвестно', () => {
    const cmd = (...argv: string[]) => () => Buffer.from(argv.join('\0') + '\0')
    expect(looksLikeRelayDaemon(5, cmd('/home/u/.qclod/bin/qclod-relay', 'daemon'))).toBe(true)
    expect(looksLikeRelayDaemon(5, cmd('/usr/bin/node', '/x/out/relay/relay.cjs', 'daemon'))).toBe(true)
    expect(looksLikeRelayDaemon(5, cmd('/home/u/.qclod/bin/qclod-relay', 'attach'))).toBe(false)
    expect(looksLikeRelayDaemon(5, cmd('/usr/sbin/sshd', '-D'))).toBe(false)
    expect(
      looksLikeRelayDaemon(5, () => {
        throw new Error('ENOENT')
      })
    ).toBeNull()
  })
})

describe('остановка, уборка, кадры', () => {
  test('stop при работающем ходе: wasRunning сразу, смерть потока при остановке — не смерть', async () => {
    // The agent's stream, cut from outside as systemd's SIGTERM to the whole unit would.
    const fake = fakeFactory({
      sessionId: 'sdk-long',
      nextTurn: [{ kind: 'tool', name: 'Bash', input: { command: 'make' }, result: 'ok', pauseMs: 5000 }]
    })
    let cut = (): void => undefined
    const createDriver: RelayDaemonOptions['createDriver'] = async (opts) => {
      const driver = (await fake.factory(opts)) as unknown as { messages: AsyncIterable<unknown> }
      const inner = driver.messages[Symbol.asyncIterator]()
      const killed = new Promise<IteratorResult<unknown>>((resolve) => {
        cut = () => resolve({ done: true, value: undefined })
      })
      driver.messages = (async function* () {
        for (;;) {
          const next = await Promise.race([inner.next(), killed])
          if (next.done) throw new Error('claude: terminated')
          yield next.value
        }
      })()
      return driver as never
    }
    const t = setup({}, { createDriver })
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const { snapshot } = await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'acceptEdits' })
    const s = snapshot.s
    await c.ok('drv', { s, op: 'send', args: [{ text: 'собери', attachments: [] }] })
    await until(() => c.evs(s).some((e) => (e.d as { type?: string }).type === 'system'), 5000, 'init')
    const session = t.daemon.sessions()[0]!
    const events: string[] = []
    session.onEvent((e) => events.push(e.type))
    // systemd's stop signals the agent too: its stream ends as the daemon begins to stop.
    const stopping = t.daemon.stop()
    cut()
    await stopping
    const saved = loadState(t.paths.state).sessions.find((r) => r.s === s)!
    expect(saved.wasRunning).toBe(true)
    expect(events).not.toContain('died')
    const notices = readFileSync(join(t.paths.sessions, s, 'journal.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { k: string })
      .filter((r) => r.k === 'notice')
    expect(notices).toEqual([])
  })

  test('stop дважды (сигнал во время перезапуска) — второй ждёт первый', async () => {
    const t = setup()
    await t.daemon.start()
    const a = t.daemon.stop()
    const b = t.daemon.stop()
    expect(b).toBe(a)
    await a
    expect(existsSync(t.paths.lock)).toBe(false)
  })

  test('уборка: закрытые старше 30 дней — с журналом и загрузками; загрузки без открытой сессии — вон', async () => {
    let now = 1_000_000_000_000
    const base = tempDir('qclod-daemon-')
    const t = setup(
      {},
      {
        now: () => now,
        methods: relayMethods({
          run: async () => ({ code: 1, stdout: '' }),
          version: '1.0.0-test',
          claudePath: () => '/opt/claude',
          home: base,
          listSessions: async () => []
        })
      },
      base
    )
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const open = (await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })).snapshot.s
    const closed = (await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })).snapshot.s
    const up = (s: string) =>
      c.ok<{ path: string }>('fs.upload', { s, name: 'a.txt', offset: 0, dataBase64: 'eA==', final: true })
    await up(open)
    await up(closed)
    // an upload for a session that is not open here makes no folder
    const stray = await c.request('fs.upload', { s: 'nobody', name: 'a.txt', offset: 0, dataBase64: 'eA==', final: true })
    expect(!stray.ok && stray.e.code).toBe('not_found')
    expect(existsSync(join(t.paths.uploads, 'nobody'))).toBe(false)
    // «Закрыть чат»: its uploads go at once, the journal stays
    await c.ok('session.close', { s: closed })
    expect(existsSync(join(t.paths.uploads, closed))).toBe(false)
    expect(existsSync(join(t.paths.sessions, closed))).toBe(true)
    // a folder left by a state that no longer knows it
    mkdirSync(join(t.paths.uploads, 'orphan'), { recursive: true })
    writeFileSync(join(t.paths.uploads, 'orphan', '1-x'), 'x')
    now += 31 * 24 * 60 * 60_000
    t.daemon.housekeep()
    expect(existsSync(join(t.paths.sessions, closed))).toBe(false)
    expect(existsSync(join(t.paths.uploads, 'orphan'))).toBe(false)
    expect(existsSync(join(t.paths.uploads, open, '1-a.txt'))).toBe(true)
    expect(loadState(t.paths.state).sessions.map((r) => r.s)).toEqual([open])
  })

  test('уборка раз в сутки — по таймеру, который не держит процесс', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const t = setup()
      await t.daemon.start()
      const housekeep = vi.spyOn(t.daemon, 'housekeep')
      vi.advanceTimersByTime(HOUSEKEEP_MS - 1)
      expect(housekeep).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(housekeep).toHaveBeenCalledTimes(1)
      await t.daemon.stop()
      vi.advanceTimersByTime(HOUSEKEEP_MS)
      expect(housekeep).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('attach с after больше lastSeq — gap и всё новое с номера журнала', async () => {
    const t = setup({ nextTurn: [{ kind: 'text', text: 'привет' }] })
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const s = (await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })).snapshot.s
    const other = await Client.open(t.paths)
    const res = await other.ok<AttachResult>('session.attach', { s, after: 500 })
    expect(res.gap).toBe(true)
    expect(res.snapshot.lastSeq).toBe(0)
    await other.ok('drv', { s, op: 'send', args: [{ text: 'раз', attachments: [] }] })
    await until(() => other.evs(s).some(isResult), 5000, 'result')
    expect(other.evs(s)[0]!.q).toBe(1)
  })

  test('запись больше 16 МиБ — клиенту notice под её номером, не тишина', async () => {
    const t = setup()
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const s = (await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })).snapshot.s
    const session = t.daemon.sessions()[0]!
    const big = session.append('sdk', { type: 'assistant', text: 'x'.repeat(17 * 1024 * 1024) })
    session.append('notice', { kind: 'text', text: 'после', tone: 'info' })
    await until(() => c.evs(s).length >= 2, 8000, 'кадры')
    expect(c.evs(s)[0]).toMatchObject({ q: big.q, k: 'notice', d: TOO_LARGE_NOTICE })
    expect(c.evs(s)[1]).toMatchObject({ q: big.q + 1, k: 'notice' })
  })

  test('дочитывание журнала больше предела — не повод отключать', async () => {
    const t = setup({}, { backlogMax: 256 * 1024 })
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const s = (await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })).snapshot.s
    const session = t.daemon.sessions()[0]!
    for (let i = 0; i < 32; i++) session.append('notice', { kind: 'text', text: 'z'.repeat(64 * 1024), tone: 'info' })
    const late = await Client.open(t.paths)
    await late.ok('session.attach', { s, after: 0 })
    await until(() => late.evs(s).length === 32, 8000, 'весь журнал')
    expect(late.closed).toBe(false)
  })

  test('клиент не читает — отключён, когда отстал больше предела', async () => {
    const t = setup({}, { backlogMax: 256 * 1024 })
    await t.daemon.start()
    const c = await Client.open(t.paths)
    await c.ok<AttachResult>('session.open', { cwd: t.root, mode: 'default' })
    c.socket.pause()
    const session = t.daemon.sessions()[0]!
    const text = 'y'.repeat(64 * 1024)
    for (let i = 0; i < 200 && !c.closed; i++) {
      session.append('notice', { kind: 'text', text, tone: 'info' })
      await new Promise((r) => setTimeout(r, 1))
    }
    c.socket.resume()
    await until(() => c.closed, 5000, 'отключение')
    expect(t.daemon.clients).toBe(0)
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

describe('файлы, история и аккаунт через сокет', () => {
  test('fs.list, fs.upload, fs.read, history.list, auth.status, host.info', async () => {
    const root = tempDir('qclod-daemon-')
    const t = setup(
      {},
      {
        methods: relayMethods({
          run: async (_cmd, args) =>
            args[0] === '--version'
              ? { code: 0, stdout: '2.1.317 (Claude Code)' }
              : { code: 0, stdout: '{"loggedIn":true,"email":"a@b.c"}' },
          version: '1.0.0-test',
          claudePath: () => '/opt/claude',
          home: root,
          listSessions: async ({ dir }) => [{ sessionId: 'old-1', summary: `в ${dir}`, lastModified: 5 }]
        }),
        home: root
      },
      root
    )
    await t.daemon.start()
    const c = await Client.open(t.paths)
    const list = await c.ok<{ path: string; entries: Array<{ name: string }> }>('fs.list', { path: '~' })
    expect(list.path).toBe(root)
    expect(list.entries.map((e) => e.name)).toContain('.qclod')
    const s = (await c.ok<AttachResult>('session.open', { cwd: root, mode: 'default' })).snapshot.s
    const up = await c.ok<{ path: string }>('fs.upload', {
      s,
      name: 'a.txt',
      offset: 0,
      dataBase64: Buffer.from('привет').toString('base64'),
      final: true
    })
    expect(up.path).toBe(join(t.paths.uploads, s, '1-a.txt'))
    const read = await c.ok<{ dataBase64: string; eof: boolean }>('fs.read', { path: up.path, offset: 0, length: 1024 })
    expect(Buffer.from(read.dataBase64, 'base64').toString('utf8')).toBe('привет')
    expect(read.eof).toBe(true)
    const tooBig = await c.request('fs.read', { path: up.path, offset: 0, length: 300 * 1024 })
    expect(!tooBig.ok && tooBig.e.code).toBe('bad_request')
    expect(await c.ok('history.list', { cwd: '~/app' })).toEqual([
      { id: 'old-1', title: `в ${join(root, 'app')}`, firstMessage: '', updatedAt: 5 }
    ])
    expect(await c.ok('auth.status')).toEqual({
      loggedIn: true,
      email: 'a@b.c',
      claudePath: '/opt/claude',
      claudeVersion: '2.1.317'
    })
    const info = await c.ok<Record<string, unknown>>('host.info')
    expect(info).toMatchObject({ home: root, relay: '1.0.0-test', linger: 'unknown' })
    expect(['x64', 'arm64']).toContain(info['arch'])
  })
})
