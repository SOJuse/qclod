import { afterEach, describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { Journal } from '../../src/relay/journal'
import { RelaySession } from '../../src/relay/session'
import type { RelaySessionRecord } from '../../src/relay/stateStore'
import type { PermResolved, RelayFrame, RelayPending } from '../../src/shared/relayProtocol'
import type { FakeScript } from '../fixtures/fake-sdk/index.mjs'
import { cleanTemps, fakeFactory, record, tempDir, until } from './relayHarness'

type Out = Extract<RelayFrame, { t: 'ev' | 'live' }>

afterEach(cleanTemps)

function setup(script: FakeScript = {}, extra: Partial<RelaySessionRecord> = {}) {
  const fake = fakeFactory(script)
  const journal = Journal.open(join(tempDir(), 's1'))
  const records: RelaySessionRecord[] = []
  const session = new RelaySession({
    id: 's1',
    record: record('s1', extra),
    claudePath: '/home/u/.local/bin/claude',
    env: { PATH: '/usr/bin', HOME: '/home/u' },
    createDriver: fake.factory,
    journal,
    rules: () => [],
    onRecord: (r) => records.push(r)
  })
  const frames: Out[] = []
  session.subscribe((f) => frames.push(f))
  return { fake, journal, session, frames, records }
}

const isResult = (f: Out): boolean => f.t === 'ev' && (f.d as { type?: string }).type === 'result'

describe('сессия посредника', () => {
  test('send пишет sent и доходит до драйвера', async () => {
    const { fake, journal, session, frames } = setup()
    await session.start()
    expect(fake.options[0]).toMatchObject({
      cwd: '/home/u/app',
      executablePath: '/home/u/.local/bin/claude',
      env: { PATH: '/usr/bin', HOME: '/home/u' }
    })
    const image = { kind: 'image' as const, mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', thumbnail: 'data:image/png;base64,xx', width: 2, height: 2 }
    await session.call('send', [{ text: 'привет', attachments: [image, { kind: 'file', path: '/home/u/a.txt' }] }, { uuid: 'u1' }])
    await until(() => frames.some(isResult), 5000, 'result')

    const { records } = journal.readAfter(0)
    expect(records[0]!.k).toBe('sent')
    expect(records[0]!.d).toEqual({
      input: {
        text: 'привет',
        attachments: [{ ...image, dataBase64: '' }, { kind: 'file', path: '/home/u/a.txt' }]
      },
      opts: { uuid: 'u1' },
      by: 'client'
    })
    expect(records.slice(1).every((r) => r.k === 'sdk')).toBe(true)
    expect(records.some((r) => (r.d as { type?: string }).type === 'result')).toBe(true)
    // the bytes went to the agent, only the journal lost them
    expect(fake.drivers[0]!.sent[0]!.text).toBe('привет')
    expect(fake.drivers[0]!.sent[0]!.attachments[0]).toMatchObject({ dataBase64: 'iVBORw0KGgo=' })
    // every journal record went out as an ev, in order
    const evs = frames.filter((f) => f.t === 'ev') as Array<Extract<Out, { t: 'ev' }>>
    expect(evs.map((e) => e.q)).toEqual(records.map((r) => r.q))
    expect(evs.every((e) => e.s === 's1')).toBe(true)
    expect(session.snapshot().status).toBe('idle')
  })

  test('stream_event не пишется в журнал', async () => {
    const { journal, session, frames } = setup({ nextTurn: [{ kind: 'textStream', pieces: ['раз', 'два'] }] })
    await session.start()
    await session.call('send', [{ text: 'го', attachments: [] }])
    await until(() => frames.some(isResult), 5000, 'result')
    const streams = frames.filter((f) => f.t === 'live' && f.k === 'stream')
    expect(streams.length).toBeGreaterThan(0)
    expect((streams[0]!.d as { type: string }).type).toBe('stream_event')
    expect(journal.readAfter(0).records.some((r) => (r.d as { type?: string }).type === 'stream_event')).toBe(false)
  })

  test('разрешение рассылается всем подписчикам, побеждает первый ответ', async () => {
    const { fake, session, frames } = setup({ nextTurn: [{ kind: 'askPermission', name: 'Bash', input: { command: 'ls' } }] })
    const second: Out[] = []
    session.subscribe((f) => second.push(f))
    await session.start()
    await session.call('send', [{ text: 'го', attachments: [] }])
    const perm = (list: Out[]) => list.find((f) => f.t === 'live' && f.k === 'perm')
    await until(() => !!perm(frames) && !!perm(second), 5000, 'perm')
    const asked = perm(frames)!.d as RelayPending
    expect(asked.toolName).toBe('Bash')
    expect(asked.input).toEqual({ command: 'ls' })
    expect(session.snapshot().pending.map((p) => p.requestId)).toEqual([asked.requestId])
    expect(session.snapshot().status).toBe('waiting')

    expect(session.answer(asked.requestId, { behavior: 'allow' })).toBe(true)
    expect(session.answer(asked.requestId, { behavior: 'deny' })).toBe(false)
    const resolved = (list: Out[]) =>
      list.filter((f) => f.t === 'live' && f.k === 'permResolved').map((f) => f.d as PermResolved)
    expect(resolved(frames)).toEqual([{ requestId: asked.requestId, by: 'client', answer: { behavior: 'allow' } }])
    expect(resolved(second)).toEqual(resolved(frames))
    await until(() => frames.some(isResult), 5000, 'result')
    expect(fake.drivers[0]!.executedTools).toContain('Bash')
  })

  test('init обновляет sdkSessionId в state', async () => {
    const { session, frames, records } = setup({ sessionId: 'sdk-123' })
    await session.start()
    expect(session.snapshot().sdkSessionId).toBeNull()
    await session.call('send', [{ text: 'го', attachments: [] }])
    await until(() => frames.some(isResult), 5000, 'result')
    expect(session.snapshot().sdkSessionId).toBe('sdk-123')
    expect(session.record.sdkSessionId).toBe('sdk-123')
    expect(records.at(-1)!.sdkSessionId).toBe('sdk-123')
  })

  test('close останавливает драйвер, suspend оставляет запись', async () => {
    const a = setup()
    await a.session.start()
    await a.session.suspend()
    expect(a.fake.drivers[0]!.disposed).toBe(true)
    expect(a.session.record.closedAt).toBeUndefined()
    expect(a.frames.some((f) => f.t === 'live' && f.k === 'closed')).toBe(false)

    const b = setup()
    await b.session.start()
    await b.session.close()
    expect(b.fake.drivers[0]!.disposed).toBe(true)
    expect(typeof b.session.record.closedAt).toBe('number')
    expect(b.records.at(-1)!.closedAt).toBe(b.session.record.closedAt)
    expect(b.frames.some((f) => f.t === 'live' && f.k === 'closed')).toBe(true)
    // a deliberate end is no death
    await new Promise((r) => setTimeout(r, 30))
    for (const s of [a, b]) expect(s.journal.readAfter(0).records.some((r) => r.k === 'notice')).toBe(false)
    await expect(b.session.call('send', [{ text: 'x', attachments: [] }])).rejects.toThrow()
  })

  test('autoAllow хранится как режим Qclod, драйверу — default', async () => {
    const { fake, session, records } = setup()
    await session.start()
    await session.call('setPermissionMode', ['autoAllow'])
    expect(fake.drivers[0]!.permissionMode).toBe('default')
    expect(session.snapshot().mode).toBe('autoAllow')
    expect(records.at(-1)!.mode).toBe('autoAllow')
    await session.call('setPermissionMode', ['plan'])
    expect(fake.drivers[0]!.permissionMode).toBe('plan')
    await expect(session.call('setPermissionMode', ['sudo'])).rejects.toThrow()
  })

  test('режим autoAllow при запуске — драйверу default', async () => {
    const { fake, session } = setup({}, { mode: 'autoAllow' })
    await session.start()
    expect(fake.options[0]!.permissionMode).toBe('default')
  })

  test('смерть драйвера — notice в журнале, сессия ждёт restart', async () => {
    const { fake, journal, session, frames } = setup({ nextTurn: [{ kind: 'crash', message: 'boom' }] })
    await session.start()
    await session.call('send', [{ text: 'го', attachments: [] }])
    await until(() => journal.readAfter(0).records.some((r) => r.k === 'notice'), 5000, 'notice')
    const notice = journal.readAfter(0).records.find((r) => r.k === 'notice')!
    expect(notice.d).toMatchObject({ kind: 'text', tone: 'error' })
    expect(session.snapshot().status).toBe('error')
    expect(frames.some((f) => f.t === 'live' && f.k === 'status' && (f.d as { status: string }).status === 'error')).toBe(true)
    await expect(session.call('send', [{ text: 'x', attachments: [] }])).rejects.toThrow()
    await session.restart(true)
    expect(fake.drivers).toHaveLength(2)
    expect(session.snapshot().status).toBe('idle')
  })

  test('диск заполнен: поток идёт дальше, смерть — died и dispose, claude не сирота', async () => {
    const fake = fakeFactory({ nextTurn: [{ kind: 'crash', message: 'boom' }] })
    const errors: unknown[] = []
    const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    const journal = Journal.open(join(tempDir(), 's1'), {
      write: () => {
        throw full
      },
      onError: (e) => errors.push(e)
    })
    const session = new RelaySession({
      id: 's1',
      record: record('s1'),
      claudePath: '/bin/claude',
      env: {},
      createDriver: fake.factory,
      journal,
      rules: () => []
    })
    const frames: Out[] = []
    session.subscribe((f) => frames.push(f))
    const events: string[] = []
    session.onEvent((e) => events.push(e.type))
    await session.start()
    await session.call('send', [{ text: 'го', attachments: [] }])
    await until(() => events.includes('died'), 5000, 'died')
    // the stream was not cut by the disk: the message and the death notice still went out live
    expect(frames.some((f) => f.t === 'ev' && f.k === 'sent')).toBe(true)
    expect(frames.some((f) => f.t === 'ev' && f.k === 'notice')).toBe(true)
    await until(() => fake.drivers[0]!.disposed, 5000, 'dispose')
    expect(session.snapshot().status).toBe('error')
    // said once, not on every record
    expect(errors).toEqual([full])
  })

  test('restart(true) продолжает тот же разговор, restart(false) — новый', async () => {
    const { fake, session, frames } = setup({ sessionId: 'sdk-9' })
    await session.start()
    await session.call('send', [{ text: 'го', attachments: [] }])
    await until(() => frames.some(isResult), 5000, 'result')
    await session.restart(true)
    expect(fake.options[1]!.resume).toBe('sdk-9')
    expect(fake.drivers[0]!.disposed).toBe(true)
    await session.restart(false)
    expect(fake.options[2]!.resume).toBeUndefined()
    expect(session.snapshot().sdkSessionId).toBeNull()
  })

  test('неизвестная операция и неверный send отвергаются', async () => {
    const { session } = setup()
    await session.start()
    await expect(session.call('dispose' as never, [])).rejects.toThrow()
    await expect(session.call('send', [{ text: 5 }])).rejects.toThrow()
    await expect(session.call('send', [{ text: 'x', attachments: [{ kind: 'exe' }] }])).rejects.toThrow()
  })
})
