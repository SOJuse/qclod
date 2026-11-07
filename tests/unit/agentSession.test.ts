import { describe, expect, test, vi } from 'vitest'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { AgentSession } from '../../src/main/agent/AgentSession'
import { AgentSessionManager } from '../../src/main/agent/AgentSessionManager'
import type { AgentDriver, DriverOptions } from '../../src/main/agent/driver'
import type { PanelData, RibbonChange, RibbonItem, SessionStatus } from '../../src/shared/types'

type FakeScript = Parameters<typeof createFakeSdk>[0]

interface Recorder {
  changes: RibbonChange[]
  panels: Array<Partial<PanelData>>
  statuses: SessionStatus[]
  items: RibbonItem[]
}

function watch(session: AgentSession): Recorder {
  const rec: Recorder = { changes: [], panels: [], statuses: [], items: [] }
  session.onChange((changes) => {
    rec.changes.push(...changes)
    rec.items = session.items
  })
  session.onPanel((patch) => rec.panels.push(patch))
  session.onStatus((status) => rec.statuses.push(status))
  return rec
}

/** Builds a session whose driver is the fake, with the executable check stubbed out. */
function makeSession(
  script: FakeScript = {},
  overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}
): { session: AgentSession; driver: ReturnType<typeof createFakeSdk> } {
  // The fixture asks about tools through whatever canUseTool it was built with;
  // the session supplies its own only when it starts, so route through a holder.
  const gate = {
    ask: async (_name: string, _input: Record<string, unknown>) =>
      ({ behavior: 'allow' }) as { behavior: 'allow' | 'deny' }
  }
  const driver = createFakeSdk({
    ...script,
    canUseTool: (name, input) => gate.ask(name, input)
  })
  const session = new AgentSession({
    tabId: 't1',
    cwd: 'C:/проект',
    overrides: {},
    agentPath: 'claude',
    resolveAgent: () => 'C:/bin/claude.exe',
    askPermission: async () => ({ behavior: 'allow' as const }),
    createDriver: (options) => {
      gate.ask = (name, input) => options.canUseTool(name, input, {})
      return driver as unknown as AgentDriver
    },
    ...overrides
  })
  return { session, driver }
}

function texts(items: RibbonItem[]): string[] {
  return items.filter((i) => i.kind === 'agentText').map((i) => (i as { text: string }).text)
}

/** The fake's stream ends on its own, so a started session settles quickly. */
async function settle(session: AgentSession): Promise<void> {
  await session.whenIdle()
}

describe('AgentSession', () => {
  test('start поднимает сессию и отдаёт изменения ленты', async () => {
    const { session } = makeSession({ steps: [{ kind: 'text', text: 'привет из агента' }] })
    const rec = watch(session)

    await session.start()
    await settle(session)

    expect(texts(rec.items)).toContain('привет из агента')
    expect(session.sessionId).toBeTruthy()
    expect(rec.statuses[0]).toBe('starting')
    expect(rec.statuses.at(-1)).toBe('idle')
  })

  test('start наполняет панель моделью, режимом, MCP и лимитами', async () => {
    const { session } = makeSession({
      steps: [{ kind: 'text', text: 'ок' }],
      init: {
        model: 'claude-opus-5',
        permissionMode: 'acceptEdits',
        mcpServers: [{ name: 'plugin:github:github', status: 'needs-auth' }]
      },
      rateLimits: {
        fiveHour: { utilization: 0.13, resetsAt: 1794083400 },
        sevenDay: { utilization: 0.38, resetsAt: 1794481200 }
      }
    })
    const rec = watch(session)

    await session.start()
    await settle(session)

    const merged = Object.assign({}, ...rec.panels) as Partial<PanelData>
    expect(merged.model).toBe('claude-opus-5')
    expect(merged.permissionMode).toBe('acceptEdits')
    expect(merged.mcp).toEqual([{ name: 'plugin:github:github', status: 'needs-auth' }])
    expect(merged.limits).toEqual({
      fiveHour: { utilization: 0.13, resetsAt: 1794083400 },
      sevenDay: { utilization: 0.38, resetsAt: 1794481200 }
    })
    expect(merged.cost?.session).toBeCloseTo(0.0421)
  })

  test('send доставляет текст и возвращает ответ агента', async () => {
    const { session, driver } = makeSession({
      steps: [{ kind: 'text', text: 'первый ход' }],
      nextTurn: [{ kind: 'text', text: 'второй ход' }]
    })
    const rec = watch(session)

    await session.start()
    await settle(session)

    session.send({ text: 'сделай рефактор', attachments: [] })
    expect(driver.sent).toEqual([{ text: 'сделай рефактор', attachments: [] }])
    expect(rec.statuses.at(-1)).toBe('busy')

    // The user's own words reach the ribbon immediately, not after the answer.
    const users = rec.items.filter((i) => i.kind === 'user')
    expect(users.at(-1)).toMatchObject({ text: 'сделай рефактор' })

    await settle(session)
    expect(texts(rec.items)).toEqual(['первый ход', 'второй ход'])
    expect(rec.statuses.at(-1)).toBe('idle')

    // The CLI echoes the message back; it must not appear twice.
    expect(rec.items.filter((i) => i.kind === 'user')).toHaveLength(1)
  })

  test('interrupt останавливает ход, сессия остаётся живой', async () => {
    const { session, driver } = makeSession({ steps: [{ kind: 'text', text: 'работаю' }] })
    const rec = watch(session)

    await session.start()
    await settle(session)
    session.send({ text: 'стоп', attachments: [] })
    await session.interrupt()

    expect(driver.interrupted).toBe(true)
    expect(driver.disposed).toBe(false)
    expect(rec.statuses.at(-1)).toBe('idle')
  })

  test('падение агента переводит в error и сохраняет уже выданные элементы', async () => {
    const { session } = makeSession({
      steps: [{ kind: 'text', text: 'успел сказать' }, { kind: 'crash', message: 'агент умер' }]
    })
    const rec = watch(session)

    await session.start()
    await settle(session)

    expect(rec.statuses.at(-1)).toBe('error')
    expect(texts(rec.items)).toContain('успел сказать')
    const notices = rec.items.filter((i) => i.kind === 'notice')
    expect(notices.at(-1)).toMatchObject({ tone: 'error' })
    expect((notices.at(-1) as { text: string }).text).toContain('агент умер')
  })

  test('отсутствующий исполняемый файл даёт понятную ошибку, а не падение', async () => {
    const { session } = makeSession(
      {},
      {
        resolveAgent: () => {
          throw new Error('Не удалось найти исполняемый файл агента: "claude".')
        }
      }
    )
    const rec = watch(session)

    await expect(session.start()).resolves.toBeUndefined()

    expect(rec.statuses.at(-1)).toBe('error')
    expect(session.error).toContain('Не удалось найти исполняемый файл агента')
    const notice = rec.items.find((i) => i.kind === 'notice') as { text: string } | undefined
    expect(notice?.text).toContain('Не удалось найти исполняемый файл агента')
  })

  test('исполняемый файл ищется на каждом старте, а не один раз', async () => {
    const resolveAgent = vi.fn(() => 'C:/bin/claude.exe')
    const { session } = makeSession({ steps: [] }, { resolveAgent })

    await session.start()
    await settle(session)
    await session.dispose()
    await session.start()

    expect(resolveAgent).toHaveBeenCalledTimes(2)
  })

  test('setPermissionMode доходит до SDK', async () => {
    const { session, driver } = makeSession({ steps: [] })
    const rec = watch(session)

    await session.start()
    await settle(session)
    await session.setPermissionMode('plan')

    expect(driver.permissionMode).toBe('plan')
    const merged = Object.assign({}, ...rec.panels) as Partial<PanelData>
    expect(merged.permissionMode).toBe('plan')
  })

  test('resume передаётся драйверу', async () => {
    let seen: DriverOptions | null = null
    const { session } = makeSession(
      { steps: [] },
      {
        createDriver: (options: DriverOptions) => {
          seen = options
          return createFakeSdk({ steps: [] }) as unknown as AgentDriver
        }
      }
    )

    await session.start('сессия-из-истории')
    await settle(session)

    expect(seen).not.toBeNull()
    expect(seen!.resume).toBe('сессия-из-истории')
    expect(seen!.cwd).toBe('C:/проект')
    expect(seen!.executablePath).toBe('C:/bin/claude.exe')
  })

  test('dispose завершает сессию', async () => {
    const { session, driver } = makeSession({ steps: [] })
    const rec = watch(session)

    await session.start()
    await settle(session)
    await session.dispose()

    expect(driver.disposed).toBe(true)
    expect(rec.statuses.at(-1)).toBe('stopped')
  })
})

describe('AgentSessionManager', () => {
  function makeManager(): AgentSessionManager {
    return new AgentSessionManager({
      getAgentPath: () => 'claude',
      resolveAgent: () => 'C:/bin/claude.exe',
      askPermission: async () => ({ behavior: 'deny' as const }),
      createDriver: () => createFakeSdk({ steps: [] }) as unknown as AgentDriver
    })
  }

  test('create отдаёт сессию, get находит её по вкладке', () => {
    const manager = makeManager()
    const session = manager.create('tab-1', 'C:/проект', {})

    expect(manager.get('tab-1')).toBe(session)
    expect(manager.get('tab-2')).toBeUndefined()
  })

  test('повторный create для той же вкладки не плодит вторую сессию', () => {
    const manager = makeManager()
    const first = manager.create('tab-1', 'C:/проект', {})
    const second = manager.create('tab-1', 'C:/проект', {})

    expect(second).toBe(first)
  })

  test('close завершает именно свою сессию', async () => {
    const manager = makeManager()
    const a = manager.create('tab-1', 'C:/a', {})
    const b = manager.create('tab-2', 'C:/b', {})
    await a.start()
    await b.start()

    await manager.close('tab-1')

    expect(manager.get('tab-1')).toBeUndefined()
    expect(manager.get('tab-2')).toBe(b)
    expect(b.status).not.toBe('stopped')
  })

  test('disposeAll не оставляет живых сессий', async () => {
    const manager = makeManager()
    manager.create('tab-1', 'C:/a', {})
    manager.create('tab-2', 'C:/b', {})
    await manager.get('tab-1')!.start()
    await manager.get('tab-2')!.start()

    await manager.disposeAll()

    expect(manager.get('tab-1')).toBeUndefined()
    expect(manager.get('tab-2')).toBeUndefined()
  })
})

describe('AgentSession: разрешения', () => {
  test('вопрос о разрешении появляется в ленте и закрывается ответом', async () => {
    const { session } = makeSession(
      { steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }] },
      {
        askPermission: async (request) => {
          session.showPermissionCard(request.requestId, request.toolName, request.target)
          return { behavior: 'allow' as const }
        }
      }
    )
    const rec = watch(session)

    await session.start()
    await settle(session)

    const cards = rec.items.filter((i) => i.kind === 'permission')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ toolName: 'Bash', target: 'npm test', state: 'allowed' })
  })

  test('отказ помечает карточку отклонённой, инструмент не выполняется', async () => {
    const { session, driver } = makeSession(
      { steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'rm -rf /' } }] },
      {
        askPermission: async (request) => {
          session.showPermissionCard(request.requestId, request.toolName, request.target)
          return { behavior: 'deny' as const }
        }
      }
    )
    const rec = watch(session)

    await session.start()
    await settle(session)

    expect(rec.items.filter((i) => i.kind === 'permission')[0]).toMatchObject({ state: 'denied' })
    expect(driver.executedTools).not.toContain('Bash')
  })

  test('упавший обработчик разрешений отклоняет, а не разрешает', async () => {
    const { session, driver } = makeSession(
      { steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }] },
      {
        askPermission: async (request) => {
          session.showPermissionCard(request.requestId, request.toolName, request.target)
          throw new Error('окно закрылось')
        }
      }
    )
    const rec = watch(session)

    await session.start()
    await settle(session)

    // A gate that failed is not a gate that said yes.
    expect(driver.executedTools).not.toContain('Bash')
    expect(rec.items.filter((i) => i.kind === 'permission')[0]).toMatchObject({ state: 'denied' })
  })
})
