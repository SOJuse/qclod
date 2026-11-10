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

  test('resume читает транскрипт по cwd вкладки', async () => {
    const { controller, transcriptReads } = makeController()
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'сессия-в-a' },
      { id: 'b', cwd: projectB, title: 'B', overrides: {}, lastSessionId: 'сессия-в-b' }
    ])

    await controller.restore()
    await controller.whenSettled()
    expect(transcriptReads).toEqual([['сессия-в-a', projectA]])

    await controller.activate('b')
    await controller.whenSettled()
    expect(transcriptReads).toEqual([
      ['сессия-в-a', projectA],
      ['сессия-в-b', projectB]
    ])
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

    const notices = controller.itemsOf('a').filter((i) => i.kind === 'notice')
    expect(notices).toHaveLength(1)
    expect((notices[0] as { text: string }).text).toContain('не открывается')

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
