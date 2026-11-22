import { afterEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { noticeText } from '../../src/core/autonomy'
import { AgentSession } from '../../src/main/agent/AgentSession'
import { AgentSessionManager } from '../../src/main/agent/AgentSessionManager'
import { createDriverFactory } from '../../src/main/agent/createDriver'
import type { DriverOptions } from '../../src/main/agent/driver'
import { RelayDaemon } from '../../src/relay/daemon'
import { relayPaths, type RelayPaths } from '../../src/relay/paths'
import { CALL_TIMEOUT_MS, RelayClient, type SessionSink } from '../../src/main/ssh/relayClient'
import { ANSWER_LATER_TEXT, STREAM_RESET, createRelayDriver, toAutonomyView } from '../../src/main/ssh/relayDriver'
import { socketTransport, type RelayTransport, type TransportFactory } from '../../src/main/ssh/transport'
import {
  RELAY_DRIVER_OPS,
  type AttachResult,
  type PermResolved,
  type RelayFrame,
  type RelayPending,
  type RelaySnapshot
} from '../../src/shared/relayProtocol'
import type { PermissionAnswer, RibbonItem, TabServer } from '../../src/shared/types'
import type { RelayClientState } from '../../src/main/ssh/relayClient'
import type { FakeScript } from '../fixtures/fake-sdk/index.mjs'
import { cleanTemps, fakeFactory, manualClock, tempDir, until } from './relayHarness'

const daemons: RelayDaemon[] = []
const clients: RelayClient[] = []
const sessions: AgentSession[] = []
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.dispose({ detachOnly: true }).catch(() => undefined)
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.stop()
  cleanTemps()
})

const fastTimer = (fn: () => void, ms: number): unknown => {
  const t = setTimeout(fn, ms < CALL_TIMEOUT_MS ? ms / 50 : ms)
  t.unref?.()
  return t
}

function relay(script: FakeScript, clock?: ReturnType<typeof manualClock>) {
  const root = tempDir('qclod-rd-')
  const paths: RelayPaths = relayPaths(root, process.platform, join(root, '.qclod'))
  const fake = fakeFactory(script)
  const daemon = new RelayDaemon({
    paths,
    version: '1.0.0-test',
    createDriver: fake.factory,
    claudePath: () => '/home/u/.local/bin/claude',
    exit: () => undefined,
    home: root,
    ...(clock ? { clock, now: clock.now } : {})
  })
  daemons.push(daemon)
  return { paths, daemon, fake }
}

function connectTo(paths: RelayPaths) {
  const made: RelayTransport[] = []
  const factory: TransportFactory = (o) => {
    const t = socketTransport(paths.socket)(o)
    made.push(t)
    return t
  }
  const client = new RelayClient({ hostId: 'h1', appVersion: '1.0.0', clientName: 'vitest', transport: factory, setTimer: fastTimer })
  clients.push(client)
  const calls: Array<{ m: string; p: unknown }> = []
  const call = client.call.bind(client)
  client.call = (<T,>(m: Parameters<typeof call>[0], p: unknown, o?: { timeoutMs?: number }) => {
    calls.push({ m, p })
    return call<T>(m, p, o)
  }) as typeof client.call
  return { client, made, calls }
}

function serverSession(
  client: RelayClient,
  o: { server?: TabServer; mode?: 'autoAllow'; now?: () => number; onAlert?: (t: string) => void } = {}
) {
  const relayFactory = (opts: DriverOptions) =>
    createRelayDriver(opts, {
      client,
      ...(opts.server?.relaySessionId ? { relaySessionId: opts.server.relaySessionId } : {}),
      onSessionId: () => undefined,
      ...(o.now ? { now: o.now } : {})
    })
  const session = new AgentSession({
    tabId: 't1',
    cwd: tempDir('qclod-rd-cwd-'),
    overrides: o.mode ? { permissionMode: o.mode } : {},
    // There is no claude here at all: the server's is used.
    agentPath: 'C:/nowhere/claude.exe',
    createDriver: createDriverFactory({ relay: relayFactory }),
    askPermission: async () => ({ behavior: 'deny' }),
    confirmAutoAllow: async () => true,
    server: o.server ?? { hostId: 'h1' },
    ...(o.onAlert ? { onAlert: o.onAlert } : {}),
    panelRefreshMs: 0
  })
  sessions.push(session)
  return session
}

const userBubbles = (items: RibbonItem[], text: string) =>
  items.filter((i): i is Extract<RibbonItem, { kind: 'user' }> => i.kind === 'user' && i.text === text)

describe('RelayDriver за AgentSession', () => {
  test('серверная вкладка стартует без локального claude', async () => {
    const r = relay({ nextTurn: [{ kind: 'text', text: 'ответ с сервера' }] })
    await r.daemon.start()
    const { client } = connectTo(r.paths)
    await client.connect(true)
    const session = serverSession(client)
    await session.start()
    expect(session.status).toBe('idle')
    expect(session.error).toBeUndefined()
    expect(session.relaySessionId).toMatch(/.+/)
    expect(session.send({ text: 'привет', attachments: [] })).toBe(true)
    await until(() => session.items.some((i) => i.kind === 'agentText' && i.text.includes('ответ с сервера')), 8000, 'ответ')
    expect(userBubbles(session.items, 'привет')).toHaveLength(1)
  })

  test('ответ посредника во время обрыва закрывает карточку один раз', async () => {
    const clock = manualClock(Date.now())
    const r = relay({ nextTurn: [{ kind: 'askQuestion', question: 'Какой?', options: ['А', 'Б (Recommended)'] }] }, clock)
    await r.daemon.start()
    const { client, made, calls } = connectTo(r.paths)
    await client.connect(true)
    await client.call('autonomy.settings', { autoAnswerMs: 300_000 })
    const session = serverSession(client, { mode: 'autoAllow', now: clock.now })
    await session.start()
    session.send({ text: 'спроси', attachments: [] })
    const question = (): Extract<RibbonItem, { kind: 'question' }> | undefined =>
      session.items.find((i): i is Extract<RibbonItem, { kind: 'question' }> => i.kind === 'question')
    await until(() => question() !== undefined && session.status === 'waiting', 8000, 'вопрос открыт')
    await until(() => session.panelSnapshot().data.autonomy.timers.length === 1, 8000, 'таймер')
    // The channel breaks; meanwhile the relay's timer runs out and it answers by itself.
    made.at(-1)!.kill()
    await until(() => client.state !== 'online', 5000, 'обрыв')
    clock.advance(300_000)
    await until(() => client.state === 'online', 8000, 'снова на связи')
    await until(() => question()?.answers !== null, 8000, 'карточка закрыта')
    expect(question()).toMatchObject({ auto: true })
    expect(question()!.elsewhere).toBeUndefined()
    expect(calls.filter((c) => c.m === 'perm.answer')).toEqual([])
    await until(() => session.status !== 'waiting', 8000, 'не ждёт')
  })

  test('disposeAll отцепляет, close останавливает', async () => {
    const r = relay({ nextTurn: [{ kind: 'text', text: 'готово' }] })
    await r.daemon.start()
    const { client } = connectTo(r.paths)
    await client.connect(true)
    const manager = new AgentSessionManager({
      getAgentPath: () => 'C:/nowhere/claude.exe',
      createDriver: createDriverFactory({
        relay: (opts) =>
          createRelayDriver(opts, {
            client,
            ...(opts.server?.relaySessionId ? { relaySessionId: opts.server.relaySessionId } : {}),
            onSessionId: () => undefined
          })
      }),
      askPermission: async () => ({ behavior: 'deny' })
    })
    const first = manager.create('t1', tempDir('qclod-rd-cwd-'), {}, undefined, { hostId: 'h1' })
    await first.start()
    const s = first.relaySessionId!
    await manager.disposeAll({ detachOnly: true })
    const alive = await client.call<RelaySnapshot[]>('session.list', {})
    expect(alive.map((x) => x.s)).toContain(s)

    const again = manager.create('t1', tempDir('qclod-rd-cwd-'), {}, undefined, { hostId: 'h1', relaySessionId: s })
    await again.start()
    expect(again.relaySessionId).toBe(s)
    await manager.close('t1')
    const after = await client.call<RelaySnapshot[]>('session.list', {})
    expect(after.map((x) => x.s)).not.toContain(s)
  })

  test('чужой send показан пузырём один раз', async () => {
    const r = relay({ nextTurn: [{ kind: 'text', text: 'ок' }] })
    await r.daemon.start()
    const { client } = connectTo(r.paths)
    await client.connect(true)
    const session = serverSession(client)
    await session.start()
    const s = session.relaySessionId!
    // Another Qclod (the Mac) on the same session.
    const other = connectTo(r.paths).client
    await other.connect(true)
    const noop: SessionSink = { onEvent: () => undefined, onLive: () => undefined, onReattached: () => undefined }
    await other.attach(s, 0, noop)
    await other.call('drv', { s, op: 'send', args: [{ text: 'с макбука', attachments: [] }] })
    await until(() => session.items.some((i) => i.kind === 'agentText'), 8000, 'ответ')
    await new Promise((res) => setTimeout(res, 100))
    expect(userBubbles(session.items, 'с макбука')).toHaveLength(1)
    // Its own message is its own bubble only.
    session.send({ text: 'моё', attachments: [] })
    await until(() => session.items.filter((i) => i.kind === 'agentText').length >= 2, 8000, 'второй ответ')
    expect(userBubbles(session.items, 'моё')).toHaveLength(1)
  })
})

/** A relay client stand-in: no daemon, the frames are the test's. */
function fakeClient(snapshot: Partial<RelaySnapshot> = {}) {
  const calls: Array<{ m: string; p: unknown }> = []
  let sink: SessionSink | null = null
  let state: RelayClientState = 'online'
  const snap: RelaySnapshot = {
    s: 'S1',
    cwd: '/srv/app',
    title: 'Чат',
    sdkSessionId: null,
    status: 'idle',
    mode: 'default',
    firstSeq: 1,
    lastSeq: 0,
    pending: [],
    autonomy: { timers: [], limitWait: null, gaveUp: null },
    remoteControl: false,
    createdAt: 1,
    updatedAt: 1,
    ...snapshot
  }
  const client = {
    calls,
    get state() {
      return state
    },
    attach: async (_s: string, _after: number, k: SessionSink): Promise<AttachResult> => {
      sink = k
      return { snapshot: snap, gap: false }
    },
    open: async (_p: unknown, k: SessionSink): Promise<AttachResult> => {
      sink = k
      return { snapshot: snap, gap: false }
    },
    call: async (m: string, p: unknown) => {
      calls.push({ m, p })
      if (state !== 'online') throw Object.assign(new Error('Сервер не на связи'), { code: 'offline' })
      return null
    },
    detach: vi.fn()
  }
  return {
    client: client as unknown as RelayClient,
    calls,
    setState: (s: RelayClientState) => {
      state = s
    },
    reattach: (over: Partial<RelaySnapshot>) => sink!.onReattached({ snapshot: { ...snap, ...over }, gap: false }),
    ev: (q: number, k: 'sdk' | 'sent' | 'notice', d: unknown) =>
      sink!.onEvent({ t: 'ev', s: 'S1', q, k, at: Date.now(), d } as Extract<RelayFrame, { t: 'ev' }>),
    live: (k: Extract<RelayFrame, { t: 'live' }>['k'], d: unknown) => sink!.onLive({ t: 'live', s: 'S1', k, d })
  }
}

const baseOptions = (): DriverOptions => ({
  cwd: '/srv/app',
  executablePath: '',
  canUseTool: async () => ({ behavior: 'deny' })
})

/** Everything the driver hands the session, as it comes. */
function readAll(driver: { messages: AsyncIterable<unknown> }): unknown[] {
  const out: unknown[] = []
  void (async () => {
    for await (const m of driver.messages) out.push(m)
  })()
  return out
}

const tick = () => new Promise((res) => setTimeout(res, 0))

describe('RelayDriver: без связи (I3, I4, I6)', () => {
  const card: RelayPending = { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tu1', askedAt: 1 }

  function asking() {
    const answers: Array<(a: PermissionAnswer) => void> = []
    const opts: DriverOptions = {
      ...baseOptions(),
      canUseTool: () => new Promise<PermissionAnswer>((resolve) => answers.push(resolve))
    }
    return { opts, answers }
  }

  test('I3: ответ без связи ждёт и уходит после attach, если посредник ещё ждёт', async () => {
    const f = fakeClient()
    const a = asking()
    const driver = await createRelayDriver(a.opts, { client: f.client, onSessionId: () => undefined })
    const out = readAll(driver)
    f.live('perm', card)
    await until(() => a.answers.length === 1, 2000, 'карточка')
    f.setState('reconnecting')
    a.answers[0]!({ behavior: 'allow', updatedInput: { command: 'ls' } })
    await tick()
    expect(f.calls.filter((c) => c.m === 'perm.answer')).toEqual([])
    expect(out).toContainEqual({ type: 'qclod_relay_notice', notice: { kind: 'text', text: ANSWER_LATER_TEXT, tone: 'info' } })
    // Back, and the relay still waits on it: the person's answer goes, once.
    f.setState('online')
    f.reattach({ pending: [card] })
    f.reattach({ pending: [] })
    await tick()
    expect(f.calls.filter((c) => c.m === 'perm.answer').map((c) => c.p)).toEqual([
      { s: 'S1', requestId: 'r1', answer: { behavior: 'allow', updatedInput: { command: 'ls' } } }
    ])
    // The card is not asked again.
    expect(a.answers).toHaveLength(1)
  })

  test('I3: пока ответ ждал, посредник закрыл карточку сам — ответ не уходит, карточка закрыта', async () => {
    const f = fakeClient()
    const a = asking()
    const driver = await createRelayDriver(a.opts, { client: f.client, onSessionId: () => undefined })
    const resolved: PermResolved[] = []
    driver.onResolvedRemotely((r) => resolved.push(r))
    f.live('perm', card)
    await until(() => a.answers.length === 1, 2000, 'карточка')
    f.setState('offline')
    a.answers[0]!({ behavior: 'deny', message: 'нет' })
    await tick()
    f.setState('online')
    f.reattach({ pending: [] })
    await tick()
    expect(f.calls.filter((c) => c.m === 'perm.answer')).toEqual([])
    expect(resolved).toEqual([{ requestId: 'r1', by: 'elsewhere', toolUseId: 'tu1' }])
  })

  test('I4: после засева и при каждом attach — сброс потока', async () => {
    const f = fakeClient()
    const driver = await createRelayDriver(baseOptions(), { client: f.client, onSessionId: () => undefined })
    const out = readAll(driver)
    await tick()
    expect(out).toEqual([STREAM_RESET])
    f.reattach({})
    await tick()
    expect(out).toEqual([STREAM_RESET, STREAM_RESET])
  })

  test('I6: «Закрыть чат» без связи — в closeLater, session.close не теряется молча', async () => {
    const f = fakeClient()
    const later: string[] = []
    const driver = await createRelayDriver(baseOptions(), { client: f.client, onSessionId: () => undefined, closeLater: (s) => later.push(s) })
    f.setState('reconnecting')
    await driver.dispose()
    expect(later).toEqual(['S1'])
    expect(f.calls.filter((c) => c.m === 'session.close')).toEqual([])

    const g = fakeClient()
    const kept: string[] = []
    const online = await createRelayDriver(baseOptions(), { client: g.client, onSessionId: () => undefined, closeLater: (s) => kept.push(s) })
    await online.dispose()
    expect(g.calls.filter((c) => c.m === 'session.close')).toHaveLength(1)
    expect(kept).toEqual([])
    // Detached on quit: nothing to close later.
    const h = fakeClient()
    const none: string[] = []
    const quit = await createRelayDriver(baseOptions(), { client: h.client, onSessionId: () => undefined, closeLater: (s) => none.push(s) })
    h.setState('offline')
    await quit.dispose({ detachOnly: true })
    expect(none).toEqual([])
  })
})

describe('RelayDriver: каждый метод и вид автономности', () => {
  test('каждый метод AgentDriver проходит через drv', async () => {
    const f = fakeClient()
    const driver = await createRelayDriver(baseOptions(), { client: f.client, onSessionId: () => undefined })
    const args: Record<string, unknown[]> = {
      send: [{ text: 'x', attachments: [] }, { uuid: 'u1' }],
      cancelQueued: ['u1'],
      interrupt: [{ cancelQueued: true }],
      setPermissionMode: ['plan'],
      supportedCommands: [],
      mcpServerStatus: [],
      getContextUsage: [{ detail: 'summary' }],
      supportedModels: [],
      setModel: ['opus'],
      setEffort: ['high'],
      planLimits: [],
      taskOutput: ['t1'],
      stopTask: ['t1'],
      backgroundTask: ['tu1'],
      remoteAvailability: [],
      setRemoteControl: [true, 'Qclod']
    }
    for (const op of RELAY_DRIVER_OPS) {
      const method = (driver as unknown as Record<string, (...a: unknown[]) => unknown>)[op]!
      await method.apply(driver, args[op]!)
    }
    await new Promise((res) => setTimeout(res, 0))
    const drv = f.calls.filter((c) => c.m === 'drv').map((c) => c.p as { s: string; op: string; args: unknown[] })
    expect(drv.map((d) => d.op)).toEqual([...RELAY_DRIVER_OPS])
    expect(drv.every((d) => d.s === 'S1')).toBe(true)
    expect(drv.find((d) => d.op === 'setModel')!.args).toEqual(['opus'])
    expect(drv.find((d) => d.op === 'send')!.args).toEqual([{ text: 'x', attachments: [] }, { uuid: 'u1' }])
  })

  test('вид автономности посредника — AutonomyView с локальными сроками', async () => {
    const now = 5_000_000
    expect(
      toAutonomyView(
        {
          timers: [{ cardId: 'tu-q1', kind: 'question', remainingMs: 300_000, label: 'Qclod выберет «Б»' }],
          limitWait: { resetsInMs: 60_000, continueInMs: 90_000, weekly: false },
          gaveUp: null
        },
        now
      )
    ).toEqual({
      timers: [{ cardId: 'tu-q1', kind: 'question', deadline: now + 300_000, label: 'Qclod выберет «Б»' }],
      limitWait: { resetsAt: now + 60_000, continueAt: now + 90_000, weekly: false },
      gaveUp: null
    })
    const f = fakeClient()
    const driver = await createRelayDriver(baseOptions(), { client: f.client, onSessionId: () => undefined, now: () => now })
    const seen: unknown[] = []
    driver.onAutonomyView((v) => seen.push(v))
    f.live('autonomy', { timers: [{ cardId: 'tu-q1', kind: 'question', remainingMs: 300_000, label: 'x' }], limitWait: null, gaveUp: null })
    expect(seen.at(-1)).toMatchObject({ timers: [{ cardId: 'tu-q1', deadline: now + 300_000 }] })
  })

  test('notice автономности с сервера — текст noticeText здесь, alert — уведомление', async () => {
    const f = fakeClient()
    const alerts: string[] = []
    const session = new AgentSession({
      tabId: 't1',
      cwd: '/srv/app',
      overrides: {},
      agentPath: 'C:/nowhere/claude.exe',
      createDriver: createDriverFactory({ relay: (o) => createRelayDriver(o, { client: f.client, onSessionId: () => undefined }) }),
      askPermission: async () => ({ behavior: 'deny' }),
      server: { hostId: 'h1' },
      onAlert: (t) => alerts.push(t),
      panelRefreshMs: 0
    })
    sessions.push(session)
    await session.start()
    f.ev(1, 'notice', { kind: 'autonomy', notice: { kind: 'crashGaveUp' }, alert: true })
    f.ev(2, 'notice', { kind: 'text', text: 'Посредник перезапустил агента', tone: 'info' })
    await until(() => session.items.filter((i) => i.kind === 'notice').length >= 2, 2000, 'notice')
    const notices = session.items.filter((i): i is Extract<RibbonItem, { kind: 'notice' }> => i.kind === 'notice')
    expect(notices[0]).toMatchObject({ text: noticeText({ kind: 'crashGaveUp' }), tone: 'error' })
    expect(notices[1]).toMatchObject({ text: 'Посредник перезапустил агента', tone: 'info' })
    expect(alerts).toEqual([noticeText({ kind: 'crashGaveUp' })])
  })

  test('autonomy(cardId, hold) шлёт autonomy.act с cardId', async () => {
    const f = fakeClient()
    const driver = await createRelayDriver(baseOptions(), { client: f.client, onSessionId: () => undefined })
    await driver.autonomy('tu-q1', 'hold')
    await driver.autonomy('tu-q1', 'answerNow')
    expect(f.calls.filter((c) => c.m === 'autonomy.act').map((c) => c.p)).toEqual([
      { s: 'S1', cardId: 'tu-q1', action: 'hold' },
      { s: 'S1', cardId: 'tu-q1', action: 'answerNow' }
    ])
  })
})
