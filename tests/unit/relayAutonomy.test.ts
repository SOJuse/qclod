import { afterEach, describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { attachAutonomy } from '../../src/relay/autonomy'
import { Journal } from '../../src/relay/journal'
import { RelaySession, type SessionFrame } from '../../src/relay/session'
import type { RelaySessionRecord } from '../../src/relay/stateStore'
import type { PermResolved, RelayAutonomyView, RelayPending } from '../../src/shared/relayProtocol'
import type { FakeScript } from '../fixtures/fake-sdk/index.mjs'
import { cleanTemps, fakeFactory, manualClock, record, tempDir, until } from './relayHarness'

afterEach(cleanTemps)

const AUTO_MS = 5 * 60_000

function setup(script: FakeScript, extra: Partial<RelaySessionRecord> = {}, clockStart?: number) {
  const fake = fakeFactory(script)
  const journal = Journal.open(join(tempDir(), 's1'))
  const session = new RelaySession({
    id: 's1',
    record: record('s1', extra),
    claudePath: '/bin/claude',
    env: {},
    createDriver: fake.factory,
    journal,
    rules: () => []
  })
  const frames: SessionFrame[] = []
  session.subscribe((f) => frames.push(f))
  const clock = manualClock(clockStart)
  const autonomy = attachAutonomy(session, { autoAnswerMs: () => AUTO_MS, clock, random: () => 0.5 })
  const sent = () =>
    journal
      .readAfter(0)
      .records.filter((r) => r.k === 'sent')
      .map((r) => r.d as { input: { text: string }; by: string })
  const notices = () => journal.readAfter(0).records.filter((r) => r.k === 'notice').map((r) => r.d)
  const resolved = () =>
    frames.filter((f) => f.t === 'live' && f.k === 'permResolved').map((f) => f.d as PermResolved)
  const asked = () => frames.filter((f) => f.t === 'live' && f.k === 'perm').map((f) => f.d as RelayPending)
  const results = () => frames.filter((f) => f.t === 'ev' && (f.d as { type?: string }).type === 'result').length
  return { fake, journal, session, frames, clock, autonomy, sent, notices, resolved, asked, results }
}

const QUESTION: FakeScript = {
  nextTurn: [{ kind: 'askQuestion', question: 'Какой вариант?', options: ['Первый', 'Второй (Recommended)'] }]
}

describe('ядро автономности в посреднике', () => {
  test('вопрос в авто-да отвечен через autoAnswerMs вариантом (Recommended)', async () => {
    const t = setup(QUESTION, { mode: 'autoAllow' })
    await t.session.start()
    await t.session.call('send', [{ text: 'спроси', attachments: [] }])
    await until(() => t.asked().length === 1, 5000, 'вопрос')
    t.clock.advance(AUTO_MS - 1)
    expect(t.resolved()).toEqual([])
    t.clock.advance(1)
    await until(() => t.resolved().length === 1, 5000, 'авто-ответ')
    expect(t.resolved()[0]!.by).toBe('autonomy')
    await until(() => t.results() >= 1, 5000, 'result')
    expect(t.fake.drivers[0]!.questionAnswers).toEqual([{ 'Какой вариант?': 'Второй (Recommended)' }])
    // the answer went in place, never as a message
    expect(t.sent().map((s) => s.by)).toEqual(['client'])
  })

  test('hold снимает таймер, ответа нет', async () => {
    const t = setup(QUESTION, { mode: 'autoAllow' })
    await t.session.start()
    await t.session.call('send', [{ text: 'спроси', attachments: [] }])
    await until(() => t.asked().length === 1, 5000, 'вопрос')
    expect(t.autonomy.view().timers).toHaveLength(1)
    t.autonomy.act(t.asked()[0]!.toolUseId!, 'hold')
    expect(t.autonomy.view().timers).toEqual([])
    t.clock.advance(60 * 60_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(t.resolved()).toEqual([])
    expect(t.session.pending()).toHaveLength(1)
  })

  test('answerNow отвечает сразу', async () => {
    const t = setup(QUESTION, { mode: 'autoAllow' })
    await t.session.start()
    await t.session.call('send', [{ text: 'спроси', attachments: [] }])
    await until(() => t.asked().length === 1, 5000, 'вопрос')
    t.autonomy.act(t.asked()[0]!.toolUseId!, 'answerNow')
    await until(() => t.resolved().length === 1, 5000, 'ответ')
    expect(t.resolved()[0]!.by).toBe('autonomy')
  })

  test('вне авто-да ничего не отвечается', async () => {
    const t = setup(QUESTION)
    await t.session.start()
    await t.session.call('send', [{ text: 'спроси', attachments: [] }])
    await until(() => t.asked().length === 1, 5000, 'вопрос')
    t.clock.advance(60 * 60_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(t.resolved()).toEqual([])
    expect(t.autonomy.view().timers).toEqual([])
  })

  test('смерть процесса: перезапуск с resume и продолжай, не больше 3 за 10 минут', async () => {
    const t = setup({ sessionId: 'sdk-1', nextTurn: [{ kind: 'crash', message: 'boom' }] })
    await t.session.start()
    await t.session.call('send', [{ text: 'работай', attachments: [] }])
    await until(
      () => t.notices().some((n) => (n as { notice?: { kind: string } }).notice?.kind === 'crashGaveUp'),
      10000,
      'crashGaveUp'
    )
    // the first process and three restarts, each resuming the same conversation
    expect(t.fake.drivers).toHaveLength(4)
    for (const o of t.fake.options.slice(1)) expect(o.resume).toBe('sdk-1')
    expect(t.sent().map((s) => [s.by, s.input.text])).toEqual([
      ['client', 'работай'],
      ['autonomy', 'продолжай'],
      ['autonomy', 'продолжай'],
      ['autonomy', 'продолжай']
    ])
    expect(t.autonomy.view().gaveUp).toBe('crashes')
  })

  test('notice падения — запись k:notice с AutonomyNotice, без текста', async () => {
    const t = setup({ sessionId: 'sdk-1', nextTurn: [{ kind: 'crash', message: 'boom' }] })
    await t.session.start()
    await t.session.call('send', [{ text: 'работай', attachments: [] }])
    await until(() => t.notices().some((n) => (n as { kind: string }).kind === 'autonomy'), 5000, 'notice')
    const notice = t.notices().find((n) => (n as { kind: string }).kind === 'autonomy')
    expect(notice).toEqual({ kind: 'autonomy', notice: { kind: 'crashRestart', attempt: 1, willContinue: true }, alert: false })
    expect('text' in (notice as object)).toBe(false)
    t.autonomy.dispose()
  })

  test('rate_limit_event: продолжай после resetsAt плюс пауза до 2 минут', async () => {
    const t = setup(
      { turns: [[{ kind: 'limitHit', resetsInMs: 60_000 }]], nextTurn: [{ kind: 'text', text: 'дальше' }] },
      {},
      Date.now()
    )
    await t.session.start()
    await t.session.call('send', [{ text: 'работай', attachments: [] }])
    await until(() => t.autonomy.view().limitWait !== null, 5000, 'ожидание лимита')
    t.clock.advance(60_000)
    await new Promise((r) => setTimeout(r, 20))
    expect(t.sent().filter((s) => s.by === 'autonomy')).toEqual([])
    // the jitter: random 0.5 of two minutes
    t.clock.advance(61_000)
    await until(() => t.sent().some((s) => s.by === 'autonomy'), 5000, 'продолжай')
    expect(t.sent().filter((s) => s.by === 'autonomy').map((s) => s.input.text)).toEqual(['продолжай'])
    expect(t.autonomy.view().limitWait).toBeNull()
  })

  test('ожидание лимита в виде — resetsInMs и continueInMs', async () => {
    const t = setup({ turns: [[{ kind: 'limitHit', resetsInMs: 60_000 }]] }, {}, Date.now())
    await t.session.start()
    await t.session.call('send', [{ text: 'работай', attachments: [] }])
    await until(() => t.autonomy.view().limitWait !== null, 5000, 'ожидание лимита')
    const wait = t.autonomy.view().limitWait!
    expect(wait.weekly).toBe(false)
    expect(wait.resetsInMs).toBeGreaterThan(0)
    expect(wait.resetsInMs).toBeLessThanOrEqual(61_000)
    expect(wait.continueInMs - wait.resetsInMs!).toBe(60_000)
    expect(Object.keys(wait).sort()).toEqual(['continueInMs', 'resetsInMs', 'weekly'])
    const live = t.frames.filter((f) => f.t === 'live' && f.k === 'autonomy').at(-1)!.d as RelayAutonomyView
    expect(live.limitWait).toEqual(wait)
    expect(t.session.snapshot().autonomy.limitWait).toEqual(wait)
  })

  test('Remote Control включается после перезапуска', async () => {
    const t = setup({ sessionId: 'sdk-1', nextTurn: [{ kind: 'crash', message: 'boom' }] })
    await t.session.start()
    await t.session.call('setRemoteControl', [true, 'Чат'])
    expect(t.fake.drivers[0]!.remoteCalls).toEqual([{ enabled: true, name: 'Чат' }])
    await t.session.call('send', [{ text: 'работай', attachments: [] }])
    await until(() => t.fake.drivers.length >= 2 && t.fake.drivers[1]!.remoteCalls.length > 0, 5000, 'Remote Control')
    expect(t.fake.drivers[1]!.remoteCalls[0]!.enabled).toBe(true)
    expect(t.session.record.remoteControl).toBe(true)
    t.autonomy.dispose()
  })

  test('снимок отдаёт remainingMs, не время сервера', async () => {
    const t = setup(QUESTION, { mode: 'autoAllow' })
    await t.session.start()
    await t.session.call('send', [{ text: 'спроси', attachments: [] }])
    await until(() => t.asked().length === 1, 5000, 'вопрос')
    t.clock.advance(1000)
    const timers = t.session.snapshot().autonomy.timers
    expect(timers).toHaveLength(1)
    expect(timers[0]!.remainingMs).toBe(AUTO_MS - 1000)
    expect(timers[0]).not.toHaveProperty('deadline')
    expect(timers[0]!.label).toBe('Qclod выберет «Второй»')
    const live = t.frames.filter((f) => f.t === 'live' && f.k === 'autonomy').at(-1)!.d as RelayAutonomyView
    expect(live.timers[0]!.remainingMs).toBe(AUTO_MS)
  })

  test('таймер вопроса ключуется toolUseId; act(toolUseId, hold) снимает его', async () => {
    const t = setup(QUESTION, { mode: 'autoAllow' })
    await t.session.start()
    await t.session.call('send', [{ text: 'спроси', attachments: [] }])
    await until(() => t.asked().length === 1, 5000, 'вопрос')
    const pending = t.asked()[0]!
    expect(pending.toolUseId).toBeTruthy()
    expect(t.autonomy.view().timers.map((x) => x.cardId)).toEqual([pending.toolUseId])
    t.autonomy.act('чужой', 'hold')
    expect(t.autonomy.view().timers).toHaveLength(1)
    t.autonomy.act(pending.toolUseId!, 'hold')
    expect(t.autonomy.view().timers).toEqual([])
  })

  test('ответ человека закрывает таймер', async () => {
    const t = setup(QUESTION, { mode: 'autoAllow' })
    await t.session.start()
    await t.session.call('send', [{ text: 'спроси', attachments: [] }])
    await until(() => t.asked().length === 1, 5000, 'вопрос')
    const pending = t.asked()[0]!
    t.session.answer(pending.requestId, {
      behavior: 'allow',
      updatedInput: { ...pending.input, answers: { 'Какой вариант?': 'Первый' } }
    })
    expect(t.autonomy.view().timers).toEqual([])
    t.clock.advance(AUTO_MS * 2)
    await until(() => t.results() >= 1, 5000, 'result')
    expect(t.resolved().map((r) => r.by)).toEqual(['client'])
  })

  test('план в авто-да одобряется сам', async () => {
    const t = setup({ nextTurn: [{ kind: 'plan', plan: 'сделать всё' }] }, { mode: 'autoAllow' })
    await t.session.start()
    await t.session.call('send', [{ text: 'план', attachments: [] }])
    await until(() => t.asked().length === 1, 5000, 'план')
    expect(t.autonomy.view().timers[0]!.kind).toBe('plan')
    t.clock.advance(AUTO_MS)
    await until(() => t.resolved().length === 1, 5000, 'одобрение')
    expect(t.resolved()[0]).toMatchObject({ by: 'autonomy', answer: { behavior: 'allow' } })
    expect(t.session.snapshot().mode).toBe('autoAllow')
  })

  test('после старта демона сессия с wasRunning получает продолжай', async () => {
    const t = setup({}, { wasRunning: true, sdkSessionId: 'sdk-old' })
    await t.session.start()
    await until(() => t.sent().length === 1, 5000, 'продолжай')
    expect(t.sent()[0]).toMatchObject({ by: 'autonomy', input: { text: 'продолжай' } })
    expect(t.fake.options[0]!.resume).toBe('sdk-old')
    expect(t.notices()).toContainEqual({ kind: 'autonomy', notice: { kind: 'restoreContinue' }, alert: false })
  })
})
