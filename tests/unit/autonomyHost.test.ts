import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { AutonomyHost } from '../../src/main/autonomy/autonomyHost'
import { TabController } from '../../src/main/tabs/TabController'
import { AgentSessionManager } from '../../src/main/agent/AgentSessionManager'
import type { AgentDriver } from '../../src/main/agent/driver'
import { toPermissionContext } from '../../src/main/agent/permissionContext'
import { TABS_FILE } from '../../src/main/store/tabsStore'
import { LayoutStore } from '../../src/main/store/layoutStore'
import type { PermissionMode, RibbonEvent } from '../../src/shared/types'

type Script = Parameters<typeof createFakeSdk>[0]

let store = ''
let projectA = ''
let projectB = ''

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'qclod-host-'))
  projectA = mkdtempSync(join(tmpdir(), 'qclod-hosta-'))
  projectB = mkdtempSync(join(tmpdir(), 'qclod-hostb-'))
})

afterEach(() => {
  for (const dir of [store, projectA, projectB]) rmSync(dir, { recursive: true, force: true })
})

/** The clock the cores run on: time moves only when the test moves it. */
class FakeClock {
  t = Date.now()
  private timers: Array<{ at: number; fire: () => void }> = []
  now = (): number => this.t
  setTimer = (ms: number, fire: () => void): (() => void) => {
    const timer = { at: this.t + ms, fire }
    this.timers.push(timer)
    return () => {
      this.timers = this.timers.filter((x) => x !== timer)
    }
  }
  /** Runs every timer that comes due on the way, in order. */
  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      const due = this.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((x) => x !== due)
      this.t = Math.max(this.t, due.at)
      due.fire()
    }
    this.t = target
  }
}

/** A driver that can be made to die, as the CLI does: the stream throws. */
function killable(driver: ReturnType<typeof createFakeSdk>): { driver: AgentDriver; kill: () => void } {
  let kill!: () => void
  const killed = new Promise<'kill'>((resolve) => (kill = () => resolve('kill')))
  const inner = driver.messages[Symbol.asyncIterator]()
  const messages = {
    [Symbol.asyncIterator]() {
      return this
    },
    async next(): Promise<IteratorResult<unknown>> {
      const r = await Promise.race([inner.next(), killed])
      if (r === 'kill') throw new Error('агент упал')
      return r
    },
    async return(): Promise<IteratorResult<unknown>> {
      return (await inner.return?.()) ?? { done: true, value: undefined }
    }
  }
  Object.assign(driver, { messages })
  return { driver: driver as unknown as AgentDriver, kill }
}

interface Made {
  index: number
  cwd: string
  resume: string | undefined
  fake: ReturnType<typeof createFakeSdk>
  kill: () => void
}

interface Rig {
  host: AutonomyHost
  controller: TabController
  manager: AgentSessionManager
  clock: FakeClock
  made: Made[]
  alerts: Array<{ tabId: string; text: string }>
  awake: boolean[]
  ribbon: RibbonEvent[]
}

function makeRig(
  options: {
    /** The script of the n-th driver the manager makes; the same session id for all, so a resume is checkable. */
    script?: (index: number, resume: string | undefined) => Script
    defaults?: { permissionMode?: PermissionMode }
    autoAnswerMs?: number
  } = {}
): Rig {
  const made: Made[] = []
  const alerts: Rig['alerts'] = []
  const awake: boolean[] = []
  const ribbon: RibbonEvent[] = []
  const clock = new FakeClock()
  const manager = new AgentSessionManager({
    getAgentPath: () => 'claude',
    resolveAgent: () => 'C:/bin/claude.exe',
    askPermission: async () => ({ behavior: 'deny' as const }),
    createDriver: (driverOptions) => {
      const index = made.length
      const script = options.script?.(index, driverOptions.resume) ?? { steps: [] }
      // As the real driver does: the session's gate answers the fixture's questions.
      const fake = createFakeSdk({
        sessionId: 'S1',
        ...script,
        canUseTool: (name, input, opts) => driverOptions.canUseTool(name, input, toPermissionContext(opts))
      })
      const { driver, kill } = killable(fake)
      made.push({ index, cwd: driverOptions.cwd, resume: driverOptions.resume, fake, kill })
      return driver
    }
  })
  const layout = new LayoutStore(store, () => undefined)
  const controller: TabController = new TabController({
    manager,
    // The host needs the controller and the controller its hooks: joined through these.
    autonomy: {
      tabAdded: (id, record) => host.tabAdded(id, record),
      tabClosed: (id) => host.tabClosed(id),
      sessionAdopted: (id, session) => host.sessionAdopted(id, session),
      sessionUp: (id, session, carried) => host.sessionUp(id, session, carried)
    },
    storeDir: store,
    layout,
    defaultCwd: projectA,
    getDefaults: () => options.defaults ?? {},
    history: { list: async () => [], transcript: async () => [] },
    onChanged: () => undefined,
    onRibbon: (event) => ribbon.push(event),
    onPanel: () => undefined,
    onStatus: () => undefined,
    onCommands: () => undefined
  })
  const host: AutonomyHost = new AutonomyHost({
    controller: {
      list: () => controller.list(),
      revive: (id) => controller.revive(id),
      notice: (id, text, tone) => controller.notice(id, text, tone),
      setAutonomyRecord: (id, record) => controller.setAutonomyRecord(id, record)
    },
    manager,
    autoAnswerMs: () => options.autoAnswerMs ?? 5000,
    alert: (tabId, text) => alerts.push({ tabId, text }),
    onAwakeChange: (needed) => awake.push(needed),
    clock,
    random: () => 0
  })
  return { host, controller, manager, clock, made, alerts, awake, ribbon }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function settle(rig: Rig): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await rig.controller.whenSettled()
    await sleep(15)
  }
}

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`)
    await sleep(10)
  }
}

function writeTabs(tabs: unknown[]): void {
  writeFileSync(join(store, TABS_FILE), JSON.stringify(tabs), 'utf8')
}

function storedTabs(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(store, TABS_FILE), 'utf8')) as Array<Record<string, unknown>>
}

function notices(rig: Rig): string[] {
  const out: string[] = []
  for (const e of rig.ribbon) {
    for (const c of e.changes) if (c.kind === 'append' && c.item.kind === 'notice') out.push(c.item.text)
  }
  return out
}

const sentTexts = (m: Made): string[] => m.fake.sent.map((s) => s.text)

/** A turn that stays busy until the test says otherwise. */
const LONG_TURN: Script = { steps: [], nextTurn: [{ kind: 'thinking', ms: 1500 }] }

/** One tab, started; its first message sent so the CLI has introduced itself. */
async function startBusyTab(rig: Rig): Promise<string> {
  await rig.controller.restore()
  await settle(rig)
  const id = rig.controller.list()[0]!.id
  rig.controller.send(id, { text: 'работай', attachments: [] })
  await until(() => rig.manager.get(id)?.sessionId != null, 'init первой сессии')
  return id
}

describe('AutonomyHost: падения', () => {
  test('падение посреди хода: та же переписка (resume = прежний sessionId) и «продолжай» с пометкой авто', async () => {
    const rig = makeRig({ script: (i) => (i === 0 ? LONG_TURN : { steps: [], nextTurn: [{ kind: 'text', text: 'иду дальше' }] }) })
    const id = await startBusyTab(rig)

    rig.made[0]!.kill()
    await until(() => rig.made.length === 2, 'вторая сессия')
    await until(() => sentTexts(rig.made[1]!).includes('продолжай'), '«продолжай» в новую сессию')

    expect(rig.made[1]!.resume).toBe('S1')
    expect(rig.made[1]!.cwd).toBe(rig.made[0]!.cwd)
    const marked = rig.ribbon.some((e) =>
      e.changes.some((c) => c.kind === 'append' && c.item.kind === 'user' && c.item.text === 'продолжай' && c.item.auto === true)
    )
    expect(marked).toBe(true)
    expect(notices(rig).some((t) => t.includes('перезапускаю вкладку и продолжаю'))).toBe(true)
    expect(rig.controller.list().find((t) => t.id === id)).toBeDefined()
  })

  test('падение в простое: перезапуск без «продолжай»', async () => {
    const rig = makeRig({ script: () => ({ steps: [], nextTurn: [{ kind: 'text', text: 'готово' }] }) })
    const id = await startBusyTab(rig)
    await until(() => rig.manager.get(id)?.status === 'idle', 'ход закончен')

    rig.made[0]!.kill()
    await until(() => rig.made.length === 2, 'вторая сессия')
    await settle(rig)

    expect(rig.made[1]!.resume).toBe('S1')
    expect(sentTexts(rig.made[1]!)).toEqual([])
    expect(notices(rig).some((t) => t.includes('перезапускаю вкладку'))).toBe(true)
    expect(notices(rig).some((t) => t.includes('и продолжаю'))).toBe(false)
  })

  test('четвёртое падение за 10 минут: перезапуска нет, alert вызван', async () => {
    const rig = makeRig({ script: () => LONG_TURN })
    await startBusyTab(rig)

    for (let n = 1; n <= 3; n++) {
      rig.made[n - 1]!.kill()
      await until(() => rig.made.length === n + 1, `перезапуск ${n}`)
      // The restarted session is spoken to («продолжай»), so it introduces itself and can crash for real.
      await until(() => sentTexts(rig.made[n]!).includes('продолжай'), `«продолжай» ${n}`)
      await until(() => rig.manager.get(rig.controller.list()[0]!.id)?.sessionId != null, `init ${n}`)
    }
    expect(rig.alerts).toEqual([])

    rig.made[3]!.kill()
    await until(() => rig.alerts.length === 1, 'alert')
    await settle(rig)

    expect(rig.made).toHaveLength(4)
    expect(rig.alerts[0]!.text).toContain('в четвёртый раз')
    expect(notices(rig).some((t) => t.includes('больше не перезапускает'))).toBe(true)
  })

  test('падение до init при revive: recoverFromDeadSession, ядро не перезапускает второй раз, «продолжай» не уходит в чистую сессию', async () => {
    const rig = makeRig({
      script: (i) => {
        if (i === 0) return LONG_TURN
        // The resumed session dies before it introduces itself, when it is spoken to.
        if (i === 1) return { steps: [], nextTurn: [{ kind: 'crash', message: 'No conversation found', beforeInit: true }] }
        return { steps: [], nextTurn: [{ kind: 'text', text: 'чистая' }] }
      }
    })
    await startBusyTab(rig)

    rig.made[0]!.kill()
    await until(() => rig.made.length === 3, 'мёртвая и чистая сессии')
    await settle(rig)

    // 0 — the first, 1 — the resume that died before init, 2 — the clean one the controller made.
    expect(rig.made).toHaveLength(3)
    expect(rig.made[2]!.resume).toBeUndefined()
    expect(sentTexts(rig.made[2]!)).not.toContain('продолжай')
    // One restart, said once: the core did not restart the dead resume again.
    expect(notices(rig).filter((t) => t.includes('перезапускаю вкладку'))).toHaveLength(1)
    expect(rig.alerts).toEqual([])
  })
})

describe('AutonomyHost: лимиты и восстановление', () => {
  test('лимит: «продолжай» в resetsAt, после трёх подряд — стоп с alert', async () => {
    const rig = makeRig({ script: () => ({ steps: [], nextTurn: [{ kind: 'limitHit', resetsInMs: 120_000 }] }) })
    const id = await startBusyTab(rig)
    await until(() => rig.host.viewOf(id).limitWait !== null, 'ожидание лимита')

    // Nothing before the reset…
    rig.clock.advance(60_000)
    await settle(rig)
    expect(sentTexts(rig.made[0]!)).toEqual(['работай'])

    // …then one «продолжай» each time, three in a row without the person.
    for (let n = 1; n <= 3; n++) {
      rig.clock.advance(130_000)
      await until(() => sentTexts(rig.made[0]!).length === n + 1, `«продолжай» ${n}`)
      await until(() => rig.host.viewOf(id).limitWait !== null || rig.alerts.length > 0, `следующий лимит ${n}`)
      if (n < 3) expect(rig.alerts).toEqual([])
    }
    // The next limit is the end of it.
    await until(() => rig.alerts.length === 1, 'alert после третьего')
    expect(sentTexts(rig.made[0]!).filter((t) => t === 'продолжай')).toHaveLength(3)
    expect(rig.alerts[0]!.text).toContain('больше сам не продолжит')
    expect(rig.host.viewOf(id).gaveUp).toBe('limits')
    // Said once the restart never touched the process.
    expect(rig.made).toHaveLength(1)
  })

  test('восстановление: неактивная вкладка с working стартует и получает «продолжай»', async () => {
    writeTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {} },
      { id: 'b', cwd: projectB, title: 'B', overrides: {}, lastSessionId: 'S1', autonomy: { working: true } }
    ])
    const rig = makeRig()
    await rig.controller.restore()
    await until(() => rig.made.some((m) => m.cwd === projectB && sentTexts(m).includes('продолжай')), '«продолжай» на b')

    const b = rig.made.find((m) => m.cwd === projectB)!
    expect(b.resume).toBe('S1')
    expect(notices(rig).some((t) => t.includes('Qclod перезапустился, пока агент работал'))).toBe(true)
    // The active tab had no record: no «продолжай» there.
    expect(sentTexts(rig.made.find((m) => m.cwd === projectA)!)).toEqual([])
  })

  test('восстановление в ожидании лимита: «продолжай» не раньше limitUntil', async () => {
    const rig = makeRig()
    const until300 = rig.clock.t + 300_000
    writeTabs([
      {
        id: 'a',
        cwd: projectA,
        title: 'A',
        overrides: {},
        lastSessionId: 'S1',
        autonomy: { working: true, limitUntil: until300 }
      }
    ])
    await rig.controller.restore()
    await settle(rig)
    const m = rig.made[0]!

    rig.clock.advance(299_000)
    await settle(rig)
    expect(sentTexts(m)).toEqual([])
    expect(notices(rig).some((t) => t.includes('Лимит подписки исчерпан'))).toBe(true)

    rig.clock.advance(2_000)
    await until(() => sentTexts(m).includes('продолжай'), '«продолжай» после limitUntil')
    // The wait is over, so the record no longer holds it.
    await until(() => storedTabs()[0]!['autonomy'] === undefined || !('limitUntil' in (storedTabs()[0]!['autonomy'] as object)), 'limitUntil стёрт')
  })

  test('Remote Control включается сам после перезапуска процесса, если был включён', async () => {
    const rig = makeRig({ script: (i) => (i === 0 ? LONG_TURN : { steps: [], nextTurn: [{ kind: 'text', text: 'ок' }] }) })
    const id = await startBusyTab(rig)
    const title = rig.controller.list()[0]!.title
    // The person's own switch, as the IPC does it.
    await rig.manager.get(id)!.setRemote(true, title)
    rig.host.remoteWanted(id, true)
    expect(storedTabs()[0]!['autonomy']).toMatchObject({ remote: true })

    rig.made[0]!.kill()
    await until(() => rig.made.length === 2, 'вторая сессия')
    await until(() => rig.made[1]!.fake.remoteCalls.length > 0, 'Remote Control во второй сессии')

    expect(rig.made[1]!.fake.remoteCalls[0]).toEqual({ enabled: true, name: title })
    expect(notices(rig).some((t) => t.includes('Включаю Remote Control снова'))).toBe(true)
  })
})

describe('AutonomyHost: выход', () => {
  test('quitting(true) снимает working в tabs.json, quitting(false) оставляет', async () => {
    for (const deliberate of [true, false]) {
      const rig = makeRig({ script: () => LONG_TURN })
      await startBusyTab(rig)
      await until(() => (storedTabs()[0]!['autonomy'] as { working?: boolean } | undefined)?.working === true, 'working записан')

      rig.host.quitting(deliberate)
      // The sessions going down are no event for the core.
      await rig.manager.disposeAll()
      await sleep(30)

      const record = storedTabs()[0]!['autonomy'] as { working?: boolean } | undefined
      if (deliberate) expect(record?.working).toBeUndefined()
      else expect(record?.working).toBe(true)
      // And nothing is restarted by it.
      expect(rig.made).toHaveLength(1)
      rmSync(join(store, TABS_FILE), { force: true })
    }
  })
})

describe('AutonomyHost: вопросы', () => {
  const ASK: Script = {
    steps: [],
    nextTurn: [
      { kind: 'askQuestion', question: 'Какой вариант?', options: ['Первый (Recommended)', 'Второй'] },
      { kind: 'text', text: 'ответ принят' }
    ]
  }
  const saidAnswerTaken = (rig: Rig): boolean => JSON.stringify(rig.ribbon).includes('ответ принят')

  test('вопрос в авто-да отвечается через autoAnswerMs; вне авто-да — нет', async () => {
    for (const mode of ['autoAllow', 'default'] as const) {
      const rig = makeRig({ script: () => ASK, defaults: { permissionMode: mode } })
      await rig.controller.restore()
      await sleep(40)
      const id = rig.controller.list()[0]!.id
      rig.controller.send(id, { text: 'спроси', attachments: [] })
      await until(() => rig.manager.get(id)?.status === 'waiting', 'вопрос открыт')

      if (mode === 'autoAllow') {
        await until(() => rig.host.viewOf(id).timers.length === 1, 'таймер идёт')
        rig.clock.advance(4_000)
        await sleep(40)
        expect(saidAnswerTaken(rig)).toBe(false)
        rig.clock.advance(2_000)
        await until(() => saidAnswerTaken(rig), 'ответ по таймеру')
      } else {
        expect(rig.host.viewOf(id).timers).toEqual([])
        rig.clock.advance(60 * 60_000)
        await sleep(40)
        expect(saidAnswerTaken(rig)).toBe(false)
        expect(rig.manager.get(id)?.status).toBe('waiting')
      }
      await rig.manager.disposeAll()
      rmSync(join(store, TABS_FILE), { force: true })
    }
  })

  test('hold и answerNow доходят до ядра нужной вкладки', async () => {
    writeTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: { permissionMode: 'autoAllow' } },
      { id: 'b', cwd: projectB, title: 'B', overrides: { permissionMode: 'autoAllow' } }
    ])
    const rig = makeRig({ script: () => ASK })
    await rig.controller.restore()
    await sleep(40)
    await rig.controller.setPanes(['a', 'b'])
    await sleep(40)
    for (const id of ['a', 'b']) rig.controller.send(id, { text: 'спроси', attachments: [] })
    await until(() => rig.host.viewOf('a').timers.length === 1 && rig.host.viewOf('b').timers.length === 1, 'два таймера')

    const cardA = rig.host.viewOf('a').timers[0]!.cardId
    const cardB = rig.host.viewOf('b').timers[0]!.cardId
    // «Остановить таймер» on a: its timer goes, b's stays.
    rig.host.hold('a', cardA)
    expect(rig.host.viewOf('a').timers).toEqual([])
    expect(rig.host.viewOf('b').timers).toHaveLength(1)
    // A card id of another tab does nothing.
    rig.host.answerNow('a', cardB)
    expect(rig.host.viewOf('b').timers).toHaveLength(1)

    rig.host.answerNow('b', cardB)
    await until(() => rig.manager.get('b')?.status !== 'waiting', 'b ответила сразу')
    rig.clock.advance(60 * 60_000)
    await sleep(40)
    // a stays waiting for the person for good.
    expect(rig.manager.get('a')?.status).toBe('waiting')
  })
})

describe('AutonomyHost: входы и «не спать»', () => {
  test('входы заменённой сессии не доходят до ядра', async () => {
    const rig = makeRig({ script: () => LONG_TURN })
    const id = await startBusyTab(rig)
    const old = rig.manager.get(id)!

    await rig.controller.restart(id)
    await settle(rig)
    expect(rig.manager.get(id)).not.toBe(old)
    const made = rig.made.length

    // The old session still speaks: a crash it reports is nobody's now.
    ;(old as unknown as { feedAutonomy(input: unknown): void }).feedAutonomy({ type: 'processDied', cause: 'crash' })
    await settle(rig)
    expect(rig.made).toHaveLength(made)
    expect(notices(rig).some((t) => t.includes('Агент упал'))).toBe(false)
  })

  test('onAwakeChange: true пока busy или ожидание лимита, false в простое', async () => {
    const rig = makeRig({ script: () => ({ steps: [], nextTurn: [{ kind: 'text', text: 'готово' }] }) })
    await rig.controller.restore()
    await settle(rig)
    const id = rig.controller.list()[0]!.id
    expect(rig.awake.at(-1) ?? false).toBe(false)

    rig.controller.send(id, { text: 'работай', attachments: [] })
    await until(() => rig.awake.includes(true), 'true на ходе')
    await until(() => rig.manager.get(id)?.status === 'idle', 'ход закончен')
    expect(rig.awake.at(-1)).toBe(false)

    // A limit wait holds the machine although the tab is idle.
    const limited = makeRig({ script: () => ({ steps: [], nextTurn: [{ kind: 'limitHit', resetsInMs: 600_000 }] }) })
    const lid = await startBusyTab(limited)
    await until(() => limited.host.viewOf(lid).limitWait !== null, 'ожидание лимита')
    await until(() => limited.manager.get(lid)?.status === 'idle', 'простой')
    expect(limited.awake.at(-1)).toBe(true)
  })
})

vi.setConfig({ testTimeout: 20_000 })
