import { describe, expect, test, vi } from 'vitest'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { AgentSession } from '../../src/main/agent/AgentSession'
import { AgentSessionManager } from '../../src/main/agent/AgentSessionManager'
import type { AgentDriver, DriverOptions } from '../../src/main/agent/driver'
import { toPermissionContext } from '../../src/main/agent/permissionContext'
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
    ask: async (_name: string, _input: Record<string, unknown>, _opts: unknown) =>
      ({ behavior: 'allow' }) as Awaited<ReturnType<DriverOptions['canUseTool']>>
  }
  const driver = createFakeSdk({
    ...script,
    canUseTool: (name, input, opts) => gate.ask(name, input, opts)
  })
  const session = new AgentSession({
    tabId: 't1',
    cwd: 'C:/проект',
    overrides: {},
    agentPath: 'claude',
    resolveAgent: () => 'C:/bin/claude.exe',
    askPermission: async () => ({ behavior: 'allow' as const }),
    createDriver: (options) => {
      // The fixture's third argument is the SDK's, so it is read the way the
      // real driver reads it.
      gate.ask = (name, input, opts) => options.canUseTool(name, input, toPermissionContext(opts))
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
    // The setting can change without restarting the app, so the path is
    // resolved when a session starts — never pinned once at launch. A restart
    // is a new session, which is how the manager does it.
    const resolveAgent = vi.fn(() => 'C:/bin/claude.exe')
    const manager = new AgentSessionManager({
      getAgentPath: () => 'claude',
      resolveAgent,
      askPermission: async () => ({ behavior: 'deny' as const }),
      createDriver: () => createFakeSdk({ steps: [] }) as unknown as AgentDriver
    })

    await manager.create('t1', 'C:/проект', {}).start()
    await manager.close('t1')
    await manager.create('t1', 'C:/проект', {}).start()

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

describe('AgentSession: режим без проверок', () => {
  test('без подтверждения режим не включается', async () => {
    const { session } = makeSession({ steps: [] }, { confirmBypass: async () => false })

    await session.start()
    await settle(session)
    await session.setPermissionMode('bypassPermissions')

    expect(session.panel.permissionMode).not.toBe('bypassPermissions')
  })

  test('без обработчика подтверждения режим не включается вовсе', async () => {
    // A session wired without the confirmation must refuse, not assume consent.
    const { session } = makeSession({ steps: [] })

    await session.start()
    await settle(session)
    await session.setPermissionMode('bypassPermissions')

    expect(session.panel.permissionMode).not.toBe('bypassPermissions')
  })

  test('с подтверждением режим включается', async () => {
    const { session, driver } = makeSession({ steps: [] }, { confirmBypass: async () => true })

    await session.start()
    await settle(session)
    await session.setPermissionMode('bypassPermissions')

    expect(session.panel.permissionMode).toBe('bypassPermissions')
    expect(driver.permissionMode).toBe('bypassPermissions')
  })

  test('сохранённый в настройках вкладки режим тоже проходит через подтверждение', async () => {
    // A stale tabs.json or a settings default must not walk around the dialog.
    const { session } = makeSession(
      { steps: [] },
      {
        overrides: { permissionMode: 'bypassPermissions' },
        confirmBypass: async () => false
      }
    )
    const rec = watch(session)

    await session.start()
    await settle(session)

    expect(session.panel.permissionMode).toBe('default')
    const notice = rec.items.find((i) => i.kind === 'notice') as { text: string } | undefined
    expect(notice?.text).toContain('не подтверждён')
  })
})

describe('AgentSession: план', () => {
  test('ExitPlanMode вне режима плана — обычный инструмент, а не карточка плана', async () => {
    // Otherwise a tool call could switch the permission mode by itself.
    const asked: string[] = []
    const { session } = makeSession(
      { steps: [{ kind: 'askPermission', name: 'ExitPlanMode', input: { plan: 'что-то' } }] },
      {
        askPermission: async (request) => {
          asked.push(request.toolName)
          return { behavior: 'deny' as const }
        }
      }
    )
    const rec = watch(session)

    await session.start()
    await settle(session)

    expect(asked).toEqual(['ExitPlanMode'])
    expect(rec.items.filter((i) => i.kind === 'plan')).toHaveLength(0)
  })

  test('ответ на несуществующий план ничего не помечает', async () => {
    const { session } = makeSession({ steps: [] })
    const rec = watch(session)

    await session.start()
    await settle(session)
    await session.answerPlan('нет-такого-плана', true)

    expect(rec.changes.filter((c) => c.kind === 'update')).toHaveLength(0)
  })
})

describe('AgentSession: дополнительные флаги', () => {
  test('обычные флаги доходят до драйвера', async () => {
    let seen: DriverOptions | null = null
    const { session } = makeSession(
      { steps: [] },
      {
        overrides: { extraFlags: '--verbose --fallback-model sonnet' },
        createDriver: (options: DriverOptions) => {
          seen = options
          return createFakeSdk({ steps: [] }) as unknown as AgentDriver
        }
      }
    )

    await session.start()
    await settle(session)

    expect(seen!.extraArgs).toEqual({ verbose: null, 'fallback-model': 'sonnet' })
  })

  test('флаг, выключающий разрешения, до драйвера не доходит и о нём сказано', async () => {
    let seen: DriverOptions | null = null
    const { session } = makeSession(
      { steps: [] },
      {
        overrides: { extraFlags: '--dangerously-skip-permissions --verbose' },
        createDriver: (options: DriverOptions) => {
          seen = options
          return createFakeSdk({ steps: [] }) as unknown as AgentDriver
        }
      }
    )
    const rec = watch(session)

    await session.start()
    await settle(session)

    expect(seen!.extraArgs).toEqual({ verbose: null })
    const notice = rec.items.find((i) => i.kind === 'notice') as { text: string } | undefined
    expect(notice?.text).toContain('--dangerously-skip-permissions')
  })
})

describe('AgentSession: после падения агента', () => {
  test('сообщение в мёртвую сессию не принимается молча', async () => {
    const { session, driver } = makeSession({
      steps: [{ kind: 'text', text: 'успел сказать' }, { kind: 'crash', message: 'агент умер' }]
    })
    const rec = watch(session)

    await session.start()
    await settle(session)
    expect(rec.statuses.at(-1)).toBe('error')

    session.send({ text: 'а теперь продолжи', attachments: [] })

    // Nothing is accepted into a session that cannot carry it: no user bubble
    // that will never be answered, no "busy" that never ends.
    expect(driver.sent).toHaveLength(0)
    expect(rec.items.filter((i) => i.kind === 'user')).toHaveLength(0)
    expect(rec.statuses.at(-1)).toBe('error')
  })

  test('незавершённые элементы не продолжают притворяться живыми', async () => {
    const { session } = makeSession({
      steps: [
        { kind: 'toolRunning', name: 'Bash', input: { command: 'npm test' } },
        { kind: 'crash', message: 'агент умер' }
      ]
    })
    const rec = watch(session)

    await session.start()
    await settle(session)

    const tools = rec.items.filter((i) => i.kind === 'tool') as Array<{
      state: string
      summary: string
    }>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.state).toBe('done')
    expect(tools[0]!.summary).toBe('не закончил')
  })

  test('перезапуск после падения поднимает рабочую сессию', async () => {
    let turn = 0
    const manager = new AgentSessionManager({
      getAgentPath: () => 'claude',
      resolveAgent: () => 'C:/bin/claude.exe',
      askPermission: async () => ({ behavior: 'deny' as const }),
      createDriver: () =>
        createFakeSdk(
          turn++ === 0
            ? { steps: [{ kind: 'crash', message: 'агент умер' }] }
            : { steps: [{ kind: 'text', text: 'снова на связи' }] }
        ) as unknown as AgentDriver
    })

    const crashed = manager.create('t1', 'C:/проект', {})
    await crashed.start()
    await crashed.whenIdle()
    expect(crashed.status).toBe('error')

    // What the retry button does: close the dead one, start a fresh session.
    await manager.close('t1')
    const fresh = manager.create('t1', 'C:/проект', {})
    await fresh.start()
    await fresh.whenIdle()

    expect(fresh.status).toBe('idle')
    expect(texts(fresh.items)).toContain('снова на связи')
  })
})

describe('AgentSession: сообщение с вложением', () => {
  test('файл доходит до агента @-упоминанием, а в ленте остаётся чистый текст', async () => {
    const { session, driver } = makeSession({ steps: [], nextTurn: [] })
    const rec = watch(session)

    await session.start()
    await settle(session)

    session.send({
      text: 'посмотри этот файл',
      attachments: [{ kind: 'file', path: 'C:/Мои проекты/файл 1.ts' }]
    })
    await settle(session)

    // What the agent got: the text plus a quoted mention, one path, not pieces.
    expect(driver.sent[0]!.text).toBe('посмотри этот файл\n@"C:/Мои проекты/файл 1.ts"')

    // What the user sees: what they typed, with the file as a chip.
    const users = rec.items.filter((i) => i.kind === 'user') as Array<{
      text: string
      attachments: unknown[]
    }>
    expect(users).toHaveLength(1)
    expect(users[0]!.text).toBe('посмотри этот файл')
    expect(users[0]!.attachments).toHaveLength(1)
  })

  test('эхо составленного сообщения не показывается вторым разом', async () => {
    const { session } = makeSession({ steps: [], nextTurn: [] })
    const rec = watch(session)

    await session.start()
    await settle(session)

    session.send({
      text: 'глянь',
      attachments: [{ kind: 'file', path: 'C:/проект/auth.ts' }]
    })
    await settle(session)

    // The CLI echoes what it received — the composed text. Without a shared
    // composition the echo never matched and landed as a second bubble.
    expect(rec.items.filter((i) => i.kind === 'user')).toHaveLength(1)
  })
})

describe('AgentSession: init не заканчивает ход', () => {
  test('init, пришедший после отправки, не гасит «работает»', async () => {
    // With streaming input the CLI sends system/init only once it has been
    // given something to answer — so init lands *after* the first message.
    // Treating it as a turn boundary made the very first message look dead:
    // the status flipped to idle while the agent was still working, and only
    // the second message onwards ever looked alive.
    const { session } = makeSession({ steps: [] })
    const rec = watch(session)

    await session.start()
    await settle(session)

    session.send({ text: 'первое сообщение', attachments: [] })
    expect(rec.statuses.at(-1)).toBe('busy')

    session.handle({
      type: 'system',
      subtype: 'init',
      session_id: 's-late',
      model: 'claude-opus-5',
      permissionMode: 'default',
      mcp_servers: []
    })

    expect(session.status).toBe('busy')
  })

  test('результат хода по-прежнему заканчивает ход', async () => {
    const { session } = makeSession({ steps: [] })

    await session.start()
    await settle(session)
    session.send({ text: 'раз', attachments: [] })
    expect(session.status).toBe('busy')

    session.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.01 })
    expect(session.status).toBe('idle')
  })
})

describe('AgentSession: id запросов', () => {
  test('вопрос агента — одна карточка, и ответ на неё отпускает агента', async () => {
    const { session, driver } = makeSession({
      steps: [
        { kind: 'askQuestion', question: 'Какой?', options: ['Справа', 'Снизу'] },
        { kind: 'text', text: 'понял' }
      ]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })

    const cards = rec.items.filter((i) => i.kind === 'question')
    expect(cards).toHaveLength(1)
    session.answerQuestion((cards[0] as { toolUseId: string }).toolUseId, 'Справа')

    await vi.waitFor(() => expect(texts(rec.items)).toContain('понял'), { timeout: 2000 })
    await settle(session)

    expect(rec.items.filter((i) => i.kind === 'question')).toHaveLength(1)
    // The card shows the choice (the builder reports it as a patch).
    expect(rec.changes).toContainEqual(
      expect.objectContaining({ kind: 'update', patch: { answer: 'Справа' } })
    )
    expect(session.status).toBe('idle')
    expect(driver.questionAnswers).toEqual([{ 'Какой?': 'Справа' }])
    // The answer went back through canUseTool, not a second time as a message.
    expect(driver.sent).toEqual([])
  })

  test('два разрешения в одном сообщении — два разных requestId, оба отвечаются', async () => {
    const asked: Array<{ requestId: string; resolve: (a: { behavior: 'allow' }) => void }> = []
    const { session, driver } = makeSession(
      {
        steps: [
          {
            kind: 'askPermissions',
            tools: [
              { name: 'Bash', input: { command: 'npm test' } },
              { name: 'Edit', input: { file_path: 'a.ts' } }
            ]
          }
        ]
      },
      {
        askPermission: (request) =>
          new Promise((resolve) => {
            session.showPermissionCard(request.requestId, request.toolName, request.target)
            asked.push({ requestId: request.requestId, resolve })
          })
      }
    )
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(asked).toHaveLength(2), { timeout: 2000 })
    expect(asked[0]!.requestId).not.toBe(asked[1]!.requestId)

    for (const request of asked) request.resolve({ behavior: 'allow' })
    await vi.waitFor(() => expect(driver.executedTools).toEqual(['Bash', 'Edit']), {
      timeout: 2000
    })
    await settle(session)

    // Each answer settled its own card.
    const cards = rec.items.filter((i) => i.kind === 'permission')
    expect(cards.map((c) => (c as { state: string }).state)).toEqual(['allowed', 'allowed'])
    // And each request id is the id of the tool call it was about.
    const tools = rec.items.filter((i) => i.kind === 'tool') as Array<{ toolUseId: string }>
    expect(asked.map((a) => a.requestId)).toEqual(tools.map((t) => t.toolUseId))
  })

  test('requestId разрешения — это toolUseID инструмента', async () => {
    const requestIds: string[] = []
    const { session } = makeSession(
      { steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }] },
      {
        askPermission: async (request) => {
          requestIds.push(request.requestId)
          return { behavior: 'allow' as const }
        }
      }
    )
    const rec = watch(session)

    await session.start()
    await settle(session)

    const tool = rec.items.find((i) => i.kind === 'tool') as { toolUseId: string } | undefined
    expect(tool).toBeDefined()
    expect(requestIds).toEqual([tool!.toolUseId])
  })

  test('без toolUseID два одновременных запроса всё равно получают разные id', async () => {
    const requestIds: string[] = []
    let canUseTool: DriverOptions['canUseTool'] | undefined
    const session = new AgentSession({
      tabId: 't1',
      cwd: 'C:/проект',
      overrides: {},
      agentPath: 'claude',
      resolveAgent: () => 'C:/bin/claude.exe',
      askPermission: async (request) => {
        requestIds.push(request.requestId)
        return { behavior: 'allow' as const }
      },
      createDriver: (options) => {
        canUseTool = options.canUseTool
        return createFakeSdk({ steps: [] }) as unknown as AgentDriver
      }
    })

    await session.start()
    await Promise.all([canUseTool!('Bash', {}, {}), canUseTool!('Edit', {}, {})])

    expect(requestIds).toHaveLength(2)
    expect(requestIds[0]).not.toBe(requestIds[1])
    await session.dispose()
  })
})
