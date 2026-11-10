import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { TabController } from '../../src/main/tabs/TabController'
import { AgentSessionManager } from '../../src/main/agent/AgentSessionManager'
import type { AgentDriver } from '../../src/main/agent/driver'
import { TABS_FILE } from '../../src/main/store/tabsStore'
import { EMPTY_PANEL } from '../../src/main/agent/panelData'
import type { PanelEvent, RibbonEvent, StatusEvent, TabState } from '../../src/shared/types'
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
  manager: AgentSessionManager
  changed: TabState[][]
  ribbon: RibbonEvent[]
  resumedWith: Array<string | undefined>
  /** Every history.transcript call: (sessionId, cwd). */
  transcriptReads: Array<[string, string]>
  /** Every driver the manager actually built, in order. */
  created: Array<{
    resume: string | undefined
    permissionMode: string | undefined
    model: string | undefined
    driver: ReturnType<typeof createFakeSdk>
  }>
  /** Every driver whose resume was made to fail, in order. */
  dead: Array<{ readonly sent: unknown[] }>
  /**
   * Sends one message on a tab and waits for the answer. The CLI says nothing
   * — not even its session id — until it is spoken to.
   */
  speak(id: string): Promise<void>
}

/**
 * A resume the CLI refuses, the way the real one does: no `system/init`, just
 * an error out of the stream — at once, some time after start, or only when
 * the first message is sent. Until then it waits, and it ends on dispose.
 */
function deadResume(
  message: string,
  failAfter: number | 'firstSend'
): AgentDriver & { readonly sent: unknown[] } {
  const driver = createFakeSdk({ steps: [] })
  let fire!: () => void
  let stop!: () => void
  const failing = new Promise<'fail'>((resolve) => (fire = () => resolve('fail')))
  const closed = new Promise<'closed'>((resolve) => (stop = () => resolve('closed')))
  if (failAfter === 0) fire()
  else if (typeof failAfter === 'number') setTimeout(fire, failAfter)
  const send = driver.send.bind(driver)
  const dispose = driver.dispose.bind(driver)
  return Object.assign(driver, {
    messages: (async function* () {
      if ((await Promise.race([failing, closed])) === 'closed') return
      throw new Error(message)
    })(),
    send: (input: { text: string; attachments: unknown[] }) => {
      send(input)
      fire()
    },
    dispose: async () => {
      stop()
      await dispose()
    }
  }) as unknown as AgentDriver & { readonly sent: unknown[] }
}

function makeController(
  options: {
    script?: Parameters<typeof createFakeSdk>[0]
    resumeFails?: boolean
    resumeFailsSync?: boolean
    /** The resume dies this long after start, with nothing said before. */
    resumeFailsAfterMs?: number
    /** The resume dies only once the first message is sent. */
    resumeFailsOnSend?: boolean
    /** Reading the past conversation's transcript throws. */
    transcriptFails?: boolean
    /** How the «без проверок» confirmation answers; unset, it is never confirmed. */
    confirmBypass?: () => Promise<boolean>
    defaults?: { model?: string; permissionMode?: 'default' | 'acceptEdits' | 'plan' }
    historyMessages?: unknown[]
    onPanel?: (event: PanelEvent) => void
    /** Sees each ribbon event as it leaves, before anything mutates it. */
    onRibbon?: (event: RibbonEvent) => void
    onStatus?: (event: StatusEvent) => void
    /** The configured agent cannot be found at all. */
    agentMissing?: boolean
    /** Every driver, fresh or resumed, dies before init with this message. */
    everyStreamFails?: string
    /** A resumed driver dies on its first message: the agent is not logged in. Read on every start. */
    notLoggedInOnSend?: boolean
  } = {}
): Harness {
  const changed: TabState[][] = []
  const ribbon: RibbonEvent[] = []
  const resumedWith: Array<string | undefined> = []
  const created: Harness['created'] = []
  const transcriptReads: Harness['transcriptReads'] = []
  const dead: Harness['dead'] = []
  const deadResumeFor = (message: string, failAfter: number | 'firstSend'): AgentDriver => {
    const driver = deadResume(message, failAfter)
    dead.push(driver)
    return driver
  }

  const manager = new AgentSessionManager({
    getAgentPath: () => 'claude',
    resolveAgent: () => {
      if (options.agentMissing) throw new Error('Агент не найден: claude')
      return 'C:/bin/claude.exe'
    },
    askPermission: async () => ({ behavior: 'deny' as const }),
    ...(options.confirmBypass ? { confirmBypass: options.confirmBypass } : {}),
    createDriver: (driverOptions) => {
      resumedWith.push(driverOptions.resume)
      if (options.everyStreamFails) return deadResumeFor(options.everyStreamFails, 0)
      if (options.notLoggedInOnSend && driverOptions.resume) {
        return deadResumeFor('Not logged in · Please run /login', 'firstSend')
      }
      if (options.resumeFailsSync && driverOptions.resume) {
        throw new Error(`Сессия ${driverOptions.resume} не открывается`)
      }
      // The real driver only builds the query object here; the CLI is spawned
      // and the resume attempted while the stream is read. A failure therefore
      // surfaces asynchronously, which is the shape that must be handled.
      if (options.resumeFails && driverOptions.resume) {
        return deadResumeFor(`Сессия ${driverOptions.resume} не открывается`, 0)
      }
      if (options.resumeFailsAfterMs !== undefined && driverOptions.resume) {
        return deadResumeFor(
          `No conversation found with session ID: ${driverOptions.resume}`,
          options.resumeFailsAfterMs
        )
      }
      if (options.resumeFailsOnSend && driverOptions.resume) {
        return deadResumeFor(
          `No conversation found with session ID: ${driverOptions.resume}`,
          'firstSend'
        )
      }
      const driver = createFakeSdk(options.script ?? { steps: [] })
      created.push({
        resume: driverOptions.resume,
        permissionMode: driverOptions.permissionMode,
        model: driverOptions.model,
        driver
      })
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
        if (options.transcriptFails) throw new Error('транскрипт не читается')
        return options.historyMessages ?? []
      }
    },
    onChanged: (tabs) => changed.push(tabs),
    onRibbon: (event) => {
      ribbon.push(event)
      options.onRibbon?.(event)
    },
    onPanel: options.onPanel ?? (() => undefined),
    onStatus: options.onStatus ?? (() => undefined),
    onCommands: () => undefined
  })

  const speak = async (id: string): Promise<void> => {
    await controller.whenSettled()
    manager.get(id)!.send({ text: 'привет', attachments: [] })
    await controller.whenSettled()
  }

  return { controller, manager, changed, ribbon, resumedWith, transcriptReads, created, dead, speak }
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

  test('драйвер не создался при resume — это не мёртвая переписка: ошибка видна, id цел', async () => {
    // createDriver only loads the SDK; it never sees the conversation, so a
    // throw there says nothing about whether the conversation still opens.
    const { controller, manager, created } = makeController({ resumeFailsSync: true })
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая-сессия' }
    ])

    await controller.restore()
    await controller.whenSettled()

    expect(controller.list()[0]!.status).toBe('error')
    const notices = controller.itemsOf('a').filter((i) => i.kind === 'notice')
    expect((notices.at(-1) as { text: string }).text).toContain('не открывается')
    expect((notices.at(-1) as { text: string }).text).not.toContain('Прошлую переписку')
    expect(created).toHaveLength(0)
    expect(manager.get('a')).toBeDefined()
    expect(storedTabs()[0]!['lastSessionId']).toBe('пропавшая-сессия')
  })

  test('агент не найден при resume — id переписки остаётся на диске', async () => {
    const { controller, created } = makeController({ agentMissing: true })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'живая' }])

    await controller.restore()
    await controller.whenSettled()

    expect(controller.list()[0]!.status).toBe('error')
    expect(created).toHaveLength(0)
    expect(controller.list()[0]!.lastSessionId).toBe('живая')
    expect(storedTabs()[0]!['lastSessionId']).toBe('живая')
  })

  test('сбой до init и у новой сессии (агент падает при запуске) — id переписки остаётся на диске', async () => {
    const { controller, dead } = makeController({ everyStreamFails: 'Агент упал при запуске' })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'живая' }])

    await controller.restore()
    await vi.waitFor(() => expect(dead.length).toBe(2))
    await vi.waitFor(() => expect(controller.list()[0]!.status).toBe('error'))
    await controller.whenSettled()

    // The replacement never introduced itself, so nothing proves the
    // conversation is gone: it is tried again next time.
    expect(storedTabs()[0]!['lastSessionId']).toBe('живая')
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

function storedTabs(): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(store, TABS_FILE), 'utf8')) as Array<Record<string, unknown>>
}

describe('TabController: мёртвая сессия при resume (B4)', () => {
  const lastNotice = (controller: TabController, id: string): string =>
    (controller.itemsOf(id).filter((i) => i.kind === 'notice').at(-1) as { text: string } | undefined)
      ?.text ?? ''

  test('resume, который падает позже старта, всё равно заменяется чистой сессией', async () => {
    const { controller, manager } = makeController({ resumeFailsAfterMs: 50 })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])

    await controller.restore()
    await controller.whenSettled()
    const dead = manager.get('a')
    expect(dead).toBeDefined()

    await vi.waitFor(() =>
      expect(lastNotice(controller, 'a')).toContain('Прошлую переписку открыть не удалось')
    )
    await controller.whenSettled()
    expect(lastNotice(controller, 'a')).toContain('No conversation found')
    expect(controller.list()[0]!.status).not.toBe('error')
    expect(manager.get('a')).toBeDefined()
    expect(manager.get('a')).not.toBe(dead)
  })

  test('мёртвый id сменяется на диске только тогда, когда новая сессия представилась', async () => {
    const { controller, speak } = makeController({ resumeFailsAfterMs: 50 })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])

    await controller.restore()
    await controller.whenSettled()
    expect(storedTabs()[0]!['lastSessionId']).toBe('пропавшая')

    await vi.waitFor(() =>
      expect(lastNotice(controller, 'a')).toContain('Прошлую переписку открыть не удалось')
    )
    await controller.whenSettled()
    // The fresh session has said nothing yet: until it does, nothing proves
    // the old conversation is the one at fault, so it is not erased.
    expect(controller.sessionIdOf('a')).toBeNull()
    expect(storedTabs()[0]!['lastSessionId']).toBe('пропавшая')

    await speak('a')
    expect(controller.sessionIdOf('a')).toBeTruthy()
    expect(storedTabs()[0]!['lastSessionId']).toBe(controller.sessionIdOf('a'))
  })

  test('resume, который падает только на первом сообщении, тоже заменяется', async () => {
    const { controller, manager } = makeController({ resumeFailsOnSend: true })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])

    await controller.restore()
    await controller.whenSettled()
    const dead = manager.get('a')!
    expect(controller.list()[0]!.status).toBe('idle')

    dead.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() =>
      expect(lastNotice(controller, 'a')).toContain('Прошлую переписку открыть не удалось')
    )
    await controller.whenSettled()
    expect(controller.list()[0]!.status).not.toBe('error')
    expect(manager.get('a')).not.toBe(dead)
    // The message went on to the new session, which answered and so is the
    // one remembered now.
    expect(storedTabs()[0]!['lastSessionId']).not.toBe('пропавшая')
    expect(storedTabs()[0]!['lastSessionId']).toBe(controller.sessionIdOf('a'))
  })

  const userTexts = (controller: TabController, id: string): string[] =>
    controller
      .itemsOf(id)
      .filter((i) => i.kind === 'user')
      .map((i) => (i as { text: string }).text)

  test('сообщение, на котором умер resume, уходит новой сессии само, один раз', async () => {
    const { controller, manager, created, dead } = makeController({ resumeFailsOnSend: true })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])
    await controller.restore()
    await controller.whenSettled()

    manager.get('a')!.send({ text: 'привет', attachments: [{ kind: 'file', path: 'C:/проект/a.txt' }] })
    await vi.waitFor(() => expect(created.at(-1)?.driver.sent ?? []).toHaveLength(1))
    await vi.waitFor(() => expect(controller.list()[0]!.status).toBe('idle'))
    await controller.whenSettled()

    const fresh = created.at(-1)!
    expect(fresh.resume).toBeUndefined()
    // Exactly what the dead session was given, composed text and attachments.
    expect(fresh.driver.sent).toEqual(dead[0]!.sent)
    expect(fresh.driver.sent).toHaveLength(1)
    // One bubble: the one typed; the new session's echo is not a second.
    expect(userTexts(controller, 'a')).toEqual(['привет'])
  })

  test('несколько сообщений до смерти resume уходят новой сессии по порядку', async () => {
    const { controller, manager, created } = makeController({ resumeFailsOnSend: true })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])
    await controller.restore()
    await controller.whenSettled()

    const session = manager.get('a')!
    session.send({ text: 'один', attachments: [] })
    session.send({ text: 'два', attachments: [] })
    await vi.waitFor(() => expect(created.at(-1)?.driver.sent ?? []).toHaveLength(2))
    await vi.waitFor(() => expect(controller.list()[0]!.status).toBe('idle'))
    await controller.whenSettled()

    const sent = created.at(-1)!.driver.sent as Array<{ text: string }>
    expect(sent.map((m) => m.text)).toEqual(['один', 'два'])
    expect(userTexts(controller, 'a')).toEqual(['один', 'два'])
  })

  test('чистая сессия после мёртвого resume запускается с настройками вкладки и умолчаниями', async () => {
    const { controller, created } = makeController({
      resumeFailsAfterMs: 30,
      defaults: { model: 'claude-haiku-4-5', permissionMode: 'plan' }
    })
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: { effort: 'high' }, lastSessionId: 'пропавшая' }
    ])
    await controller.restore()
    await vi.waitFor(() =>
      expect(lastNotice(controller, 'a')).toContain('Прошлую переписку открыть не удалось')
    )
    await controller.whenSettled()

    const fresh = created.at(-1)!
    expect(fresh.resume).toBeUndefined()
    expect(fresh.model).toBe('claude-haiku-4-5')
    expect(fresh.permissionMode).toBe('plan')
    await vi.waitFor(() => expect(fresh.driver.effort).toBe('high'))
  })

  test('режим «без проверок» чистой сессии после мёртвого resume не достаётся', async () => {
    const { controller, created } = makeController({
      resumeFailsAfterMs: 30,
      confirmBypass: async () => true
    })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])
    await controller.restore()
    await controller.whenSettled()
    // Switched on in the running tab, and so remembered by it.
    controller.rememberOverride('a', { permissionMode: 'bypassPermissions' })

    await vi.waitFor(() =>
      expect(lastNotice(controller, 'a')).toContain('Прошлую переписку открыть не удалось')
    )
    await controller.whenSettled()

    expect(created.at(-1)!.resume).toBeUndefined()
    expect(created.at(-1)!.permissionMode).toBe('default')
  })

  test('ошибка после init — не мёртвый resume: вкладку не подменяют', async () => {
    // A session that introduced itself opened fine; a later failure is its
    // own and stays on screen as an error, not as a lost conversation.
    const { controller, manager } = makeController({
      script: { steps: [], nextTurn: [{ kind: 'crash', message: 'упал посреди ответа' }] }
    })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'живая' }])

    await controller.restore()
    await controller.whenSettled()
    const session = manager.get('a')!
    session.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() => expect(controller.list()[0]!.status).toBe('error'))
    await controller.whenSettled()

    expect(manager.get('a')).toBe(session)
    expect(lastNotice(controller, 'a')).not.toContain('Прошлую переписку открыть не удалось')
  })

  test('restart тоже сразу забывает прежний id на диске', async () => {
    const { controller, speak } = makeController()
    await controller.restore()
    await controller.whenSettled()
    const id = controller.list()[0]!.id
    await speak(id)
    expect(storedTabs()[0]!['lastSessionId']).toBe(controller.sessionIdOf(id))

    await controller.restart(id)
    await controller.whenSettled()

    expect(controller.sessionIdOf(id)).toBeNull()
    expect(storedTabs()[0]!['lastSessionId']).toBeUndefined()
  })

  test('превью, которое не читается, не мешает агенту вкладки подняться', async () => {
    const { controller, resumedWith } = makeController({ transcriptFails: true })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'вчерашняя' }])

    await controller.restore()
    await controller.whenSettled()

    expect(resumedWith).toContain('вчерашняя')
    expect(controller.list()[0]!.status).toBe('idle')
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
    // «не открывается» says nothing about the conversation being gone: the
    // honest line is that the session did not start.
    expect(items.filter((i) => i.kind === 'notice').at(-1)).toMatchObject({
      text: expect.stringContaining('Сессия не запустилась')
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

describe('TabController: ревизия ленты', () => {
  const twoTabs = (): void =>
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'сессия-a' },
      { id: 'b', cwd: projectB, title: 'B', overrides: {}, lastSessionId: 'сессия-b' }
    ])
  const history = [
    { type: 'user', message: { role: 'user', content: 'старый вопрос' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'старый ответ' }] } }
  ]
  const script = {
    steps: [
      { kind: 'text' as const, text: 'первое' },
      { kind: 'textStream' as const, pieces: ['по', 'том'] },
      { kind: 'tool' as const, name: 'Read', input: { file_path: 'C:/a.ts' }, result: 'x' }
    ]
  }

  function revsOf(events: RibbonEvent[], tabId: string): number[] {
    return events.filter((e) => e.tabId === tabId).map((e) => e.rev)
  }

  test('каждое событие несёт ревизию, она только растёт, снимок знает последнюю', async () => {
    const { controller, ribbon, speak } = makeController({ script })
    const tab = controller.create(projectA)
    await speak(tab.id)

    const revs = revsOf(ribbon, tab.id)
    expect(revs.length).toBeGreaterThan(2)
    for (let i = 1; i < revs.length; i++) expect(revs[i]!).toBeGreaterThan(revs[i - 1]!)

    const snapshot = controller.ribbonOf(tab.id)
    expect(snapshot.rev).toBe(revs.at(-1))
    expect(snapshot.items).toEqual(controller.itemsOf(tab.id))
  })

  test('вкладка без ленты отдаёт пустой снимок с ревизией 0', () => {
    const { controller } = makeController()
    expect(controller.ribbonOf('нет-такой')).toEqual({ rev: 0, items: [], todo: null })
  })

  test('снимок в любой момент плюс все события дают ту же ленту, что в main', async () => {
    // What the window sees: each event and the snapshot cross IPC as copies.
    const seen: RibbonEvent[] = []
    let snapshotAt = -1
    let snapshot: ReturnType<TabController['ribbonOf']> | null = null
    const harness = makeController({
      script,
      onRibbon: (event) => {
        seen.push(structuredClone(event))
        // Taken mid-stream, while later changes are still to come.
        if (seen.length === 3) {
          snapshot = structuredClone(harness.controller.ribbonOf(event.tabId))
          snapshotAt = seen.length
        }
      }
    })
    const tab = harness.controller.create(projectA)
    await harness.speak(tab.id)
    expect(snapshot).not.toBeNull()

    // Order one: the snapshot is answered before the batch carrying its last changes.
    const store = useAppStore.getState()
    store.setRibbon(tab.id, snapshot!)
    for (const e of seen) store.applyRibbon(e.tabId, e.changes, e.rev)
    expect(useAppStore.getState().ribbonByTab[tab.id]).toEqual(harness.controller.itemsOf(tab.id))

    // Order two: those events land first, the snapshot after them.
    useAppStore.setState({ ribbonByTab: {}, ribbonRevByTab: {} })
    for (const e of seen.slice(0, snapshotAt)) store.applyRibbon(e.tabId, e.changes, e.rev)
    store.setRibbon(tab.id, snapshot!)
    for (const e of seen.slice(snapshotAt)) store.applyRibbon(e.tabId, e.changes, e.rev)
    expect(useAppStore.getState().ribbonByTab[tab.id]).toEqual(harness.controller.itemsOf(tab.id))
  })

  test('ревизия продолжается, когда сессия принимает превью, и не идёт назад', async () => {
    const { controller, ribbon, speak } = makeController({ script, historyMessages: history })
    twoTabs()
    await controller.restore()
    await controller.whenSettled()

    const preview = controller.ribbonOf('b')
    expect(preview.rev).toBeGreaterThan(0)
    expect(preview.items.length).toBeGreaterThan(0)
    const sentBefore = ribbon.length

    await controller.activate('b')
    await speak('b')

    const after = revsOf(ribbon.slice(sentBefore), 'b')
    expect(after.length).toBeGreaterThan(0)
    for (const rev of after) expect(rev).toBeGreaterThan(preview.rev)
    expect(controller.ribbonOf('b').rev).toBe(after.at(-1))
  })

  test('перезапуск не повторяет ревизий и не теряет историю', async () => {
    const { controller, ribbon, speak } = makeController({ script })
    const tab = controller.create(projectA)
    await speak(tab.id)
    const before = controller.ribbonOf(tab.id)
    const beforeIds = before.items.map((i) => i.id)
    const sentBefore = ribbon.length

    await controller.restart(tab.id)
    await speak(tab.id)

    const after = revsOf(ribbon.slice(sentBefore), tab.id)
    expect(after.length).toBeGreaterThan(0)
    for (const rev of after) expect(rev).toBeGreaterThan(before.rev)
    // The window keeps what it showed; the snapshot must say the same, and
    // the new session's items must not reuse the old ids.
    const ids = controller.itemsOf(tab.id).map((i) => i.id)
    expect(ids.slice(0, beforeIds.length)).toEqual(beforeIds)
    expect(ids.length).toBeGreaterThan(beforeIds.length)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('TabController: замена сессии без гонок', () => {
  const history = [
    { type: 'user', message: { role: 'user', content: 'старый вопрос' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'старый ответ' }] } }
  ]

  /**
   * Runs `during` while the manager is closing the tab's old session — after
   * it is gone from the manager, before its dispose is over.
   */
  function whileClosing(harness: Harness, tabId: string, during: () => void): void {
    const close = harness.manager.close.bind(harness.manager)
    let done = false
    vi.spyOn(harness.manager, 'close').mockImplementation(async (id) => {
      const closing = close(id)
      if (id === tabId && !done) {
        done = true
        during()
      }
      await closing
    })
  }

  test('вкладка закрыта, пока закрывалась мёртвая сессия — новая не поднимается и ничего не шлёт', async () => {
    const harness = makeController({ resumeFailsOnSend: true })
    writeStoredTabs([
      { id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' },
      { id: 'b', cwd: projectB, title: 'B', overrides: {} }
    ])
    await harness.controller.restore()
    await harness.controller.whenSettled()
    whileClosing(harness, 'a', () => void harness.controller.close('a'))

    harness.manager.get('a')!.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() => expect(harness.controller.list().map((t) => t.id)).toEqual(['b']))
    await harness.controller.whenSettled()

    expect(harness.manager.get('a')).toBeUndefined()
    // Nothing was built for the closed tab, so nothing was resent either.
    expect(harness.created.filter((c) => c.driver.sent.length > 0)).toEqual([])
    expect(harness.manager.list().map(([id]) => id)).not.toContain('a')
  })

  test('вкладка закрыта во время restart — новая сессия не поднимается', async () => {
    const harness = makeController()
    const a = harness.controller.create(projectA)
    harness.controller.create(projectB)
    await harness.speak(a.id)
    whileClosing(harness, a.id, () => void harness.controller.close(a.id))

    await harness.controller.restart(a.id)
    await harness.controller.whenSettled()

    expect(harness.manager.get(a.id)).toBeUndefined()
    expect(harness.controller.ribbonOf(a.id)).toEqual({ rev: 0, items: [], todo: null })
  })

  test('снимок ленты во время restart не пустой', async () => {
    const harness = makeController({ historyMessages: history })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'вчера' }])
    await harness.controller.restore()
    await harness.controller.whenSettled()
    const before = harness.controller.ribbonOf('a')
    expect(before.items.length).toBeGreaterThan(0)

    let during: ReturnType<TabController['ribbonOf']> | null = null
    whileClosing(harness, 'a', () => (during = structuredClone(harness.controller.ribbonOf('a'))))
    await harness.controller.restart('a')

    expect(during!.items).toEqual(before.items)
  })

  test('снимок ленты во время замены мёртвой сессии не пустой', async () => {
    const harness = makeController({ resumeFailsOnSend: true, historyMessages: history })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])
    await harness.controller.restore()
    await harness.controller.whenSettled()

    let during: ReturnType<TabController['ribbonOf']> | null = null
    whileClosing(harness, 'a', () => (during = structuredClone(harness.controller.ribbonOf('a'))))
    harness.manager.get('a')!.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() => expect(during).not.toBeNull())
    await harness.controller.whenSettled()

    const texts = during!.items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)
    expect(texts).toEqual(['старый вопрос', 'привет'])
  })

  test('поздние события прежней сессии после restart не трогают статус и панель вкладки', async () => {
    const statuses: StatusEvent[] = []
    const panels: PanelEvent[] = []
    const harness = makeController({
      onStatus: (e) => statuses.push(e),
      onPanel: (e) => panels.push(e)
    })
    const tab = harness.controller.create(projectA)
    await harness.controller.whenSettled()
    const old = harness.manager.get(tab.id)!

    await harness.controller.restart(tab.id)
    await harness.controller.whenSettled()
    const fresh = harness.manager.get(tab.id)!
    expect(fresh).not.toBe(old)
    const statusesBefore = statuses.length
    const panelsBefore = panels.length
    const panelBefore = harness.controller.panelOf(tab.id)

    // A result the old one still delivers, a late failure, a late patch.
    old.handle({ type: 'result', subtype: 'success', is_error: false, result: '' })
    ;(old as unknown as { fail: (err: unknown) => void }).fail(new Error('поздно'))
    await old.setPermissionMode('plan')

    expect(statuses.slice(statusesBefore)).toEqual([])
    expect(panels.slice(panelsBefore)).toEqual([])
    expect(harness.controller.list()[0]!.status).toBe(fresh.status)
    expect(harness.controller.panelOf(tab.id)).toEqual(panelBefore)
  })
})

describe('TabController: подмена сессии, «Повторить» и честная причина', () => {
  /**
   * Holds the manager's close of the tab's session open until the test lets
   * it go: the old session is already gone from the manager, the new one not
   * made yet.
   */
  function holdClose(harness: Harness, tabId: string): { reached: () => boolean; release: () => void } {
    const close = harness.manager.close.bind(harness.manager)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let reached = false
    vi.spyOn(harness.manager, 'close').mockImplementation(async (id) => {
      const closing = close(id)
      if (id === tabId && !reached) {
        reached = true
        await gate
      }
      await closing
    })
    return { reached: () => reached, release }
  }

  const notices = (controller: TabController, id: string): Array<{ text: string; action?: string }> =>
    controller.itemsOf(id).filter((i) => i.kind === 'notice') as Array<{ text: string; action?: string }>

  test('activate во время восстановления не открывает мёртвую переписку второй раз', async () => {
    const harness = makeController({ resumeFailsOnSend: true })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])
    await harness.controller.restore()
    await harness.controller.whenSettled()
    expect(harness.resumedWith).toEqual(['пропавшая'])

    const hold = holdClose(harness, 'a')
    const create = vi.spyOn(harness.manager, 'create')
    harness.manager.get('a')!.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() => expect(hold.reached()).toBe(true))

    // The user clicks the tab while the dead session is still closing.
    await harness.controller.activate('a')
    hold.release()
    await harness.controller.whenSettled()

    // One session made, the clean one; the dead id was not opened again.
    expect(create).toHaveBeenCalledTimes(1)
    expect(harness.resumedWith).toEqual(['пропавшая', undefined])
    expect(harness.dead).toHaveLength(1)
    const fresh = harness.created.at(-1)!
    expect(fresh.resume).toBeUndefined()
    // The message the dead session died on went to the clean one, once.
    expect(fresh.driver.sent).toHaveLength(1)
    expect(harness.manager.get('a')).toBeDefined()
    expect(harness.controller.list()[0]!.status).not.toBe('error')
  })

  test('activate во время restart не возвращает старую переписку', async () => {
    const harness = makeController()
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'вчера' }])
    await harness.controller.restore()
    await harness.controller.whenSettled()
    expect(harness.resumedWith).toEqual(['вчера'])

    const hold = holdClose(harness, 'a')
    const create = vi.spyOn(harness.manager, 'create')
    const restarting = harness.controller.restart('a')
    await vi.waitFor(() => expect(hold.reached()).toBe(true))

    await harness.controller.activate('a')
    hold.release()
    await restarting
    await harness.controller.whenSettled()

    expect(create).toHaveBeenCalledTimes(1)
    expect(harness.resumedWith).toEqual(['вчера', undefined])
    expect(harness.controller.list()[0]!.lastSessionId).toBeUndefined()
    expect(storedTabs()[0]!['lastSessionId']).toBeUndefined()
  })

  test('«Повторить» после ненайденного агента открывает ту же переписку', async () => {
    const options = { agentMissing: true }
    const harness = makeController(options)
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'живая' }])
    await harness.controller.restore()
    await harness.controller.whenSettled()

    const failed = harness.controller.list()[0]!
    expect(failed.status).toBe('error')
    expect(failed.canRetry).toBe(true)
    expect(failed.lastSessionId).toBe('живая')

    // The user installs the agent and asks to try again.
    options.agentMissing = false
    await harness.controller.retry('a')
    await harness.controller.whenSettled()

    expect(harness.created).toHaveLength(1)
    expect(harness.created[0]!.resume).toBe('живая')
    const after = harness.controller.list()[0]!
    expect(after.status).toBe('idle')
    expect(after.canRetry).toBeFalsy()
    expect(storedTabs()[0]!['lastSessionId']).toBe('живая')
  })

  test('guard: вкладке без переписки «Повторить» не предлагается', async () => {
    const harness = makeController({ agentMissing: true })
    harness.controller.create(projectA)
    await harness.controller.whenSettled()

    const tab = harness.controller.list()[0]!
    expect(tab.status).toBe('error')
    expect(tab.canRetry).toBeFalsy()
  })

  test('«Не вошёл в аккаунт» до init: сессия не подменяется, есть «Войти» и «Повторить»', async () => {
    const harness = makeController({ everyStreamFails: 'Not logged in · Please run /login' })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'живая' }])
    const create = vi.spyOn(harness.manager, 'create')
    await harness.controller.restore()
    await vi.waitFor(() => expect(harness.controller.list()[0]!.status).toBe('error'))
    await harness.controller.whenSettled()

    // A clean session would die the same way: none is made.
    expect(create).toHaveBeenCalledTimes(1)
    expect(harness.dead).toHaveLength(1)
    const tab = harness.controller.list()[0]!
    expect(tab.status).toBe('error')
    expect(tab.canRetry).toBe(true)
    expect(storedTabs()[0]!['lastSessionId']).toBe('живая')

    const said = notices(harness.controller, 'a')
    expect(said.some((n) => n.text.includes('Прошлую переписку'))).toBe(false)
    expect(said.at(-1)).toMatchObject({
      text: 'Claude Code не вошёл в аккаунт. Войдите и нажмите «Повторить».',
      action: 'login'
    })
  })

  test('«Повторить», пока вход не сделан, снова пробует ту же переписку', async () => {
    const harness = makeController({ everyStreamFails: 'Not logged in · Please run /login' })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'живая' }])
    await harness.controller.restore()
    await vi.waitFor(() => expect(harness.controller.list()[0]!.canRetry).toBe(true))
    await harness.controller.whenSettled()

    await harness.controller.retry('a')
    await vi.waitFor(() => expect(harness.dead).toHaveLength(2))
    await vi.waitFor(() => expect(harness.controller.list()[0]!.canRetry).toBe(true))
    await harness.controller.whenSettled()

    expect(harness.resumedWith).toEqual(['живая', 'живая'])
    expect(harness.controller.list()[0]!.status).toBe('error')
    expect(storedTabs()[0]!['lastSessionId']).toBe('живая')
    // The same notice is not stacked once per failed try.
    const login = notices(harness.controller, 'a').filter((n) => n.action === 'login')
    expect(login).toHaveLength(1)
  })

  test('«Повторить» после входа отправляет сообщение, на котором сессия умерла, один раз', async () => {
    const options = { notLoggedInOnSend: true }
    const harness = makeController(options)
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'живая' }])
    await harness.controller.restore()
    await harness.controller.whenSettled()

    // The CLI says it is not logged in only once it is spoken to.
    harness.manager.get('a')!.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() => expect(harness.controller.list()[0]!.canRetry).toBe(true))
    await harness.controller.whenSettled()
    expect(harness.created).toHaveLength(0)

    // The user logs in and presses «Повторить».
    options.notLoggedInOnSend = false
    await harness.controller.retry('a')
    await vi.waitFor(() => expect(harness.created.at(-1)?.driver.sent ?? []).toHaveLength(1))
    await harness.controller.whenSettled()

    const fresh = harness.created.at(-1)!
    expect(harness.created).toHaveLength(1)
    expect(fresh.resume).toBe('живая')
    expect(fresh.driver.sent).toEqual(harness.dead[0]!.sent)
    const bubbles = harness.controller
      .itemsOf('a')
      .filter((i) => i.kind === 'user')
      .map((i) => (i as { text: string }).text)
    expect(bubbles).toEqual(['привет'])
  })

  test('guard: ненайденная переписка — прежнее восстановление и прежний текст', async () => {
    const harness = makeController({ resumeFailsOnSend: true })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])
    await harness.controller.restore()
    await harness.controller.whenSettled()
    const dead = harness.manager.get('a')!

    dead.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() => expect(harness.manager.get('a')).not.toBe(dead))
    await harness.controller.whenSettled()

    const said = notices(harness.controller, 'a')
    expect(said.at(-1)!.text).toBe(
      'Прошлую переписку открыть не удалось: No conversation found with session ID: пропавшая'
    )
    expect(said.some((n) => n.action === 'login')).toBe(false)
    expect(harness.created.at(-1)!.resume).toBeUndefined()
    expect(harness.controller.list()[0]!.canRetry).toBeFalsy()
  })

  test('другая причина до init — подмена, но текст «Сессия не запустилась»', async () => {
    const harness = makeController({ resumeFails: true })
    writeStoredTabs([{ id: 'a', cwd: projectA, title: 'A', overrides: {}, lastSessionId: 'пропавшая' }])
    await harness.controller.restore()
    await harness.controller.whenSettled()

    const said = notices(harness.controller, 'a')
    expect(said.at(-1)!.text).toBe('Сессия не запустилась: Сессия пропавшая не открывается')
    expect(said.some((n) => n.text.includes('Прошлую переписку'))).toBe(false)
    expect(harness.created.at(-1)!.resume).toBeUndefined()
  })

  test('guard: две вкладки на одной папке хранят свою модель независимо', async () => {
    const { controller } = makeController()
    await controller.restore()
    await controller.whenSettled()
    const first = controller.list()[0]!.id
    const second = controller.create(projectA).id

    controller.rememberOverride(first, { model: 'claude-sonnet-5' })
    controller.rememberOverride(second, { model: 'claude-opus-5', effort: 'low' })

    const [a, b] = controller.list()
    expect(a!.overrides).toMatchObject({ model: 'claude-sonnet-5' })
    expect(a!.overrides.effort).toBeUndefined()
    expect(b!.overrides).toMatchObject({ model: 'claude-opus-5', effort: 'low' })
  })
})
