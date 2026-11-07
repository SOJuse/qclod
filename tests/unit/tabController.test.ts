import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { TabController } from '../../src/main/tabs/TabController'
import { AgentSessionManager } from '../../src/main/agent/AgentSessionManager'
import type { AgentDriver } from '../../src/main/agent/driver'
import { TABS_FILE } from '../../src/main/store/tabsStore'
import type { RibbonEvent, TabState } from '../../src/shared/types'

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
}

function makeController(
  options: {
    script?: Parameters<typeof createFakeSdk>[0]
    resumeFails?: boolean
    historyMessages?: unknown[]
  } = {}
): Harness {
  const changed: TabState[][] = []
  const ribbon: RibbonEvent[] = []
  const resumedWith: Array<string | undefined> = []

  const manager = new AgentSessionManager({
    getAgentPath: () => 'claude',
    resolveAgent: () => 'C:/bin/claude.exe',
    askPermission: async () => ({ behavior: 'deny' as const }),
    createDriver: (driverOptions) => {
      resumedWith.push(driverOptions.resume)
      if (options.resumeFails && driverOptions.resume) {
        throw new Error(`Сессия ${driverOptions.resume} не открывается`)
      }
      return createFakeSdk(options.script ?? { steps: [] }) as unknown as AgentDriver
    }
  })

  const controller = new TabController({
    manager,
    storeDir: store,
    defaultCwd: projectA,
    history: {
      list: async () => [],
      messages: async () => options.historyMessages ?? []
    },
    onChanged: (tabs) => changed.push(tabs),
    onRibbon: (event) => ribbon.push(event),
    onPanel: () => undefined,
    onStatus: () => undefined,
    onCommands: () => undefined
  })

  return { controller, changed, ribbon, resumedWith }
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
    const { controller } = makeController()
    await controller.restore()
    await controller.whenSettled()

    const id = controller.list()[0]!.id
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

  test('сохранённый идентификатор сессии передаётся как resume', async () => {
    const { controller, resumedWith } = makeController()
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'вчерашняя-сессия' }
    ])

    await controller.restore()
    await controller.whenSettled()

    expect(resumedWith).toContain('вчерашняя-сессия')
  })

  test('сессию возобновить не удалось — чистая вкладка и строка в ленте', async () => {
    const { controller } = makeController({ resumeFails: true })
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
    expect(controller.sessionIdOf('a')).toBeTruthy()
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

  test('закрытие последней вкладки открывает новую', async () => {
    const { controller } = makeController()
    await controller.restore()
    const id = controller.list()[0]!.id

    await controller.close(id)

    expect(controller.list()).toHaveLength(1)
    expect(controller.list()[0]!.id).not.toBe(id)
  })

  test('закрытие вкладки не трогает соседнюю', async () => {
    const { controller } = makeController()
    await controller.restore()
    const first = controller.list()[0]!.id
    const second = controller.create(projectB).id
    await controller.whenSettled()

    await controller.close(first)

    expect(controller.list().map((t) => t.id)).toEqual([second])
    expect(controller.sessionIdOf(second)).toBeTruthy()
  })

  test('restart поднимает новую сессию вместо прежней', async () => {
    const { controller } = makeController()
    await controller.restore()
    await controller.whenSettled()
    const id = controller.list()[0]!.id
    const before = controller.sessionIdOf(id)

    await controller.restart(id)
    await controller.whenSettled()

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
