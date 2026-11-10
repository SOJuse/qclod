import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { TabController } from '../../src/main/tabs/TabController'
import { AgentSessionManager } from '../../src/main/agent/AgentSessionManager'
import type { AgentDriver } from '../../src/main/agent/driver'
import { TABS_FILE } from '../../src/main/store/tabsStore'
import { EMPTY_PANEL } from '../../src/main/agent/panelData'
import type { PanelEvent, RibbonEvent, TabState } from '../../src/shared/types'
import { readTranscript } from '../../src/main/agent/transcript'
import { resumedSession, writeTranscript } from '../fixtures/transcript.mjs'
import { useAppStore } from '../../src/renderer/state/useAppStore'

let store = ''
let projectA = ''
let projectB = ''

beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'qclod-tabs-'))
  projectA = mkdtempSync(join(tmpdir(), 'qclod-a-'))
  projectB = mkdtempSync(join(tmpdir(), 'qclod-b-'))
})

afterEach(() => {
  for (const dir of [store, projectA, projectB]) rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  controller: TabController
  changed: TabState[][]
  ribbon: RibbonEvent[]
  resumedWith: Array<string | undefined>
  /** Every history.transcript call: (sessionId, cwd). */
  transcriptReads: Array<[string, string]>
  /** Every driver the manager actually built, in order. */
  created: Array<{
    resume: string | undefined
    permissionMode: string | undefined
    driver: ReturnType<typeof createFakeSdk>
  }>
  /**
   * Sends one message on a tab and waits for the answer. The CLI says nothing
   * — not even its session id — until it is spoken to.
   */
  speak(id: string): Promise<void>
}

function makeController(
  options: {
    script?: Parameters<typeof createFakeSdk>[0]
    resumeFails?: boolean
    resumeFailsSync?: boolean
    defaults?: { model?: string; permissionMode?: 'default' | 'acceptEdits' | 'plan' }
    historyMessages?: unknown[]
    onPanel?: (event: PanelEvent) => void
  } = {}
): Harness {
  const changed: TabState[][] = []
  const ribbon: RibbonEvent[] = []
  const resumedWith: Array<string | undefined> = []
  const created: Harness['created'] = []
  const transcriptReads: Harness['transcriptReads'] = []

  const manager = new AgentSessionManager({
    getAgentPath: () => 'claude',
    resolveAgent: () => 'C:/bin/claude.exe',
    askPermission: async () => ({ behavior: 'deny' as const }),
    createDriver: (driverOptions) => {
      resumedWith.push(driverOptions.resume)
      if (options.resumeFailsSync && driverOptions.resume) {
        throw new Error(`Сессия ${driverOptions.resume} не открывается`)
      }
      // The real driver only builds the query object here; the CLI is spawned
      // and the resume attempted while the stream is read. A failure therefore
      // surfaces asynchronously, which is the shape that must be handled.
      if (options.resumeFails && driverOptions.resume) {
        return createFakeSdk({
          steps: [{ kind: 'crash', message: `Сессия ${driverOptions.resume} не открывается` }]
        }) as unknown as AgentDriver
      }
      const driver = createFakeSdk(options.script ?? { steps: [] })
      created.push({ resume: driverOptions.resume, permissionMode: driverOptions.permissionMode, driver })
      return driver as unknown as AgentDriver
    }
  })

  const controller = new TabController({
    manager,
    storeDir: store,
    defaultCwd: projectA,
    getDefaults: () => options.defaults ?? {},
    history: {
      list: async () => [],
      transcript: async (sessionId, cwd) => {
        transcriptReads.push([sessionId, cwd])
        return options.historyMessages ?? []
      }
    },
    onChanged: (tabs) => changed.push(tabs),
    onRibbon: (event) => ribbon.push(event),
    onPanel: options.onPanel ?? (() => undefined),
    onStatus: () => undefined,
    onCommands: () => undefined
  })

  const speak = async (id: string): Promise<void> => {
    await controller.whenSettled()
    manager.get(id)!.send({ text: 'привет', attachments: [] })
    await controller.whenSettled()
  }

  return { controller, changed, ribbon, resumedWith, transcriptReads, created, speak }
}

function writeStoredTabs(tabs: unknown[]): void {
  writeFileSync(join(store, TABS_FILE), JSON.stringify(tabs), 'utf8')
}

describe('TabController', () => {
  test('без сохранённых вкладок открывается одна, в папке по умолчанию', async () => {
    const { controller } = makeController()
    await controller.restore()

    const tabs = controller.list()
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.cwd).toBe(projectA)
  })

  test('активная вкладка поднимает сессию сразу', async () => {
    const { controller } = makeController()
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {} },
      { id: 'b', cwd: projectB, title: 'B', overrides: {} }
    ])

    await controller.restore()
    await controller.whenSettled()

    expect(controller.list()[0]!.status).not.toBe('stopped')
  })

  test('фоновая восстановленная вкладка ждёт перехода на неё', async () => {
    const { controller } = makeController()
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {} },
      { id: 'b', cwd: projectB, title: 'B', overrides: {} }
    ])

    await controller.restore()
    await controller.whenSettled()

    // Starting every restored tab's agent at once would spawn a process per
    // tab on launch (spec 6.12).
    expect(controller.list()[1]!.status).toBe('stopped')

    await controller.activate('b')
    await controller.whenSettled()
    expect(controller.list()[1]!.status).not.toBe('stopped')
  })

  test('идентификатор последней сессии сохраняется вместе с папкой', async () => {
    const { controller, speak } = makeController()
    await controller.restore()
    await controller.whenSettled()

    const id = controller.list()[0]!.id
    await speak(id)
    const sessionId = controller.sessionIdOf(id)
    expect(sessionId).toBeTruthy()

    const stored = JSON.parse(
      require('node:fs').readFileSync(join(store, TABS_FILE), 'utf8')
    ) as Array<Record<string, unknown>>
    expect(stored[0]!['lastSessionId']).toBe(sessionId)
  })

  test('содержимое переписки на диск не пишется', async () => {
    const { controller } = makeController({
      script: { steps: [{ kind: 'text', text: 'секретный ответ агента' }] }
    })
    await controller.restore()
    await controller.whenSettled()

    const raw = require('node:fs').readFileSync(join(store, TABS_FILE), 'utf8') as string
    expect(raw).not.toContain('секретный ответ агента')
    expect(raw).not.toContain('ribbon')
  })

  test('возобновление восстанавливает ленту прошлой сессии', async () => {
    const { controller } = makeController({
      historyMessages: [
        { type: 'user', message: { role: 'user', content: 'что было вчера' } },
        {
          type: 'assistant',
          message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'вчера было это' }] }
        }
      ]
    })
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'вчерашняя-сессия' }
    ])

    await controller.restore()
    await controller.whenSettled()

    const items = controller.itemsOf('a')
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(items.filter((i) => i.kind === 'agentText')[0]).toMatchObject({
      text: 'вчера было это'
    })
  })

  test('превью читает транскрипт каждой вкладки по её cwd, один раз', async () => {
    const { controller, transcriptReads } = makeController()
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'сессия-в-a' },
      { id: 'b', cwd: projectB, title: 'B', overrides: {}, lastSessionId: 'сессия-в-b' }
    ])

    await controller.restore()
    await controller.whenSettled()
    // Every restored tab is read at once, the background one too.
    expect(transcriptReads).toEqual([
      ['сессия-в-a', projectA],
      ['сессия-в-b', projectB]
    ])

    // Starting it later reads nothing more: the preview is what it carries on from.
    await controller.activate('b')
    await controller.whenSettled()
    expect(transcriptReads).toHaveLength(2)
  })

  test('сохранённый идентификатор сессии передаётся как resume', async () => {
    const { controller, resumedWith } = makeController()
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'вчерашняя-сессия' }
    ])

    await controller.restore()
    await controller.whenSettled()

    expect(resumedWith).toContain('вчерашняя-сессия')
  })

  test('сессию возобновить не удалось синхронно — чистая вкладка и строка в ленте', async () => {
    const { controller, speak } = makeController({ resumeFailsSync: true })
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая-сессия' }
    ])

    await controller.restore()
    await controller.whenSettled()

    const tab = controller.list()[0]!
    expect(tab.status).not.toBe('error')

    // The dead session's own error stays in the history the new one carries
    // on from; the last word is what happened to the conversation.
    const notices = controller.itemsOf('a').filter((i) => i.kind === 'notice')
    expect((notices.at(-1) as { text: string }).text).toContain('Прошлую переписку открыть не удалось')
    expect((notices.at(-1) as { text: string }).text).toContain('не открывается')

    // And the tab is usable: a fresh session came up in place of the old one.
    await speak('a')
    expect(controller.sessionIdOf('a')).toBeTruthy()
  })

  test('сессию возобновить не удалось на лету — чистая вкладка и строка в ленте', async () => {
    // The shape every real failure takes: the CLI starts, then rejects the
    // transcript. Checking the status right after start() sees «starting».
    const { controller, speak } = makeController({ resumeFails: true })
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая-сессия' }
    ])

    await controller.restore()
    await controller.whenSettled()

    const tab = controller.list()[0]!
    expect(tab.status).not.toBe('error')

    const notices = controller.itemsOf('a').filter((i) => i.kind === 'notice')
    expect((notices[0] as { text: string } | undefined)?.text).toContain('не открывается')
    await speak('a')
    expect(controller.sessionIdOf('a')).toBeTruthy()

    // And the dead id is forgotten, or every later launch retries it.
    const stored = JSON.parse(
      require('node:fs').readFileSync(join(store, TABS_FILE), 'utf8')
    ) as Array<Record<string, unknown>>
    expect(stored[0]!['lastSessionId']).not.toBe('пропавшая-сессия')
  })

  test('вкладка с исчезнувшей папкой помечается и не поднимает сессию', async () => {
    const gone = join(store, 'исчезнувшая')
    mkdirSync(gone)
    rmSync(gone, { recursive: true })
    writeStoredTabs([{ id: 'a', cwd: gone, title: 'A', overrides: {} }])

    const { controller } = makeController()
    await controller.restore()
    await controller.whenSettled()

    const tab = controller.list()[0]!
    expect(tab.missingCwd).toBe(true)
    expect(tab.status).toBe('stopped')
  })

  test('новая вкладка начинается с настроек по умолчанию', async () => {
    // Otherwise «Модель по умолчанию» in settings is a field that does nothing.
    const { controller } = makeController({ defaults: { model: 'claude-haiku-4-5' } })
    await controller.restore()
    await controller.whenSettled()

    expect(controller.list()[0]!.overrides.model).toBe('claude-haiku-4-5')
  })

  test('закрытие последней вкладки открывает новую', async () => {
    const { controller } = makeController()
    await controller.restore()
    const id = controller.list()[0]!.id

    await controller.close(id)

    expect(controller.list()).toHaveLength(1)
    expect(controller.list()[0]!.id).not.toBe(id)
  })

  test('закрытие вкладки не трогает соседнюю', async () => {
    const { controller, speak } = makeController()
    await controller.restore()
    const first = controller.list()[0]!.id
    const second = controller.create(projectB).id
    await controller.whenSettled()

    await controller.close(first)

    expect(controller.list().map((t) => t.id)).toEqual([second])
    await speak(second)
    expect(controller.sessionIdOf(second)).toBeTruthy()
  })

  test('открытие из истории поднимает ровно одну сессию', async () => {
    // Creating the tab and then closing and recreating its session leaves the
    // first one running: an orphan agent process whose own init overwrites the
    // tab's stored session id with a throwaway one.
    const { controller, created } = makeController()
    await controller.restore()
    await controller.whenSettled()
    const before = created.length

    controller.openHistory(projectB, 'вчерашняя-сессия', 'Вчера')
    await controller.whenSettled()

    expect(created.length - before).toBe(1)

    const tab = controller.list().at(-1)!
    expect(tab.cwd).toBe(projectB)
    expect(created.at(-1)!.resume).toBe('вчерашняя-сессия')
  })

  test('restart поднимает новую сессию вместо прежней', async () => {
    const { controller, speak } = makeController()
    await controller.restore()
    await controller.whenSettled()
    const id = controller.list()[0]!.id
    await speak(id)
    const before = controller.sessionIdOf(id)
    expect(before).toBeTruthy()

    await controller.restart(id)
    await speak(id)

    expect(controller.sessionIdOf(id)).toBeTruthy()
    expect(controller.sessionIdOf(id)).not.toBe(before)
  })

  test('изменения ленты уходят наружу с номером вкладки', async () => {
    const { controller, ribbon } = makeController({
      script: { steps: [{ kind: 'text', text: 'привет' }] }
    })
    await controller.restore()
    await controller.whenSettled()

    const id = controller.list()[0]!.id
    expect(ribbon.every((e) => e.tabId === id)).toBe(true)
    expect(ribbon.length).toBeGreaterThan(0)
  })
})

describe('TabController: возобновление не ждёт агента', () => {
  test('переписка показывается, даже если сессия молчит до первого вопроса', async () => {
    // What the real CLI does on --resume: it starts and says nothing at all,
    // not even system/init, until it is given something to answer. Waiting for
    // it left the tab blank until you typed — and the message you typed was
    // the thing that unblocked it.
    const silent = {
      messages: (async function* () {
        await new Promise(() => undefined)
      })(),
      send: () => undefined,
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedCommands: async () => [],
      mcpServerStatus: async () => [],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1, percentage: 0, categories: [] }),
      dispose: async () => undefined
    }

    const manager = new AgentSessionManager({
      getAgentPath: () => 'claude',
      resolveAgent: () => 'C:/bin/claude.exe',
      askPermission: async () => ({ behavior: 'deny' as const }),
      createDriver: () => silent as unknown as AgentDriver
    })

    const controller = new TabController({
      manager,
      storeDir: store,
      defaultCwd: projectA,
      getDefaults: () => ({}),
      history: {
        list: async () => [],
        transcript: async () => [
          { type: 'user', message: { role: 'user', content: 'что было вчера' } },
          {
            type: 'assistant',
            message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'вот что' }] }
          }
        ]
      },
      onChanged: () => undefined,
      onRibbon: () => undefined,
      onPanel: () => undefined,
      onStatus: () => undefined,
      onCommands: () => undefined
    })

    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'вчерашняя' }
    ])
    await controller.restore()
    // Deliberately not whenSettled(): this session never settles, and the
    // conversation must not be waiting on it.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const items = controller.itemsOf('a')
    expect(items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(items.filter((i) => i.kind === 'agentText')[0]).toMatchObject({ text: 'вот что' })
  })
})

describe('TabController: режим запуска переживает перезапуск', () => {
  test('вкладка без своего режима следует настройке по умолчанию', async () => {
    // Tabs stored before the setting existed have empty overrides; they must
    // still follow it rather than silently falling back to «спрашивать».
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {} }])

    const { controller, created } = makeController({ defaults: { permissionMode: 'acceptEdits' } })
    await controller.restore()
    await controller.whenSettled()

    expect(created[0]!.permissionMode).toBe('acceptEdits')
  })

  test('свой режим вкладки сильнее умолчания', async () => {
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: { permissionMode: 'plan' } }
    ])

    const { controller, created } = makeController({ defaults: { permissionMode: 'acceptEdits' } })
    await controller.restore()
    await controller.whenSettled()

    expect(created[0]!.permissionMode).toBe('plan')
  })

  test('выбранный режим запоминается у вкладки', async () => {
    const { controller } = makeController()
    await controller.restore()
    await controller.whenSettled()
    const id = controller.list()[0]!.id

    controller.rememberOverride(id, { permissionMode: 'plan' })

    const stored = JSON.parse(
      require('node:fs').readFileSync(join(store, TABS_FILE), 'utf8')
    ) as Array<{ overrides: Record<string, unknown> }>
    expect(stored[0]!.overrides['permissionMode']).toBe('plan')
  })
})

describe('TabController: снимок панели', () => {
  test('panelOf отдаёт полный снимок панели вкладки', async () => {
    const { controller } = makeController()
    const tab = controller.create(projectA)
    await controller.whenSettled()

    // Nothing has been sent; the panel is filled at start all the same.
    await vi.waitFor(() => {
      const snapshot = controller.panelOf(tab.id)
      expect(snapshot.data.context?.percent).toBe(21)
      expect(snapshot.data.model).toBe('claude-opus-5')
      expect(snapshot.data.models).toHaveLength(2)
      expect(snapshot.rev).toBeGreaterThan(0)
    })
  })

  test('вкладка без сессии отдаёт пустую панель с ревизией 0', async () => {
    const { controller } = makeController()
    expect(controller.panelOf('нет-такой')).toEqual({ rev: 0, data: EMPTY_PANEL })
  })

  test('события панели несут ревизию', async () => {
    const panels: PanelEvent[] = []
    const { controller } = makeController({ onPanel: (event) => panels.push(event) })
    const tab = controller.create(projectA)
    await controller.whenSettled()
    await vi.waitFor(() => expect(controller.panelOf(tab.id).data.models).toHaveLength(2))

    const mine = panels.filter((e) => e.tabId === tab.id)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((e) => typeof e.rev === 'number' && e.rev > 0)).toBe(true)
    expect(controller.panelOf(tab.id).rev).toBe(mine[mine.length - 1]!.rev)
  })
})

describe('TabController: фоновая вкладка видна без запуска', () => {
  const twoTabs = (): void =>
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'сессия-a' },
      { id: 'b', cwd: projectB, title: 'B', overrides: {}, lastSessionId: 'сессия-b' }
    ])

  /** The fixture session, read back the way a resume reads it. */
  async function recorded(): Promise<unknown[]> {
    const configDir = mkdtempSync(join(tmpdir(), 'qclod-cfg-'))
    try {
      const session = resumedSession('сессия-b', projectB)
      const path = writeTranscript(configDir, projectB, 'сессия-b', session.lines, session.subagents)
      return await readTranscript(path)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  }

  test('фоновая вкладка показывает ленту и подагентов без запуска процесса', async () => {
    const { controller, created, ribbon } = makeController({ historyMessages: await recorded() })
    twoTabs()

    await controller.restore()
    await controller.whenSettled()

    // Only the active tab has a process (spec §9).
    expect(created.map((c) => c.resume)).toEqual(['сессия-a'])
    expect(controller.list()[1]!.status).toBe('stopped')

    const items = controller.itemsOf('b')
    expect(items.filter((i) => i.kind === 'subagent')).toHaveLength(4)
    expect(items.filter((i) => i.kind === 'agentText').map((i) => (i as { text: string }).text)).toContain(
      'жду подагентов'
    )
    // And the window was told, every item as an append.
    const sent = ribbon.filter((e) => e.tabId === 'b').flatMap((e) => e.changes)
    expect(sent.every((c) => c.kind === 'append')).toBe(true)
    expect(sent.map((c) => (c.kind === 'append' ? c.item.id : ''))).toEqual(items.map((i) => i.id))
  })

  test('панель фоновой вкладки знает модель и оценку контекста из записи', async () => {
    const panels: PanelEvent[] = []
    const { controller } = makeController({ historyMessages: await recorded(), onPanel: (e) => panels.push(e) })
    twoTabs()

    await controller.restore()
    await controller.whenSettled()

    const snapshot = controller.panelOf('b')
    expect(snapshot.data.model).toBe('claude-opus-5')
    expect(snapshot.data.context).toEqual({
      used: 45674,
      max: 200_000,
      percent: 23,
      categories: [],
      estimated: true
    })
    expect(snapshot.rev).toBeGreaterThan(0)
    const forB = panels.filter((e) => e.tabId === 'b')
    expect(forB.some((e) => e.patch.context?.estimated === true && e.patch.model === 'claude-opus-5')).toBe(true)
  })

  test('переход на фоновую вкладку не дублирует ленту', async () => {
    const { controller, transcriptReads, ribbon, created, speak } = makeController({
      historyMessages: await recorded()
    })
    twoTabs()

    await controller.restore()
    await controller.whenSettled()
    const before = controller.itemsOf('b').map((i) => i.id)
    const sentBefore = ribbon.filter((e) => e.tabId === 'b').length

    await controller.activate('b')
    await controller.whenSettled()

    expect(created.map((c) => c.resume)).toEqual(['сессия-a', 'сессия-b'])
    expect(controller.itemsOf('b').map((i) => i.id)).toEqual(before)
    expect(transcriptReads.filter(([id]) => id === 'сессия-b')).toHaveLength(1)
    // Nothing of the history was sent to the window a second time.
    const appendedAgain = ribbon
      .filter((e) => e.tabId === 'b')
      .slice(sentBefore)
      .flatMap((e) => e.changes)
      .filter((c) => c.kind === 'append' && before.includes(c.item.id))
    expect(appendedAgain).toEqual([])

    // What comes next continues the same numbering.
    await speak('b')
    const ids = controller.itemsOf('b').map((i) => i.id)
    expect(ids.length).toBeGreaterThan(before.length)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('лимиты, узнанные активной вкладкой, видны и фоновой', async () => {
    const panels: PanelEvent[] = []
    const { controller } = makeController({ historyMessages: await recorded(), onPanel: (e) => panels.push(e) })
    twoTabs()

    await controller.restore()
    await controller.whenSettled()
    await vi.waitFor(() => expect(controller.panelOf('a').data.limits.fiveHour).not.toBeNull())

    const limits = controller.panelOf('a').data.limits
    expect(limits.fiveHour?.utilization).toBe(0.13)
    expect(controller.panelOf('b').data.limits).toEqual(limits)
    const forB = panels.filter((e) => e.tabId === 'b' && e.patch.limits)
    expect(forB.at(-1)!.patch.limits).toEqual(limits)
    expect(forB.at(-1)!.rev).toBe(controller.panelOf('b').rev)
  })

  test('восстановление мёртвой сессии оставляет историю и не повторяет id', async () => {
    const { controller, speak } = makeController({
      resumeFails: true,
      historyMessages: [
        { type: 'user', message: { role: 'user', content: 'что было вчера' } },
        {
          type: 'assistant',
          message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'вчера было это' }] }
        }
      ]
    })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая-сессия' }])

    await controller.restore()
    await controller.whenSettled()

    const items = controller.itemsOf('a')
    expect(items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual([
      'что было вчера'
    ])
    expect(items.filter((i) => i.kind === 'agentText')[0]).toMatchObject({ text: 'вчера было это' })
    expect(items.filter((i) => i.kind === 'notice').at(-1)).toMatchObject({
      text: expect.stringContaining('Прошлую переписку открыть не удалось')
    })

    const before = items.map((i) => i.id)
    await speak('a')
    const ids = controller.itemsOf('a').map((i) => i.id)
    expect(ids.slice(0, before.length)).toEqual(before)
    expect(ids.length).toBeGreaterThan(before.length)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('TabController: панель после перезапуска', () => {
  test('перезапуск сразу заменяет панель прежней сессии', async () => {
    const panels: PanelEvent[] = []
    const { controller, speak } = makeController({ onPanel: (e) => panels.push(e) })
    const tab = controller.create(projectA)
    await speak(tab.id)
    await vi.waitFor(() => expect(controller.panelOf(tab.id).data.cost).not.toBeNull())

    await controller.restart(tab.id)
    await controller.whenSettled()

    // The window, fed every event in order, holds no cost of the old session.
    const store = useAppStore.getState()
    for (const e of panels.filter((p) => p.tabId === tab.id)) store.applyPanel(e.tabId, e.patch, e.rev)
    expect(useAppStore.getState().panelByTab[tab.id]?.cost).toBeNull()

    // And a snapshot asked for after the restart is accepted over all of it.
    const newest = Math.max(...panels.map((p) => p.rev))
    const snapshot = controller.panelOf(tab.id)
    expect(snapshot.rev).toBe(newest)
    store.setPanelSnapshot(tab.id, snapshot)
    expect(useAppStore.getState().panelByTab[tab.id]).toEqual(snapshot.data)
    expect(snapshot.data.cost).toBeNull()
  })
})
