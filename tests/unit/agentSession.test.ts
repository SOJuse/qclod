import { describe, expect, test, vi } from 'vitest'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { AgentSession, seedFromTranscript } from '../../src/main/agent/AgentSession'
import { AgentSessionManager } from '../../src/main/agent/AgentSessionManager'
import { LOGIN_NEEDED_TEXT } from '../../src/main/agent/startFailure'
import type { AgentDriver, DriverOptions, SendOptions } from '../../src/main/agent/driver'
import { toPermissionContext } from '../../src/main/agent/permissionContext'
import { PermissionBroker } from '../../src/main/agent/permissions'
import type {
  PanelData,
  PermissionRequest,
  RemoteInfo,
  RibbonChange,
  RibbonItem,
  SessionStatus
} from '../../src/shared/types'
import { REMOTE_BLOCK_TEXT } from '../../src/shared/remote'
import type { AutonomyInput } from '../../src/core/autonomy/types'

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
  test('onStatus возвращает отписку, и отписавшийся больше не слышит статусов', async () => {
    const { session } = makeSession()
    const heard: SessionStatus[] = []
    const others: SessionStatus[] = []
    const stop = session.onStatus((status) => {
      heard.push(status)
      // Stopping from inside the call must not skip the next listener.
      if (status === 'starting') stop()
    })
    session.onStatus((status) => others.push(status))

    await session.start()
    await session.dispose()

    expect(heard).toEqual(['starting'])
    expect(others).toEqual(['starting', 'idle', 'stopped'])
  })

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

  test('новая сессия без входа: notice «Войти», сырой ошибки в ленте нет', async () => {
    const raw = 'Not logged in · Please run /login'
    const { session } = makeSession({ steps: [{ kind: 'crash', message: raw }] })
    const rec = watch(session)

    await session.start()
    await settle(session)

    expect(session.status).toBe('error')
    const notices = rec.items.filter((i) => i.kind === 'notice')
    expect(notices.at(-1)).toEqual(
      expect.objectContaining({ tone: 'error', action: 'login', text: LOGIN_NEEDED_TEXT })
    )
    expect(JSON.stringify(rec.items)).not.toContain('Not logged in')
    // The raw words stay for whoever needs to know why: the tab, the retry.
    expect(session.error).toBe(raw)
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

  test('минуты «авто-да» из настроек доходят до сессии через менеджер', async () => {
    let minutes = 15
    const manager = new AgentSessionManager({
      getAgentPath: () => 'claude',
      askPermission: async () => ({ behavior: 'deny' as const }),
      confirmAutoAllow: async () => true,
      autoAnswerMinutes: () => minutes,
      createDriver: () => createFakeSdk({ steps: [] }) as unknown as AgentDriver
    })
    const shown = (items: RibbonItem[]): string =>
      items
        .filter((i) => i.kind === 'notice')
        .map((i) => (i as { text: string }).text)
        .join('\n')

    const first = manager.create('t1', 'C:/проект', {})
    const rec = watch(first)
    await first.start()
    await first.setPermissionMode('autoAllow')
    expect(shown(rec.items)).toContain('не ответите за 15 мин')
    await manager.close('t1')

    // Read when the line is shown: a changed setting reaches the next session.
    minutes = 30
    const second = manager.create('t1', 'C:/проект', {})
    const seen = watch(second)
    await second.start()
    await second.setPermissionMode('autoAllow')
    expect(shown(seen.items)).toContain('не ответите за 30 мин')
    await manager.close('t1')
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

  test('disposeAll менеджера тоже не виснет на таком драйвере', async () => {
    const manager = new AgentSessionManager({
      getAgentPath: () => 'claude',
      resolveAgent: () => 'C:/bin/claude.exe',
      askPermission: async () => ({ behavior: 'deny' as const }),
      disposeTimeoutMs: 50,
      createDriver: () => {
        const driver = createFakeSdk({ steps: [] })
        ;(driver as unknown as { dispose: () => Promise<void> }).dispose = () => new Promise(() => {})
        return driver as unknown as AgentDriver
      }
    })
    const session = manager.create('tab-1', 'C:/проект', {})
    await session.start()

    const started = Date.now()
    await manager.disposeAll()

    expect(Date.now() - started).toBeLessThan(1000)
    expect(session.status).toBe('stopped')
  })

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
    await session.setPermissionMode('acceptEdits')
    expect(session.panel.permissionMode).toBe('acceptEdits')
    await session.setPermissionMode('bypassPermissions')

    // Refused means left alone — not reset to «спрашивать».
    expect(session.panel.permissionMode).toBe('acceptEdits')
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
    await session.answerPlan('нет-такого-плана', { approve: true })

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

  test('упавшая сессия закрывает свой драйвер', async () => {
    const { session, driver } = makeSession({
      steps: [{ kind: 'crash', message: 'агент умер' }]
    })

    await session.start()
    await settle(session)

    expect(session.status).toBe('error')
    await vi.waitFor(() => expect(driver.disposed).toBe(true), { timeout: 2000 })
  })

  test('упавшая сессия снимает карточку разрешения, поздний клик ничего не делает', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const { session, driver } = brokeredSession(broker, sessions, {
      nextTurn: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
    })
    const rec = watch(session)

    await session.start()
    session.send({ text: 'прогони тесты', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })

    // The pump's catch path: the stream died while a card was open.
    ;(session as unknown as { fail: (e: unknown) => void }).fail(new Error('агент умер'))
    await tick()
    expect(session.status).toBe('error')
    expect(rec.items.filter((i) => i.kind === 'permission')[0]).toMatchObject({ state: 'denied' })

    broker.answer(asked[0]!.requestId, { behavior: 'allow' })
    await tick()

    expect(session.status).toBe('error')
    expect(driver.executedTools).not.toContain('Bash')
  })

  test('после падения клик по вопросу идёт сообщением, а не ответом на месте', async () => {
    const { session, driver } = makeSession({
      steps: [{ kind: 'askQuestion', question: 'Какой?', options: ['Справа', 'Снизу'] }]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    ;(session as unknown as { fail: (e: unknown) => void }).fail(new Error('агент умер'))
    await tick()
    expect(session.status).toBe('error')

    const card = rec.items.find((i) => i.kind === 'question') as { toolUseId: string }
    session.answerQuestion(card.toolUseId, { 'Какой?': 'Справа' })
    await tick()

    // No live question to answer in place, and no driver to take a message.
    expect(driver.questionAnswers).toEqual([])
    expect(driver.sent).toHaveLength(0)
    expect(session.status).toBe('error')
  })

  test('драйвер, который не закрывается, не держит dispose дольше срока', async () => {
    const { session, driver } = makeSession({ steps: [] }, { disposeTimeoutMs: 50 })
    ;(driver as unknown as { dispose: () => Promise<void> }).dispose = () => new Promise(() => {})
    await session.start()

    const started = Date.now()
    await session.dispose()

    expect(Date.now() - started).toBeLessThan(1000)
    expect(session.status).toBe('stopped')
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

  test('картинка с миниатюрой: агенту — байты, в ленте — только миниатюра', async () => {
    const { session, driver } = makeSession({ steps: [], nextTurn: [] })
    const rec = watch(session)
    await session.start()
    await settle(session)

    const image = {
      kind: 'image' as const,
      mediaType: 'image/png',
      dataBase64: 'БАЙТЫ',
      thumbnail: 'data:image/png;base64,AA',
      path: 'C:/ud/pastes/paste-1-abcdef01.png'
    }
    session.send({ text: 'смотри', attachments: [image] })
    await settle(session)

    expect(driver.sent[0]!.attachments).toEqual([image])
    const user = rec.items.find((i) => i.kind === 'user') as { attachments: unknown[] }
    expect(user.attachments).toEqual([{ ...image, dataBase64: '' }])
  })

  test('большая GIF без миниатюры: в ленте байт нет, есть путь к копии', async () => {
    const { session, driver } = makeSession({ steps: [], nextTurn: [] })
    const rec = watch(session)
    await session.start()
    await settle(session)

    const gif = {
      kind: 'image' as const,
      mediaType: 'image/gif',
      dataBase64: 'ОЧЕНЬ-МНОГО-БАЙТ',
      path: 'C:/ud/pastes/paste-1-abcdef01.gif'
    }
    session.send({ text: '', attachments: [gif] })
    await settle(session)

    expect(driver.sent[0]!.attachments).toEqual([gif])
    const user = rec.items.find((i) => i.kind === 'user') as { attachments: unknown[] }
    expect(user.attachments).toEqual([{ ...gif, dataBase64: '' }])
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
  test('ответы на все вопросы уходят в updatedInput.answers', async () => {
    const { session, driver } = makeSession({
      steps: [
        {
          kind: 'askQuestion',
          questions: [
            { question: 'A', options: ['1', 'x'] },
            { question: 'B', options: ['2', 'y'], multiSelect: true }
          ]
        },
        { kind: 'text', text: 'принял' }
      ]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    const card = rec.items.find((i) => i.kind === 'question') as { toolUseId: string }
    session.answerQuestion(card.toolUseId, { A: '1', B: '2' })

    await vi.waitFor(() => expect(texts(rec.items)).toContain('принял'), { timeout: 2000 })
    await settle(session)
    expect(driver.questionAnswers).toEqual([{ A: '1', B: '2' }])
    expect(driver.sent).toEqual([])
  })

  test('чужие ключи отбрасываются, неполный ответ не отпускает агента', async () => {
    const { session, driver } = makeSession({
      steps: [
        {
          kind: 'askQuestion',
          questions: [
            { question: 'A', options: ['1', 'x'] },
            { question: 'B', options: ['2', 'y'] }
          ]
        },
        { kind: 'text', text: 'принял' }
      ]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    const card = rec.items.find((i) => i.kind === 'question') as { toolUseId: string }

    // One of two questions, and a key that is not a question: still waiting.
    session.answerQuestion(card.toolUseId, { A: '1', чужой: 'x' })
    await tick()
    expect(session.status).toBe('waiting')
    expect(driver.questionAnswers).toEqual([])
    expect(rec.items.find((i) => i.kind === 'question')).toMatchObject({ answers: null })

    // Everything asked, plus a stranger: the stranger is dropped.
    session.answerQuestion(card.toolUseId, { A: '1', B: '2', чужой: 'x' })
    await vi.waitFor(() => expect(texts(rec.items)).toContain('принял'), { timeout: 2000 })
    await settle(session)
    expect(driver.questionAnswers).toEqual([{ A: '1', B: '2' }])
  })

  test('после стопа ответы на несколько вопросов уходят одним сообщением по строке на вопрос', async () => {
    const { session, driver } = makeSession({
      steps: [
        {
          kind: 'askQuestion',
          questions: [
            { question: 'Где?', options: ['Слева', 'Справа'] },
            { question: 'Цвет?', options: ['Синий', 'Красный'] }
          ]
        }
      ],
      nextTurn: [{ kind: 'text', text: 'ок' }]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    await session.interrupt()
    const card = rec.items.find((i) => i.kind === 'question') as { toolUseId: string }
    session.answerQuestion(card.toolUseId, { 'Где?': 'Справа', 'Цвет?': 'Красный' })

    expect(driver.sent.at(-1)?.text).toBe('«Где?» — Справа\n«Цвет?» — Красный')
    await session.dispose()
  })

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
    session.answerQuestion((cards[0] as { toolUseId: string }).toolUseId, { 'Какой?': 'Справа' })

    await vi.waitFor(() => expect(texts(rec.items)).toContain('понял'), { timeout: 2000 })
    await settle(session)

    expect(rec.items.filter((i) => i.kind === 'question')).toHaveLength(1)
    // The card shows the choice (the builder reports it as a patch).
    expect(rec.changes).toContainEqual(
      expect.objectContaining({ kind: 'update', patch: { answers: { 'Какой?': 'Справа' } } })
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

/**
 * A session whose permission questions go through a real broker, the way the
 * app wires it: the broker shows the card, the test answers through the broker.
 */
function brokeredSession(
  broker: PermissionBroker,
  sessions: Map<string, AgentSession>,
  script: FakeScript,
  overrides: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}
): ReturnType<typeof makeSession> {
  const made = makeSession(script, {
    askPermission: (r, signal) => broker.request(r.tabId, r.toolName, r.input, r.requestId, signal),
    ...overrides
  })
  sessions.set(overrides.tabId ?? 't1', made.session)
  return made
}

function makeBrokerFor(sessions: Map<string, AgentSession>): {
  broker: PermissionBroker
  asked: PermissionRequest[]
} {
  const asked: PermissionRequest[] = []
  const broker = new PermissionBroker({
    loadRules: () => [],
    saveRules: () => undefined,
    ask: (request) => {
      asked.push(request)
      sessions.get(request.tabId)?.showPermissionCard(request.requestId, request.toolName, request.target)
    }
  })
  return { broker, asked }
}

/** Lets any late answer finish what it would do. */
async function tick(): Promise<void> {
  await new Promise(setImmediate)
  await new Promise(setImmediate)
}

describe('AgentSession: стоп во время вопроса', () => {
  test('стоп отменяет ожидающее разрешение, поздний клик не возвращает «работает»', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const { session, driver } = brokeredSession(broker, sessions, {
      nextTurn: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
    })
    const rec = watch(session)

    await session.start()
    session.send({ text: 'прогони тесты', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })

    await session.interrupt()

    expect(session.status).toBe('idle')
    expect(rec.items.filter((i) => i.kind === 'permission')[0]).toMatchObject({ state: 'denied' })

    broker.answer(asked[0]!.requestId, { behavior: 'allow' })
    await tick()

    expect(session.status).toBe('idle')
    expect(driver.executedTools).not.toContain('Bash')
    expect(rec.items.filter((i) => i.kind === 'permission')[0]).toMatchObject({ state: 'denied' })
    await session.dispose()
  })

  test('стоп отменяет ожидающий план', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker } = makeBrokerFor(sessions)
    const { session, driver } = brokeredSession(
      broker,
      sessions,
      {
        init: { permissionMode: 'plan' },
        nextTurn: [{ kind: 'askPermission', name: 'ExitPlanMode', input: { plan: 'сделать всё' } }]
      },
      { overrides: { permissionMode: 'plan' } }
    )
    const rec = watch(session)

    await session.start()
    session.send({ text: 'составь план', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })

    await session.interrupt()

    expect(session.status).toBe('idle')
    const plan = rec.items.find((i) => i.kind === 'plan') as { requestId: string; state: string }
    expect(plan.state).toBe('rejected')

    // Approving a plan the agent no longer waits on changes nothing.
    await session.answerPlan(plan.requestId, { approve: true })
    await tick()

    expect(session.status).toBe('idle')
    expect(session.panel.permissionMode).toBe('plan')
    expect(driver.permissionMode).toBe('plan')
    expect(driver.executedTools).not.toContain('ExitPlanMode')
    await session.dispose()
  })

  test('клик по варианту вопроса после стопа уходит сообщением и ход кончается idle', async () => {
    const { session, driver } = makeSession({
      steps: [{ kind: 'askQuestion', question: 'Какой?', options: ['Справа', 'Снизу'] }],
      nextTurn: [{ kind: 'text', text: 'ок' }]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })

    await session.interrupt()
    expect(session.status).toBe('idle')

    const card = rec.items.find((i) => i.kind === 'question') as { toolUseId: string }
    session.answerQuestion(card.toolUseId, { 'Какой?': 'Справа' })

    expect(driver.sent.at(-1)?.text).toBe('Справа')
    await vi.waitFor(
      () => {
        expect(texts(rec.items)).toContain('ок')
        expect(session.status).toBe('idle')
      },
      { timeout: 2000 }
    )
    // The cancelled question was never answered in place.
    expect(driver.questionAnswers).toEqual([])
    await session.dispose()
  })

  test('стоп в одной вкладке не трогает ожидающий запрос другой', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const script: FakeScript = {
      nextTurn: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
    }
    const one = brokeredSession(broker, sessions, script, { tabId: 't1' })
    const two = brokeredSession(broker, sessions, script, { tabId: 't2' })

    await one.session.start()
    await two.session.start()
    one.session.send({ text: 'раз', attachments: [] })
    two.session.send({ text: 'два', attachments: [] })
    await vi.waitFor(
      () => {
        expect(one.session.status).toBe('waiting')
        expect(two.session.status).toBe('waiting')
      },
      { timeout: 2000 }
    )

    await one.session.interrupt()

    expect(two.session.status).toBe('waiting')
    const theirs = asked.find((r) => r.tabId === 't2')!
    broker.answer(theirs.requestId, { behavior: 'allow' })

    await vi.waitFor(() => expect(two.driver.executedTools).toEqual(['Bash']), { timeout: 2000 })
    await vi.waitFor(() => expect(two.session.status).toBe('idle'), { timeout: 2000 })
    expect(one.driver.executedTools).toEqual([])
    await one.session.dispose()
    await two.session.dispose()
  })

  test('закрытие вкладки с ожидающим вопросом помечает карточку и не оставляет ожидания', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const { session, driver } = brokeredSession(broker, sessions, {
      nextTurn: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
    })
    const rec = watch(session)

    await session.start()
    session.send({ text: 'прогони тесты', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })

    await session.dispose()

    expect(session.status).toBe('stopped')
    expect(rec.items.filter((i) => i.kind === 'permission')[0]).toMatchObject({ state: 'denied' })
    broker.answer(asked[0]!.requestId, { behavior: 'allow' })
    await tick()
    expect(session.status).toBe('stopped')
    expect(driver.executedTools).toEqual([])
  })
})

describe('AgentSession: два разрешения сразу', () => {
  test('ответ на одно оставляет «ждёт», пока ждёт второе', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const { session, driver } = brokeredSession(broker, sessions, {
      nextTurn: [
        {
          kind: 'askPermissions',
          tools: [
            { name: 'Bash', input: { command: 'npm test' } },
            { name: 'Edit', input: { file_path: 'a.ts' } }
          ]
        }
      ]
    })

    await session.start()
    session.send({ text: 'делай', attachments: [] })
    await vi.waitFor(() => expect(asked).toHaveLength(2), { timeout: 2000 })
    expect(session.status).toBe('waiting')

    broker.answer(asked[0]!.requestId, { behavior: 'allow' })
    await tick()
    expect(session.status).toBe('waiting')

    broker.answer(asked[1]!.requestId, { behavior: 'allow' })
    await vi.waitFor(() => expect(driver.executedTools).toEqual(['Bash', 'Edit']), {
      timeout: 2000
    })
    await vi.waitFor(() => expect(session.status).toBe('idle'), { timeout: 2000 })
    await session.dispose()
  })
})

describe('AgentSession: фоновый подагент переживает ход', () => {
  test('ход кончается idle, а фоновый подагент в ленте всё ещё работает, пока не придёт уведомление', async () => {
    const { session } = makeSession({
      steps: [
        {
          kind: 'backgroundAgent',
          name: 'Прогон тестов',
          pauseMs: 150,
          finish: { status: 'completed', summary: 'готово', tokens: 900, toolUses: 4, durationMs: 8000 }
        }
      ]
    })
    const rec = watch(session)
    await session.start()
    await settle(session)
    session.send({ text: 'запусти тесты', attachments: [] })

    const card = (): RibbonItem | undefined => rec.items.find((i) => i.kind === 'subagent')
    await vi.waitFor(() => expect(card()).toBeDefined(), { timeout: 2000, interval: 5 })
    await vi.waitFor(() => expect(session.status).toBe('idle'), { timeout: 2000, interval: 5 })
    expect(card()).toMatchObject({ state: 'running', background: true })

    await vi.waitFor(() => expect(card()).toMatchObject({ state: 'done', tokens: 900 }), { timeout: 2000 })
  })
})

describe('AgentSession: фоновые команды', () => {
  test('список задач идёт в панель, вывод и «Остановить» — только для задач из списка', async () => {
    const { session, driver } = makeSession({
      steps: [],
      nextTurn: [
        {
          kind: 'backgroundBash',
          command: 'npm run dev',
          taskId: 'b1',
          chunks: ['готово 1\n'],
          pauseMs: 20,
          finish: null
        }
      ]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'запусти', attachments: [] })

    await vi.waitFor(
      () =>
        expect(session.panel.backgroundTasks).toEqual([
          expect.objectContaining({ taskId: 'b1', command: 'npm run dev', status: 'running' })
        ]),
      { timeout: 2000, interval: 5 }
    )
    expect(rec.panels.some((p) => p.backgroundTasks !== undefined)).toBe(true)

    await vi.waitFor(
      async () => expect((await session.taskOutput('b1'))?.output).toBe('готово 1\n'),
      { timeout: 2000, interval: 10 }
    )
    // An id the tab never listed reaches neither the driver nor the agent.
    const output = vi.spyOn(driver, 'taskOutput')
    const stop = vi.spyOn(driver, 'stopTask')
    await expect(session.taskOutput('чужая')).resolves.toBeNull()
    await session.stopTask('чужая')
    expect(output).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()

    await session.stopTask('b1')
    expect(stop).toHaveBeenCalledWith('b1')
    await vi.waitFor(
      () => expect(session.panel.backgroundTasks[0]).toMatchObject({ taskId: 'b1', status: 'stopped' }),
      { timeout: 2000, interval: 5 }
    )
    // A finished task is not stopped again.
    await session.stopTask('b1')
    expect(stop).toHaveBeenCalledTimes(1)
    await session.dispose()
  })

  test('отказ остановить доходит до того, кто просил, задача работает дальше', async () => {
    const { session } = makeSession({
      steps: [],
      stopTaskError: 'задача уже закончилась',
      nextTurn: [{ kind: 'backgroundBash', command: 'npm run dev', taskId: 'b1', finish: null }]
    })
    await session.start()
    session.send({ text: 'запусти', attachments: [] })
    await vi.waitFor(() => expect(session.panel.backgroundTasks[0]?.status).toBe('running'), {
      timeout: 2000,
      interval: 5
    })
    await expect(session.stopTask('b1')).rejects.toThrow('задача уже закончилась')
    expect(session.panel.backgroundTasks[0]?.status).toBe('running')
    await session.dispose()
  })

  test('агент упал — работавшие задачи прерваны, законченные остались как были', async () => {
    const { session } = makeSession({
      steps: [],
      nextTurn: [
        { kind: 'backgroundBash', command: 'npm run build', taskId: 'b1', finish: null },
        { kind: 'backgroundBash', command: 'npm run dev', taskId: 'b2', finish: null },
        { kind: 'crash', message: 'процесс агента завершился' }
      ]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'запусти', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('error'), { timeout: 2000, interval: 5 })

    expect(session.panel.backgroundTasks).toEqual([
      expect.objectContaining({ taskId: 'b2', status: 'interrupted', endedAt: expect.any(Number) }),
      expect.objectContaining({ taskId: 'b1', status: 'interrupted', endedAt: expect.any(Number) })
    ])
    // The window was told, not just the session.
    const last = rec.panels.filter((p) => p.backgroundTasks !== undefined).at(-1)
    expect(last?.backgroundTasks?.every((t) => t.status === 'interrupted')).toBe(true)
    await session.dispose()
  })
})


describe('AgentSession: панель полна до первого сообщения', () => {
  test('до первого сообщения панель знает контекст, модель, модели и лимиты', async () => {
    // steps: [] — the fake is silent until something is sent, like CLI
    // 2.1.317: no init, no rate_limit_event, no result.
    const { session, driver } = makeSession({ steps: [] })

    await session.start()

    await vi.waitFor(() => {
      expect(session.panel.context?.percent).toBe(21)
      expect(session.panel.model).toBe('claude-opus-5')
      expect(session.panel.models).toHaveLength(2)
      expect(session.panel.limits.fiveHour?.utilization).toBe(0.13)
      expect(session.panel.limits.sevenDay?.utilization).toBe(0.38)
    })
    expect(driver.sent).toEqual([])
    await session.dispose()
  })

  test('сохранённое усилие вкладки применяется при старте и видно в панели', async () => {
    const { session, driver } = makeSession({ steps: [] }, { overrides: { effort: 'high' } })

    await session.start()

    await vi.waitFor(() => expect(driver.effort).toBe('high'))
    expect(session.panel.effort).toBe('high')
    await session.dispose()
  })

  test('сохранённое усилие уходит раньше первого сообщения из очереди', async () => {
    const { session, driver } = makeSession({ steps: [] }, { overrides: { effort: 'high' } })
    const order: string[] = []
    const d = driver as unknown as {
      setEffort: (e: string) => Promise<void>
      send: (...args: unknown[]) => unknown
    }
    const setEffort = d.setEffort.bind(driver)
    const send = d.send.bind(driver)
    d.setEffort = (e) => {
      order.push(`effort:${e}`)
      return setEffort(e)
    }
    d.send = (...args) => {
      order.push('send')
      return send(...args)
    }

    const started = session.start()
    expect(session.send({ text: 'привет', attachments: [] })).toBe(true)
    await started

    await vi.waitFor(() => expect(order).toContain('send'))
    expect(order.slice(0, 2)).toEqual(['effort:high', 'send'])
    await session.dispose()
  })

  test('отказ драйвера применить сохранённое усилие не попадает в панель и виден заметкой', async () => {
    const { session, driver } = makeSession({ steps: [] }, { overrides: { effort: 'high' } })
    const rec = watch(session)
    ;(driver as unknown as { setEffort: () => Promise<void> }).setEffort = () =>
      Promise.reject(new Error('refused'))

    await session.start()

    await vi.waitFor(() =>
      expect(rec.items.some((i) => JSON.stringify(i).includes('high'))).toBe(true)
    )
    expect(session.panel.effort).toBeNull()
    await session.dispose()
  })

  test('драйвер без supportedModels/mcpServerStatus не роняет процесс', async () => {
    const { session, driver } = makeSession({})
    delete (driver as Partial<typeof driver>).supportedModels
    delete (driver as Partial<typeof driver>).mcpServerStatus
    const seen: unknown[] = []
    const h = (e: unknown): number => seen.push(e)
    process.on('unhandledRejection', h)

    await session.start()
    // init arrives only after a message; its refreshModels is the unwrapped call.
    session.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() => expect(session.panel.cost).not.toBeNull())
    await new Promise((r) => setTimeout(r, 20))
    process.off('unhandledRejection', h)

    expect(seen).toEqual([])
    await session.dispose()
  })

  test('без сохранённого усилия процессу ничего не навязывается', async () => {
    const { session, driver } = makeSession({ steps: [] })

    await session.start()
    await vi.waitFor(() => expect(session.panel.context).not.toBeNull())

    expect(driver.effort).toBeNull()
    expect(session.panel.effort).toBeNull()
    await session.dispose()
  })

  test('после resume стоимость помечена «с момента открытия»', async () => {
    const { session } = makeSession({ steps: [] })

    await session.start('old-id')
    session.send({ text: 'продолжим', attachments: [] })
    await vi.waitFor(() => expect(session.panel.cost).not.toBeNull())

    expect(session.panel.cost).toEqual({ session: 0.0421, sinceOpen: true })
    await session.dispose()
  })

  test('новая сессия считает стоимость за всю сессию', async () => {
    const { session } = makeSession({ steps: [] })

    await session.start()
    session.send({ text: 'привет', attachments: [] })
    await vi.waitFor(() => expect(session.panel.cost).not.toBeNull())

    expect(session.panel.cost).toEqual({ session: 0.0421 })
    await session.dispose()
  })

  test('модель из истории видна, пока процесс не назвал свою', async () => {
    const seed = seedFromTranscript([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'было' }]
        }
      }
    ])
    const { session } = makeSession({ steps: [], contextUsageDelayMs: 300 }, { seed })

    // The session carries on from what the tab already shows.
    expect(session.items.filter((i) => i.kind === 'agentText')).toMatchObject([{ text: 'было' }])
    await session.start('old-id')
    expect(session.panel.model).toBe('claude-sonnet-5')

    // The process is the truth once it speaks.
    await vi.waitFor(() => expect(session.panel.model).toBe('claude-opus-5'))
    await session.dispose()
  })

  test('падающий запрос лимитов не роняет старт и не оставляет пустую панель', async () => {
    const { session, driver } = makeSession({ steps: [] })
    driver.planLimits = () => {
      throw new Error('нет такого метода')
    }
    const failures: unknown[] = []
    const onRejection = (reason: unknown): void => {
      failures.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      await session.start()
      await vi.waitFor(() => expect(session.panel.context?.percent).toBe(21))
      await new Promise(setImmediate)

      expect(session.status).toBe('idle')
      expect(session.panel.limits).toEqual({ fiveHour: null, sevenDay: null })
      expect(failures).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
      await session.dispose()
    }
  })
})

describe('AgentSession: живой статус MCP', () => {
  const initMessage = (servers: Array<{ name: string; status: string }>): unknown => ({
    type: 'system',
    subtype: 'init',
    session_id: 's-mcp',
    model: 'claude-opus-5',
    permissionMode: 'default',
    mcp_servers: servers
  })

  test('после init MCP спрашивается заново', async () => {
    const { session, driver } = makeSession({
      steps: [],
      init: { mcpServers: [{ name: 'unity', status: 'connected' }] }
    })
    const status = vi.spyOn(driver, 'mcpServerStatus')
    await session.start()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1))

    // init carries the state from the moment the CLI started: pending.
    session.handle(initMessage([{ name: 'unity', status: 'pending' }]))

    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(session.panel.mcp).toEqual([{ name: 'unity', status: 'connected' }]))
    await session.dispose()
  })

  test('на commands_changed и plugin_install MCP спрашивается заново', async () => {
    const { session, driver } = makeSession({
      steps: [],
      init: { mcpServers: [{ name: 'unity', status: 'connected' }] }
    })
    const status = vi.spyOn(driver, 'mcpServerStatus')
    await session.start()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1))

    session.handle({ type: 'system', subtype: 'commands_changed', commands: [] })
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2))
    session.handle({ type: 'system', subtype: 'plugin_install', status: 'completed' })
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3))
    await session.dispose()
  })

  test('сервер в pending опрашивается, пока не подключится', async () => {
    // Ruling C6: the fake answers the same thing every time, so the sequence
    // is stubbed here.
    const { session, driver } = makeSession({ steps: [] }, { mcpPollMs: 10 })
    const status = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'unity', status: 'pending' }])
      .mockResolvedValue([{ name: 'unity', status: 'connected' }])
    driver.mcpServerStatus = status
    const rec = watch(session)

    await session.start()

    await vi.waitFor(() => expect(session.panel.mcp).toEqual([{ name: 'unity', status: 'connected' }]))
    expect(rec.panels.some((p) => p.mcp?.[0]?.status === 'pending')).toBe(true)
    const calls = status.mock.calls.length
    expect(calls).toBe(2)
    // Connected: nothing more to wait for, so the polling stops.
    await new Promise((r) => setTimeout(r, 60))
    expect(status).toHaveBeenCalledTimes(calls)
    await session.dispose()
  })

  test('опрос ограничен MCP_POLL_MAX и гасится в dispose', async () => {
    const { session, driver } = makeSession({ steps: [] }, { mcpPollMs: 2 })
    const status = vi.fn().mockResolvedValue([{ name: 'unity', status: 'connecting' }])
    driver.mcpServerStatus = status

    await session.start()
    // The first ask plus at most MCP_POLL_MAX (15) repeats.
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(16), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 40))
    expect(status).toHaveBeenCalledTimes(16)
    await session.dispose()

    const { session: second, driver: secondDriver } = makeSession({ steps: [] }, { mcpPollMs: 20 })
    const secondStatus = vi.fn().mockResolvedValue([{ name: 'unity', status: 'pending' }])
    secondDriver.mcpServerStatus = secondStatus
    await second.start()
    await vi.waitFor(() => expect(secondStatus).toHaveBeenCalledTimes(1))
    await second.dispose()
    await new Promise((r) => setTimeout(r, 60))
    expect(secondStatus).toHaveBeenCalledTimes(1)
  })

  test('после исчерпания лимита новый init снова запускает опрос', async () => {
    const { session, driver } = makeSession({ steps: [] }, { mcpPollMs: 2 })
    const status = vi.fn().mockResolvedValue([{ name: 'srv', status: 'pending' }])
    driver.mcpServerStatus = status
    await session.start()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(16), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 40))
    expect(status).toHaveBeenCalledTimes(16)

    session.handle({ type: 'system', subtype: 'init', session_id: 's' })
    await vi.waitFor(() => expect(status.mock.calls.length).toBeGreaterThanOrEqual(18), { timeout: 2000 })
    await session.dispose()
  })

  test.each([
    ['commands_changed', { type: 'system', subtype: 'commands_changed', commands: [] }],
    ['plugin_install', { type: 'system', subtype: 'plugin_install', status: 'completed' }]
  ])('%s сбрасывает счётчик опроса', async (_name, message) => {
    const { session, driver } = makeSession({ steps: [] }, { mcpPollMs: 2 })
    const status = vi.fn().mockResolvedValue([{ name: 'srv', status: 'pending' }])
    driver.mcpServerStatus = status
    await session.start()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(16), { timeout: 2000 })
    await new Promise((r) => setTimeout(r, 40))
    expect(status).toHaveBeenCalledTimes(16)

    session.handle(message)
    await vi.waitFor(() => expect(status.mock.calls.length).toBeGreaterThanOrEqual(18), { timeout: 2000 })
    await session.dispose()
  })

  test('временный отказ mcpServerStatus не останавливает опрос и не стирает список', async () => {
    const { session, driver } = makeSession({ steps: [] }, { mcpPollMs: 10 })
    // What the panel showed when each ask was made: the third ask comes
    // right after the refusal.
    const seen: unknown[] = []
    const answers = [
      () => Promise.resolve([{ name: 'srv', status: 'pending' }]),
      () => Promise.reject(new Error('control request failed')),
      () => Promise.resolve([{ name: 'srv', status: 'connected' }])
    ]
    const status = vi.fn(() => {
      seen.push(session.panel.mcp)
      return (answers[Math.min(seen.length, 3) - 1] as () => Promise<Array<{ name: string; status: string }>>)()
    })
    driver.mcpServerStatus = status
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(session.panel.mcp).toEqual([{ name: 'srv', status: 'connected' }]))
    expect(status).toHaveBeenCalledTimes(3)
    expect(seen[2]).toEqual([{ name: 'srv', status: 'pending' }])
    expect(rec.panels.every((p) => p.mcp === undefined || p.mcp.length > 0)).toBe(true)
    await session.dispose()
  })

  test('патчи панели несут ревизию, снимок — последнюю', async () => {
    const { session } = makeSession({ steps: [] })
    const revs: number[] = []
    session.onPanel((_patch, rev) => revs.push(rev))
    await session.start()
    await vi.waitFor(() => expect(session.panel.context).not.toBeNull())
    await vi.waitFor(() => expect(session.panel.models).toHaveLength(2))

    expect(revs.length).toBeGreaterThan(1)
    for (let i = 1; i < revs.length; i++) expect(revs[i]).toBeGreaterThan(revs[i - 1]!)
    const snapshot = session.panelSnapshot()
    expect(snapshot.rev).toBe(revs[revs.length - 1])
    expect(snapshot.data).toEqual(session.panel)
    await session.dispose()
  })
})

describe('AgentSession: повторная отправка с вложением', () => {
  test('сообщение, посланное до init, уходит снова с упоминанием ровно один раз', async () => {
    const first = makeSession({ steps: [], nextTurn: [] })
    await first.session.start()
    first.session.send({
      text: 'посмотри',
      attachments: [{ kind: 'file', path: 'C:/Мои проекты/файл 1.ts' }]
    })

    const pending = first.session.sentBeforeInit
    expect(pending).toHaveLength(1)

    const second = makeSession({ steps: [], nextTurn: [] })
    await second.session.start()
    second.session.resend(pending[0]!)

    const mention = '@"C:/Мои проекты/файл 1.ts"'
    expect(second.driver.sent).toHaveLength(1)
    expect(second.driver.sent[0]!.text).toBe(`посмотри\n${mention}`)
    expect(second.driver.sent[0]!.text.split(mention)).toHaveLength(2)
  })
})

describe('AgentSession: ожидание вне хода', () => {
  /** A session whose canUseTool is called by hand, and whose gate answers when told. */
  function gated(): {
    session: AgentSession
    driver: ReturnType<typeof createFakeSdk>
    ask: (toolUseId: string) => Promise<{ behavior: string }>
    answer: () => void
  } {
    let canUseTool!: DriverOptions['canUseTool']
    let allow: (() => void) | null = null
    const driver = createFakeSdk({ steps: [], nextTurn: [] })
    const session = new AgentSession({
      tabId: 't1',
      cwd: 'C:/проект',
      overrides: {},
      agentPath: 'claude',
      resolveAgent: () => 'C:/bin/claude.exe',
      askPermission: (_request, signal) =>
        new Promise((resolve) => {
          allow = () => resolve({ behavior: 'allow' })
          signal.addEventListener('abort', () => resolve({ behavior: 'deny' }), { once: true })
        }),
      createDriver: (options) => {
        canUseTool = options.canUseTool
        return driver as unknown as AgentDriver
      }
    })
    return {
      session,
      driver,
      ask: (toolUseId) =>
        canUseTool('Bash', { command: 'ls' }, { toolUseId, signal: new AbortController().signal }),
      answer: () => allow?.()
    }
  }

  test('вопрос, открытый в простое, после ответа возвращает вкладку в простой', async () => {
    const { session, ask, answer } = gated()
    await session.start()
    expect(session.status).toBe('idle')

    // A background subagent asking after the turn's result: no turn runs.
    const asked = ask('после-хода')
    await vi.waitFor(() => expect(session.status).toBe('waiting'))
    answer()
    await asked

    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('вопрос, пришедший во время «Стоп», отклоняется и не держит вкладку в ожидании', async () => {
    const { session, driver, ask, answer } = gated()
    await session.start()
    session.send({ text: 'делай', attachments: [] })

    let interrupted!: () => void
    const original = driver.interrupt.bind(driver)
    driver.interrupt = async () => {
      await original()
      await new Promise<void>((resolve) => (interrupted = resolve))
      return undefined
    }
    const stopping = session.interrupt()
    await vi.waitFor(() => expect(interrupted).toBeDefined())
    const asked = ask('во-время-стопа')
    await vi.waitFor(() => expect(session.status).toBe('waiting'))
    interrupted()
    await stopping

    expect(session.status).toBe('idle')
    // Refused with the turn it belonged to, not left open behind an idle tab.
    await expect(asked).resolves.toMatchObject({ behavior: 'deny' })
    // And the count is clean: the next question still ends in idle.
    const next = ask('следующий')
    await vi.waitFor(() => expect(session.status).toBe('waiting'))
    answer()
    await next
    expect(session.status).toBe('idle')
    await session.dispose()
  })
})

describe('AgentSession: «Стоп» не трогает следующий ход', () => {
  test('сообщение, отправленное пока прерывание в пути, не теряет ход и свой вопрос', async () => {
    const { session, driver } = makeSession({
      steps: [],
      nextTurn: [
        { kind: 'askQuestion', question: 'Куда?', options: ['Справа', 'Снизу'] },
        { kind: 'text', text: 'понял' }
      ]
    })
    const rec = watch(session)
    await session.start()

    // The interrupt is on its way and not back yet.
    let interrupted!: () => void
    driver.interrupt = () => new Promise<undefined>((resolve) => (interrupted = () => resolve(undefined)))
    const stopping = session.interrupt()
    await vi.waitFor(() => expect(interrupted).toBeDefined())

    // The user does not wait for it: a new message, and the new turn asks.
    session.send({ text: 'дальше', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })

    interrupted()
    await stopping

    // The Stop was for the turn before: this turn and its question stay.
    expect(session.status).toBe('waiting')
    const card = rec.items.find((i) => i.kind === 'question') as { toolUseId: string }
    session.answerQuestion(card.toolUseId, { 'Куда?': 'Справа' })

    await vi.waitFor(() => expect(texts(rec.items)).toContain('понял'), { timeout: 2000 })
    await settle(session)
    // Answered in place, through updatedInput — not sent again as a message.
    expect(driver.questionAnswers).toEqual([{ 'Куда?': 'Справа' }])
    expect(driver.sent.map((s) => s.text)).toEqual(['дальше'])
    expect(session.status).toBe('idle')
    await session.dispose()
  })
})

describe('AgentSession: после dispose молчит', () => {
  test('поздний сбой и поздняя правка панели закрытой сессии никуда не уходят', async () => {
    const { session } = makeSession({ steps: [], nextTurn: [] })
    await session.start()
    await session.dispose()
    const rec = watch(session)

    // What a late callback of the closed session would do.
    ;(session as unknown as { fail: (err: unknown) => void }).fail(new Error('поздно'))
    await session.setPermissionMode('plan')

    expect(rec.statuses).toEqual([])
    expect(rec.changes).toEqual([])
    expect(rec.panels).toEqual([])
    expect(session.status).toBe('stopped')
  })
})

describe('AgentSession: очередь сообщений в CLI', () => {
  /** A turn long enough to type into. One step, so its one boundary is at its end. */
  const slowTurn: NonNullable<NonNullable<FakeScript>['nextTurn']> = [
    { kind: 'textStream', pieces: ['один ', 'два ', 'три ', 'четыре ', 'пять'], pauseMs: 50 }
  ]

  function lastQueue(rec: Recorder): PanelData['queue'] | undefined {
    return rec.panels.filter((p) => p.queue !== undefined).at(-1)?.queue
  }

  const bubbles = (items: RibbonItem[]): string[] =>
    items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)

  const lost = (items: RibbonItem[]): string[] =>
    items
      .filter((i) => i.kind === 'notice' && i.text.includes('не дошло'))
      .map((i) => (i as { text: string }).text)

  /** The CLI has said it keeps a queue (ruling R6): its frames, then init, have come. */
  async function cliReady(session: AgentSession): Promise<void> {
    await vi.waitFor(() => expect(session.sessionId).toBeTruthy(), { timeout: 2000 })
  }

  /** What each send carried besides the message: its uuid and priority. */
  function recordOptions(driver: ReturnType<typeof createFakeSdk>): Array<SendOptions | undefined> {
    const options: Array<SendOptions | undefined> = []
    const send = driver.send.bind(driver)
    driver.send = (input, opts) => {
      options.push(opts)
      send(input, opts)
    }
    return options
  }

  test('сообщение во время хода уходит в CLI сразу и вливается между шагами', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    const options = recordOptions(driver)
    const rec = watch(session)
    await session.start()

    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })

    // At the CLI already, not held until the result; no bubble until the agent reads it.
    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два'])
    expect(options[1]).toEqual({ uuid: expect.any(String) })
    expect(bubbles(rec.items)).toEqual(['раз'])
    const id = lastQueue(rec)![0]!.id
    expect(id).toBe(options[1]!.uuid)

    await vi.waitFor(() => expect(bubbles(rec.items)).toEqual(['раз', 'два']), { timeout: 3000 })
    expect(driver.folded).toEqual([id])
    expect(session.panel.queue).toEqual([])
    await settle(session)

    // Read between the steps of the same turn: after what the agent had written, once.
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    const order = rec.items.filter((i) => i.kind === 'user' || i.kind === 'agentText').map((i) => i.kind)
    expect(order).toEqual(['user', 'agentText', 'user'])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('плашка показывает sending, затем queued', async () => {
    const { session } = makeSession({ steps: [], turns: [slowTurn] })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [{ kind: 'file', path: 'C:/f.ts' }] })

    expect(lastQueue(rec)).toEqual([
      { id: expect.any(String), text: 'два', attachments: 1, state: 'sending', canSendNow: true }
    ])
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))
    expect(lastQueue(rec)?.[0]?.canSendNow).toBe(true)
    await settle(session)
    await session.dispose()
  })

  test('отправить сейчас: отмена и повтор с priority now и новым uuid', async () => {
    const { session, driver } = makeSession({
      steps: [],
      turns: [slowTurn, [{ kind: 'text', text: 'сразу' }]]
    })
    const options = recordOptions(driver)
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))
    const first = lastQueue(rec)![0]!.id

    expect(await session.sendQueuedNow('нет-такого')).toBe(false)
    expect(await session.sendQueuedNow(first)).toBe(true)

    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два', 'два'])
    const again = options.at(-1)!
    expect(again).toEqual({ uuid: expect.any(String), priority: 'now' })
    expect(again.uuid).not.toBe(first)
    // The strip keeps it, under its new uuid, until the agent reads it.
    expect(session.panel.queue.map((q) => q.id)).toEqual([again.uuid])

    await vi.waitFor(() => expect(texts(rec.items)).toContain('сразу'), { timeout: 3000 })
    await settle(session)
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    // The cancel was ours: no «не дошло».
    expect(lost(rec.items)).toEqual([])
    expect(session.panel.queue).toEqual([])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('отменить возвращает input, сообщение не доходит до агента', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({
      text: 'два',
      attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'QUJD', path: 'C:/ud/pastes/a.png' }]
    })
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))
    const id = lastQueue(rec)![0]!.id

    expect(await session.cancelQueued('нет-такого')).toBeNull()
    const cancelling = session.cancelQueued(id)
    expect(session.panel.queue).toEqual([expect.objectContaining({ state: 'cancelling', canSendNow: false })])
    // Back to the window without the bytes its copy on disk stands for.
    expect(await cancelling).toEqual({
      text: 'два',
      attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: '', path: 'C:/ud/pastes/a.png' }]
    })
    expect(session.panel.queue).toEqual([])

    await settle(session)
    await tick()
    expect(driver.folded).toEqual([])
    expect(bubbles(rec.items)).toEqual(['раз'])
    expect(lost(rec.items)).toEqual([])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('Стоп возвращает все из плашки, ни одно не доходит потом', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    session.send({ text: 'три', attachments: [] })

    expect(await session.interrupt()).toEqual([
      { text: 'два', attachments: [] },
      { text: 'три', attachments: [] }
    ])
    expect(session.panel.queue).toEqual([])

    // The stopped turn plays out to its result; nothing it held comes after.
    await vi.waitFor(() => expect(rec.panels.some((p) => p.cost)).toBe(true), { timeout: 3000 })
    await settle(session)
    await tick()
    expect(driver.folded).toEqual([])
    expect(bubbles(rec.items)).toEqual(['раз'])
    expect(lost(rec.items)).toEqual([])
    expect(session.panel.queue).toEqual([])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('сообщение во время открытой карточки разрешения ждёт и вливается после ответа, пузырь один', async () => {
    let answer!: (a: { behavior: 'allow' }) => void
    const holder: { session?: AgentSession } = {}
    const { session, driver } = makeSession(
      {
        steps: [],
        turns: [
          [
            { kind: 'askPermission', name: 'Bash', input: { command: 'ls' } },
            { kind: 'text', text: 'выполнил' }
          ]
        ]
      },
      {
        askPermission: (request) => {
          holder.session!.showPermissionCard(request.requestId, request.toolName, request.target)
          return new Promise((resolve) => (answer = resolve))
        }
      }
    )
    holder.session = session
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    await cliReady(session)

    session.send({ text: 'два', attachments: [] })
    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два'])
    // The card still waits on the user, and the tab says so.
    expect(session.status).toBe('waiting')
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))
    await tick()
    expect(bubbles(rec.items)).toEqual(['раз'])

    answer({ behavior: 'allow' })
    await vi.waitFor(() => expect(bubbles(rec.items)).toEqual(['раз', 'два']), { timeout: 2000 })
    await settle(session)
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    expect(driver.folded).toHaveLength(1)
    expect(driver.executedTools).toEqual(['Bash'])
    const order = rec.items.filter((i) => i.kind === 'user' || i.kind === 'permission').map((i) => i.kind)
    expect(order).toEqual(['user', 'permission', 'user'])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('старый CLI (lifecycle false): пузырь сразу, плашка пуста', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn], lifecycle: false })
    const options = recordOptions(driver)
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)

    session.send({ text: 'два', attachments: [] })
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два'])
    // Sent at once, with its uuid: the CLI folds it in by itself.
    expect(options[1]).toEqual({ uuid: expect.any(String) })
    expect(session.panel.queue).toEqual([])
    expect(rec.panels.filter((p) => (p.queue?.length ?? 0) > 0)).toEqual([])

    await settle(session)
    expect(driver.folded).toHaveLength(1)
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('смерть процесса: непринятые уходят в новую сессию один раз', async () => {
    // One step: the agent dies inside it, before any boundary could take «два» in.
    const dying = makeSession({
      steps: [],
      turns: [
        [
          {
            kind: 'subagent',
            name: 'долгий',
            steps: [
              { kind: 'textStream', pieces: ['а', 'б', 'в', 'г', 'д'], pauseMs: 50 },
              { kind: 'crash', message: 'агент умер' }
            ]
          }
        ]
      ]
    })
    const rec = watch(dying.session)
    await dying.session.start()
    dying.session.send({ text: 'раз', attachments: [] })
    await cliReady(dying.session)
    dying.session.send({ text: 'два', attachments: [] })
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))

    await vi.waitFor(() => expect(dying.session.status).toBe('error'), { timeout: 3000 })
    await tick()
    // The CLI had it and died with it: the agent never read it.
    expect(dying.driver.folded).toEqual([])
    expect(dying.session.panel.queue.map((q) => q.text)).toEqual(['два'])
    expect(dying.session.sentBeforeInit).toEqual([])
    const taken = dying.session.takeQueue()
    expect(taken).toEqual([{ text: 'два', attachments: [] }])
    expect(dying.session.takeQueue()).toEqual([])
    expect(dying.session.panel.queue).toEqual([])

    const next = makeSession(
      { steps: [], nextTurn: [{ kind: 'text', text: 'ответ' }] },
      { seed: dying.session.successorSeed() }
    )
    await next.session.start()
    next.session.requeue(taken)
    await vi.waitFor(() => expect(texts(next.session.items)).toContain('ответ'), { timeout: 2000 })
    await settle(next.session)
    expect(next.driver.sent.map((s) => s.text)).toEqual(['два'])
    expect(bubbles(next.session.items)).toEqual(['раз', 'два'])
    expect(next.session.panel.queue).toEqual([])
    await next.session.dispose()
  })

  test('cancelled с чужим uuid игнорируется', async () => {
    const long: NonNullable<NonNullable<FakeScript>['nextTurn']> = [
      { kind: 'textStream', pieces: Array.from({ length: 10 }, (_, i) => `${i} `), pauseMs: 60 }
    ]
    const { session } = makeSession({
      steps: [],
      turns: [long],
      phoneCancel: { afterMs: 120, uuid: 'с-телефона' }
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })

    // The phone's frame has come and gone; ours is still waiting, untouched.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(session.panel.queue.map((q) => q.text)).toEqual(['два'])
    expect(lost(rec.items)).toEqual([])
    expect(session.status).toBe('busy')

    await vi.waitFor(() => expect(bubbles(rec.items)).toEqual(['раз', 'два']), { timeout: 3000 })
    await settle(session)
    expect(lost(rec.items)).toEqual([])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('CLI сам снял сообщение с очереди — заметка «не дошло» с его текстом', async () => {
    const { session } = makeSession({ steps: [], turns: [slowTurn] })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    const id = session.panel.queue[0]!.id

    // A turn stopped elsewhere (the phone's «Стоп») drops what it held.
    session.handle({ type: 'command_lifecycle', command_uuid: id, state: 'cancelled', uuid: 'кадр', session_id: 'x' })
    expect(session.panel.queue).toEqual([])
    expect(lost(rec.items)).toEqual(['Сообщение не дошло до агента: ход прервали — «два»'])
    await settle(session)
    expect(bubbles(rec.items)).toEqual(['раз'])
    await session.dispose()
  })

  test('result с queued_turn_count > 0 не переводит вкладку в idle', async () => {
    const { session } = makeSession({
      steps: [],
      turns: [[{ kind: 'tool', name: 'Bash', input: { command: 'sleep 1' }, result: 'ok', pauseMs: 400 }]]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    expect(session.status).toBe('busy')

    const result = (queued: number): unknown => ({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session.sessionId,
      queued_turn_count: queued
    })
    // The CLI has another turn waiting behind this one: the tab is not free.
    session.handle(result(1))
    expect(session.status).toBe('busy')
    // A message still on the strip holds it too, whatever the count says.
    session.send({ text: 'два', attachments: [] })
    session.handle(result(0))
    expect(session.status).toBe('busy')
    expect(rec.statuses.slice(rec.statuses.indexOf('busy'))).toEqual(['busy'])

    await vi.waitFor(() => expect(bubbles(rec.items)).toEqual(['раз', 'два']), { timeout: 3000 })
    await settle(session)
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('result без кадров: что в user_message_uuids, то прочитано', async () => {
    // A CLI that keeps a queue but sent no frame for a message must not leave
    // it on the strip for ever.
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    const options = recordOptions(driver)
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    session.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session.sessionId,
      user_message_uuids: [options[0]!.uuid, options[1]!.uuid],
      queued_turn_count: 0
    })
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    expect(session.panel.queue).toEqual([])
    await settle(session)
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    await session.dispose()
  })

  test('отмена после result, задержанного очередью, отпускает вкладку', async () => {
    const { session } = makeSession({
      steps: [],
      turns: [[{ kind: 'tool', name: 'Bash', input: { command: 'sleep 1' }, result: 'ok', pauseMs: 300 }]]
    })
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    const id = session.panel.queue[0]!.id
    // The turn ended with «два» still in the CLI's queue, as its own next turn.
    session.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session.sessionId,
      queued_turn_count: 1
    })
    expect(session.status).toBe('busy')

    expect(await session.cancelQueued(id)).toEqual({ text: 'два', attachments: [] })
    // Nothing is left for the CLI to run.
    expect(session.status).toBe('idle')
    await settle(session)
    await session.dispose()
  })

  test('сообщение, отправленное пока Стоп в пути, уходит сразу и не возвращается', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })

    // A CLI without a receipt: «два» is taken back by itself.
    let interrupted!: () => void
    driver.interrupt = () => new Promise<undefined>((resolve) => (interrupted = () => resolve(undefined)))
    const stopping = session.interrupt()
    await vi.waitFor(() => expect(interrupted).toBeDefined())

    // Typed after Stop: meant to be sent, not pulled back too.
    session.send({ text: 'три', attachments: [] })
    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два', 'три'])
    expect(session.panel.queue.map((q) => q.text)).toEqual(['два'])

    interrupted()
    expect(await stopping).toEqual([{ text: 'два', attachments: [] }])
    expect(session.panel.queue).toEqual([])
    await session.dispose()
  })

  test('«Отправить сейчас» и сразу «Стоп»: сообщение возвращается и до агента не доходит', async () => {
    const { session, driver } = makeSession({
      steps: [],
      turns: [slowTurn, [{ kind: 'text', text: 'ответ-на-два' }]]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    session.send({ text: 'три', attachments: [] })
    await vi.waitFor(() => expect(lastQueue(rec)?.map((q) => q.state)).toEqual(['queued', 'queued']))
    const id = lastQueue(rec)![0]!.id

    // Both in the same round trip: nothing awaited in between.
    const now = session.sendQueuedNow(id)
    const stopping = session.interrupt()
    expect(await stopping).toEqual([
      { text: 'два', attachments: [] },
      { text: 'три', attachments: [] }
    ])
    // Stop won: the message is back in the input field, not sent again.
    expect(await now).toBe(false)
    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два', 'три'])
    expect(session.panel.queue).toEqual([])

    await vi.waitFor(() => expect(rec.panels.some((p) => p.cost)).toBe(true), { timeout: 3000 })
    await settle(session)
    await tick()
    expect(texts(rec.items)).not.toContain('ответ-на-два')
    expect(driver.folded).toEqual([])
    expect(bubbles(rec.items)).toEqual(['раз'])
    expect(lost(rec.items)).toEqual([])
    expect(session.panel.queue).toEqual([])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('«Стоп», пока ответ на «Отправить сейчас» в пути, а кадр cancelled уже снял его с плашки', async () => {
    const { session, driver } = makeSession({
      steps: [],
      turns: [slowTurn, [{ kind: 'text', text: 'ответ-на-два' }]]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))
    const id = lastQueue(rec)![0]!.id

    // The CLI takes it off at once, and says so; its answer comes later.
    const cancel = driver.cancelQueued.bind(driver)
    let answer!: () => void
    driver.cancelQueued = async (uuid) => {
      const taken = await cancel(uuid)
      await new Promise<void>((resolve) => (answer = resolve))
      return taken
    }
    const now = session.sendQueuedNow(id)
    await vi.waitFor(() => expect(session.panel.queue).toEqual([]))
    const stopping = session.interrupt()
    answer()
    expect(await stopping).toEqual([{ text: 'два', attachments: [] }])
    expect(await now).toBe(false)
    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два'])

    await vi.waitFor(() => expect(rec.panels.some((p) => p.cost)).toBe(true), { timeout: 3000 })
    await settle(session)
    await tick()
    expect(texts(rec.items)).not.toContain('ответ-на-два')
    expect(bubbles(rec.items)).toEqual(['раз'])
    expect(lost(rec.items)).toEqual([])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('двойной «Стоп» во время «Отправить сейчас» возвращает текст один раз', async () => {
    const { session, driver } = makeSession({
      steps: [],
      turns: [slowTurn, [{ kind: 'text', text: 'ответ-на-два' }]]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))
    const id = lastQueue(rec)![0]!.id

    // The CLI's answer to taking it back is held until told.
    const cancel = driver.cancelQueued.bind(driver)
    let answer: (() => void) | undefined
    driver.cancelQueued = async (uuid) => {
      const taken = await cancel(uuid)
      await new Promise<void>((resolve) => (answer = resolve))
      return taken
    }
    const now = session.sendQueuedNow(id)
    // Two «Стоп», nothing awaited in between.
    const first = session.interrupt()
    const second = session.interrupt()
    await vi.waitFor(() => expect(answer).toBeDefined())
    answer!()

    expect([...(await first), ...(await second)]).toEqual([{ text: 'два', attachments: [] }])
    expect(await now).toBe(false)
    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два'])

    await settle(session)
    await tick()
    expect(texts(rec.items)).not.toContain('ответ-на-два')
    expect(session.panel.queue).toEqual([])
    await session.dispose()
  })

  test('takeQueue во время «Отправить сейчас» после кадра cancelled забирает сообщение', async () => {
    const { session, driver } = makeSession({
      steps: [],
      turns: [slowTurn, [{ kind: 'text', text: 'ответ-на-два' }]]
    })
    const options = recordOptions(driver)
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))
    const id = lastQueue(rec)![0]!.id

    // The CLI takes it off at once, and says so; its answer comes later.
    const cancel = driver.cancelQueued.bind(driver)
    let answer: (() => void) | undefined
    driver.cancelQueued = async (uuid) => {
      const taken = await cancel(uuid)
      await new Promise<void>((resolve) => (answer = resolve))
      return taken
    }
    const now = session.sendQueuedNow(id)
    await vi.waitFor(() => expect(session.panel.queue).toEqual([]))
    await vi.waitFor(() => expect(answer).toBeDefined())

    // The tab is being swapped: the successor gets it, though it is off the strip.
    expect(session.takeQueue()).toEqual([{ text: 'два', attachments: [] }])
    answer!()
    expect(await now).toBe(false)
    const sentNow = driver.sent.filter((s, i) => s.text === 'два' && options[i]?.priority === 'now')
    expect(sentNow).toEqual([])
    await session.dispose()
  })

  test('поздний ответ отмены после dispose не ставит idle', async () => {
    const { session, driver } = makeSession({
      steps: [],
      turns: [[{ kind: 'tool', name: 'Bash', input: { command: 'sleep 1' }, result: 'ok', pauseMs: 300 }]]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    const id = session.panel.queue[0]!.id
    // The turn ended with «два» still in the CLI's queue, as its own next turn.
    session.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session.sessionId,
      queued_turn_count: 1
    })
    expect(session.status).toBe('busy')

    // The CLI answers «taken back» only after the tab has closed.
    let answer: (() => void) | undefined
    driver.cancelQueued = () => new Promise<boolean>((resolve) => (answer = () => resolve(true)))
    const cancelling = session.cancelQueued(id)
    await vi.waitFor(() => expect(answer).toBeDefined())
    await session.dispose()
    expect(rec.statuses.at(-1)).toBe('stopped')

    answer!()
    await cancelling
    await tick()
    expect(rec.statuses.at(-1)).toBe('stopped')
    expect(session.status).toBe('stopped')
  })

  test('Стоп на CLI, чья квитанция без cancelled: плашка снимается по одной и не выполняется', async () => {
    // interrupt_receipt_v1 without interrupt_cancel_queued_v1.
    const { session, driver } = makeSession({
      steps: [],
      turns: [slowTurn, [{ kind: 'text', text: 'ответ-на-два' }]],
      cancelQueuedOnInterrupt: false
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))

    expect(await session.interrupt()).toEqual([{ text: 'два', attachments: [] }])
    expect(session.panel.queue).toEqual([])

    await vi.waitFor(() => expect(rec.panels.some((p) => p.cost)).toBe(true), { timeout: 3000 })
    await settle(session)
    await tick()
    expect(texts(rec.items)).not.toContain('ответ-на-два')
    expect(driver.folded).toEqual([])
    expect(bubbles(rec.items)).toEqual(['раз'])
    expect(lost(rec.items)).toEqual([])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('Стоп, квитанция которого ещё числит сообщение в still_queued: снимается по одной', async () => {
    const { session, driver } = makeSession({
      steps: [],
      turns: [slowTurn, [{ kind: 'text', text: 'ответ-на-два' }]]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    await vi.waitFor(() => expect(lastQueue(rec)?.[0]?.state).toBe('queued'))

    // The CLI heard the interrupt but not the flag: «два» is still queued.
    const interrupt = driver.interrupt.bind(driver)
    driver.interrupt = () => interrupt()
    expect(await session.interrupt()).toEqual([{ text: 'два', attachments: [] }])
    expect(session.panel.queue).toEqual([])

    await vi.waitFor(() => expect(rec.panels.some((p) => p.cost)).toBe(true), { timeout: 3000 })
    await settle(session)
    await tick()
    expect(texts(rec.items)).not.toContain('ответ-на-два')
    expect(bubbles(rec.items)).toEqual(['раз'])
    expect(lost(rec.items)).toEqual([])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('сбой отмены и прерывания в драйвере — не исключение, а «не вышло»', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'два', attachments: [] })
    const id = session.panel.queue[0]!.id

    driver.cancelQueued = () => Promise.reject(new Error('сессия закрыта'))
    driver.interrupt = () => {
      throw new Error('сессия закрыта')
    }
    expect(await session.cancelQueued(id)).toBeNull()
    expect(session.panel.queue).toEqual([expect.objectContaining({ id, state: 'sending' })])
    // Not taken back: it is with the CLI already, and the turn is stopped for it.
    expect(await session.sendQueuedNow(id)).toBe(true)
    expect(await session.interrupt()).toEqual([])
    expect(session.panel.queue).toEqual([expect.objectContaining({ id })])
    await session.dispose()
  })

  test('ответ на вопрос карточкой во время хода тоже уходит в CLI и ждёт на плашке', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    const rec = watch(session)
    await session.start()
    // A card from history: nothing waits on it, so its answer goes as a message.
    session.handle({
      type: 'assistant',
      message: {
        id: 'old',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'q-old', name: 'AskUserQuestion', input: { questions: [{ question: 'Куда?', options: [] }] } }]
      }
    })
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.answerQuestion('q-old', { 'Куда?': 'Справа' })

    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'Справа'])
    expect(lastQueue(rec)?.map((q) => q.text)).toEqual(['Справа'])
    await vi.waitFor(() => expect(bubbles(rec.items)).toEqual(['раз', 'Справа']), { timeout: 3000 })
    await settle(session)
    await session.dispose()
  })

  test('requeue в свободную сессию отправляет всё сразу, у каждого один пузырь', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    const rec = watch(session)
    await session.start()
    session.requeue([
      { text: 'раз', attachments: [] },
      { text: 'два', attachments: [] }
    ])
    // Nothing is known yet of the CLI's queue (ruling R6): both go, and show, at once.
    expect(driver.sent.map((s) => s.text)).toEqual(['раз', 'два'])
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    expect(session.panel.queue).toEqual([])
    await settle(session)
    // Sent before the first turn began, «два» is a turn of its own: its echo is not a second bubble.
    expect(bubbles(rec.items)).toEqual(['раз', 'два'])
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('влитое в ход сообщение не съедает такое же с телефона после result', async () => {
    const { session, driver } = makeSession({ steps: [], turns: [slowTurn] })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await cliReady(session)
    session.send({ text: 'продолжай', attachments: [] })
    await vi.waitFor(() => expect(driver.folded).toHaveLength(1), { timeout: 3000 })
    await settle(session)
    expect(bubbles(rec.items)).toEqual(['раз', 'продолжай'])

    // Typed again, on the phone: a message of its own, not the echo of the folded one.
    session.handle(phoneEcho('продолжай'))
    expect(bubbles(rec.items)).toEqual(['раз', 'продолжай', 'продолжай'])
    await settle(session)
    await session.dispose()
  })

  test('ожидание эха у начавшего ход сообщения пропадает с его result', async () => {
    // CLI 2.1.317 echoes nothing, not even the message that starts a turn.
    let end!: () => void
    const ended = new Promise<void>((resolve) => (end = resolve))
    const uuids: Array<string | undefined> = []
    const driver = {
      messages: (async function* () {
        await ended
      })(),
      send: (_input: unknown, opts?: SendOptions) => uuids.push(opts?.uuid),
      cancelQueued: async () => null,
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedCommands: async () => [],
      mcpServerStatus: async () => [],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1, percentage: 0, categories: [] }),
      supportedModels: async () => [],
      setModel: async () => undefined,
      setEffort: async () => undefined,
      planLimits: async () => null,
      taskOutput: async () => null,
      stopTask: async () => undefined,
      remoteAvailability: async () => ({ available: true }),
      dispose: async () => end()
    } as unknown as AgentDriver
    const { session } = makeSession({}, { createDriver: () => driver })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'продолжай', attachments: [] })
    session.handle({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'тихая',
      user_message_uuids: [uuids[0]],
      queued_turn_count: 0
    })
    expect(session.status).toBe('idle')

    session.handle(phoneEcho('продолжай'))
    expect(bubbles(rec.items)).toEqual(['продолжай', 'продолжай'])
    await session.dispose()
  })
})

/** Lets queued background work (availability, bridge messages) land. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function until(check: () => boolean, timeout = 3000): Promise<void> {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout })
}

/** A message typed on the phone, the way the CLI echoes it into the stream. */
function phoneEcho(text: string): unknown {
  return {
    type: 'user',
    uuid: `phone-${text}`,
    session_id: 'fake',
    parent_tool_use_id: null,
    message: { role: 'user', content: text }
  }
}

describe('AgentSession: Remote Control', () => {
  test('включение: подключается → на связи со ссылкой, имя уходит в CLI', async () => {
    const { session, driver } = makeSession()
    const seen: RemoteInfo[] = []
    session.onRemote((i) => seen.push(i))
    await session.start()
    await session.setRemote(true, 'Qclod — проект')
    expect(seen.map((i) => i.state)).toEqual(['connecting', 'on'])
    expect(session.remote.url).toBe('https://claude.ai/code/session_fake0001')
    expect(driver.remoteCalls).toEqual([{ enabled: true, name: 'Qclod — проект' }])
    // The bridge's own «connected» right after changes nothing.
    await flush()
    expect(seen.map((i) => i.state)).toEqual(['connecting', 'on'])
    await session.dispose()
  })

  test('onRemote возвращает отписку', async () => {
    const { session } = makeSession()
    const seen: RemoteInfo[] = []
    const stop = session.onRemote((i) => seen.push(i))
    stop()
    await session.start()
    await session.setRemote(true)
    expect(seen).toEqual([])
    await session.dispose()
  })

  test('повторное включение во время подключения не шлёт второй запрос', async () => {
    const { session, driver } = makeSession()
    await session.start()
    await Promise.all([session.setRemote(true), session.setRemote(true)])
    expect(driver.remoteCalls).toHaveLength(1)
    expect(session.remote.state).toBe('on')
    // Already live: a third click asks nothing either.
    await session.setRemote(true)
    expect(driver.remoteCalls).toHaveLength(1)
    await session.dispose()
  })

  test('выключение и тут же включение из «нет связи» оставляют мост включённым', async () => {
    const { session, driver } = makeSession()
    await session.start()
    await session.setRemote(true)
    session.handle({
      type: 'system',
      subtype: 'bridge_state',
      state: 'failed',
      detail: null,
      failure_kind: 'terminal',
      bridge_epoch: 1,
      uuid: 'u',
      session_id: 's'
    } as never)
    expect(session.remote.state).toBe('failed')
    await Promise.all([session.setRemote(false), session.setRemote(true)])
    expect(driver.remoteCalls.map((c) => c.enabled)).toEqual([true, false, true])
    expect(session.remote.state).toBe('on')
    expect(session.remote.url).toBeTruthy()
    await session.dispose()
  })

  test('выключение и тут же включение из «на связи» заканчиваются включённым мостом', async () => {
    const { session, driver } = makeSession()
    await session.start()
    await session.setRemote(true)
    await Promise.all([session.setRemote(false), session.setRemote(true)])
    expect(driver.remoteCalls.map((c) => c.enabled)).toEqual([true, false, true])
    expect(session.remote.state).toBe('on')
    expect(session.remote.url).toBeTruthy()
    await session.dispose()
  })

  test('два включения за одним выключением шлют один запрос', async () => {
    const { session, driver } = makeSession()
    await session.start()
    await session.setRemote(true)
    await Promise.all([session.setRemote(false), session.setRemote(true), session.setRemote(true)])
    expect(driver.remoteCalls.map((c) => c.enabled)).toEqual([true, false, true])
    expect(session.remote.state).toBe('on')
    await session.dispose()
  })

  test('мост, ответивший раньше включения, не теряет ссылку', async () => {
    const { session, driver } = makeSession()
    await session.start()
    const real = driver.setRemoteControl.bind(driver)
    driver.setRemoteControl = async (enabled: boolean, name?: string) => {
      const link = await real(enabled, name)
      session.handle({ type: 'system', subtype: 'bridge_state', state: 'connected' })
      return link
    }
    await session.setRemote(true)
    expect(session.remote).toEqual({ state: 'on', url: 'https://claude.ai/code/session_fake0001' })
    await session.dispose()
  })

  test('выключение во время подключения выполняется после ответа на включение', async () => {
    const { session, driver } = makeSession()
    await session.start()
    const enabling = session.setRemote(true)
    expect(session.remote.state).toBe('connecting')
    await session.setRemote(false)
    await enabling
    expect(driver.remoteCalls).toEqual([{ enabled: true }, { enabled: false }])
    expect(session.remote).toEqual({ state: 'off' })
    await flush()
    expect(session.remote).toEqual({ state: 'off' })
    await session.dispose()
  })

  test('выключение во время неудачного подключения ничего не выключает', async () => {
    const { session, driver } = makeSession({ remoteControl: { enableError: 'boom' } })
    await session.start()
    const enabling = session.setRemote(true)
    await session.setRemote(false)
    await enabling
    expect(driver.remoteCalls).toEqual([{ enabled: true }])
    expect(session.remote.state).toBe('off')
    await session.dispose()
  })

  test('выключение: off и worker_shutting_down не включает обратно', async () => {
    const { session, driver } = makeSession()
    const seen: RemoteInfo[] = []
    session.onRemote((i) => seen.push(i))
    await session.start()
    await session.setRemote(true)
    await session.setRemote(false)
    expect(session.remote).toEqual({ state: 'off' })
    expect(driver.remoteCalls[1]).toEqual({ enabled: false })
    await flush()
    expect(session.remote).toEqual({ state: 'off' })
    expect(seen.map((i) => i.state)).toEqual(['connecting', 'on', 'off'])
    // Off stays off: a second «выключить» asks the CLI nothing.
    await session.setRemote(false)
    expect(driver.remoteCalls).toHaveLength(2)
    await session.dispose()
  })

  test('ошибка выключения — состояние прежнее, причина в problem', async () => {
    const { session, driver } = makeSession()
    await session.start()
    await session.setRemote(true)
    // The bridge's «connected» lands first; a later bridge state would clear the problem.
    await flush()
    const real = driver.setRemoteControl.bind(driver)
    driver.setRemoteControl = async (enabled: boolean, name?: string) => {
      if (!enabled) throw new Error('нет ответа')
      return real(enabled, name)
    }
    await session.setRemote(false)
    expect(session.remote).toEqual({
      state: 'on',
      url: 'https://claude.ai/code/session_fake0001',
      problem: 'Не удалось выключить Remote Control: нет ответа'
    })
    driver.setRemoteControl = real
    await session.dispose()
  })

  test('API-ключ: кнопка заблокирована, CLI не зовётся', async () => {
    const { session, driver } = makeSession({ remoteControl: { blocked: 'api_key' } })
    await session.start()
    await flush()
    expect(session.remote).toEqual({ state: 'off', blocked: 'api_key' })
    await session.setRemote(true)
    expect(driver.remoteCalls).toEqual([])
    await session.dispose()
  })

  test('проверка доступности, которая падает, не роняет сессию', async () => {
    const { session, driver } = makeSession()
    driver.remoteAvailability = async () => {
      throw new Error('нет')
    }
    await session.start()
    await flush()
    expect(session.remote).toEqual({ state: 'off' })
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('без драйвера включение ничего не делает', async () => {
    const { session, driver } = makeSession()
    await session.setRemote(true)
    expect(driver.remoteCalls).toEqual([])
    expect(session.remote).toEqual({ state: 'off' })
  })

  test('ошибка включения — причина в состоянии и заметка в ленте', async () => {
    const { session } = makeSession({
      remoteControl: { enableError: 'Remote Control requires a claude.ai subscription' }
    })
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    expect(session.remote).toMatchObject({ state: 'off', problem: REMOTE_BLOCK_TEXT.api_key })
    expect(rec.items.some((i) => i.kind === 'notice' && i.text === REMOTE_BLOCK_TEXT.api_key)).toBe(true)
    await session.dispose()
  })

  test('мост упал — нет связи и заметка', async () => {
    const { session } = makeSession({
      remoteControl: { bridge: [{ state: 'connected' }, { state: 'failed', detail: 'таймаут', afterMs: 10 }] }
    })
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    await until(() => session.remote.state === 'failed')
    expect(session.remote.problem).toBe('Связь с claude.ai потеряна. таймаут')
    expect(
      rec.items.some((i) => i.kind === 'notice' && i.text === 'Связь с claude.ai потеряна. таймаут')
    ).toBe(true)
    // The button can turn it on again.
    await session.setRemote(true)
    expect(session.remote.state).toBe('on')
    await session.dispose()
  })

  test('сообщение с телефона — пузырь с пометкой, вкладка работает, затем простаивает', async () => {
    const { session, driver } = makeSession()
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    driver.typeOnPhone('с телефона', [{ kind: 'text', text: 'ответ' }])
    await until(() => rec.statuses.includes('busy') && session.status === 'idle')
    expect(rec.items.find((i) => i.kind === 'user')).toMatchObject({ text: 'с телефона', remote: true })
    expect(texts(rec.items)).toContain('ответ')
    await session.dispose()
  })

  test('сообщение с телефона во время хода не открывает второй ход', async () => {
    const { session } = makeSession({
      nextTurn: [
        { kind: 'thinking', text: 'думаю', ms: 200 },
        { kind: 'text', text: 'готово' }
      ]
    })
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    session.send({ text: 'из Qclod', attachments: [] })
    // The fake plays a phone turn only between turns, so the CLI's echo of
    // one typed mid-turn is fed in directly.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(session.status).toBe('busy')
    session.handle(phoneEcho('с телефона'))
    expect(rec.items.find((i) => i.kind === 'user' && i.text === 'с телефона')).toMatchObject({ remote: true })
    expect(session.status).toBe('busy')
    await until(() => session.status === 'idle')
    // One «работает» from the first send to the very end, never twice.
    expect(rec.statuses.filter((s) => s === 'busy')).toHaveLength(1)
    await session.dispose()
  })

  test('сообщение с телефона во время хода не мешает «Стоп» отменить вопрос', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker } = makeBrokerFor(sessions)
    const { session } = brokeredSession(broker, sessions, {
      nextTurn: [{ kind: 'askPermission', name: 'Bash', input: { command: 'ls' } }]
    })
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    session.send({ text: 'запусти', attachments: [] })
    await until(() => session.status === 'waiting')
    session.handle(phoneEcho('с телефона'))
    expect(session.status).toBe('waiting')
    await session.interrupt()
    expect(session.status).toBe('idle')
    expect(rec.items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'denied' })
    await session.dispose()
  })

  test('разрешение, отвеченное с телефона, закрывается как elsewhere', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker } = makeBrokerFor(sessions)
    const { session } = brokeredSession(broker, sessions, {
      nextTurn: [{ kind: 'remoteAnswer', name: 'Bash', input: { command: 'ls' }, decision: 'allow' }]
    })
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    session.send({ text: 'запусти', attachments: [] })
    await settle(session)
    expect(rec.items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'elsewhere' })
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('поздний ответ из Qclod после ответа с телефона игнорируется', async () => {
    const sessions = new Map<string, AgentSession>()
    const saveRules = vi.fn()
    const asked: PermissionRequest[] = []
    const broker = new PermissionBroker({
      loadRules: () => [],
      saveRules,
      ask: (request) => {
        asked.push(request)
        sessions.get(request.tabId)?.showPermissionCard(request.requestId, request.toolName, request.target)
      }
    })
    const { session, driver } = brokeredSession(broker, sessions, {
      nextTurn: [{ kind: 'remoteAnswer', name: 'Bash', input: { command: 'rm -rf x' }, decision: 'deny' }]
    })
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    session.send({ text: 'запусти', attachments: [] })
    await settle(session)

    broker.answer(asked[0]!.requestId, { behavior: 'allow', remember: true })
    await tick()

    expect(saveRules).not.toHaveBeenCalled()
    expect(driver.executedTools).not.toContain('Bash')
    expect(rec.items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'elsewhere' })
    expect(session.status).toBe('idle')
    await session.dispose()
  })

  test('ответ из Qclod, пришедший после аборта, не меняет карточку elsewhere', async () => {
    const holder: { session?: AgentSession } = {}
    const { session } = makeSession(
      { nextTurn: [{ kind: 'remoteAnswer', name: 'Bash', input: { command: 'ls' }, decision: 'allow' }] },
      {
        askPermission: (r, signal) => {
          holder.session?.showPermissionCard(r.requestId, r.toolName, r.target)
          return new Promise((resolve) =>
            signal.addEventListener('abort', () => setTimeout(() => resolve({ behavior: 'allow' }), 100))
          )
        }
      }
    )
    holder.session = session
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    session.send({ text: 'запусти', attachments: [] })
    await until(() => rec.items.find((i) => i.kind === 'permission')?.state === 'elsewhere')
    await settle(session)
    expect(rec.items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'elsewhere' })
    await session.dispose()
  })

  test('без моста аборт SDK — по-прежнему denied', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker } = makeBrokerFor(sessions)
    const { session } = brokeredSession(broker, sessions, {
      nextTurn: [{ kind: 'remoteAnswer', name: 'Bash', input: { command: 'ls' }, decision: 'deny' }]
    })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'запусти', attachments: [] })
    await settle(session)
    expect(rec.items.find((i) => i.kind === 'permission')).toMatchObject({ state: 'denied' })
    await session.dispose()
  })

  test('план, решённый с телефона, закрывается как elsewhere', async () => {
    const { session } = makeSession(
      {
        init: { permissionMode: 'plan' },
        nextTurn: [
          { kind: 'remoteAnswer', name: 'ExitPlanMode', input: { plan: 'сделать всё' }, decision: 'deny' }
        ]
      },
      { overrides: { permissionMode: 'plan' } }
    )
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    session.send({ text: 'спланируй', attachments: [] })
    await settle(session)
    expect(rec.items.find((i) => i.kind === 'plan')).toMatchObject({ state: 'elsewhere' })
    await session.dispose()
  })

  test('вопрос, отвеченный с телефона, закрывается как elsewhere', async () => {
    const { session } = makeSession({
      nextTurn: [
        {
          kind: 'remoteAnswer',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Куда?', options: [{ label: 'туда' }] }] },
          decision: 'deny'
        }
      ]
    })
    const rec = watch(session)
    await session.start()
    await session.setRemote(true)
    session.send({ text: 'спроси', attachments: [] })
    await settle(session)
    expect(rec.items.find((i) => i.kind === 'question')).toMatchObject({ answers: {}, elsewhere: true })
    await session.dispose()
  })

  test('падение агента гасит мост', async () => {
    const { session } = makeSession({ nextTurn: [{ kind: 'crash', message: 'агент умер' }] })
    const seen: RemoteInfo[] = []
    session.onRemote((i) => seen.push(i))
    await session.start()
    await session.setRemote(true)
    session.send({ text: 'раз', attachments: [] })
    await until(() => session.status === 'error')
    expect(session.remote).toEqual({ state: 'off' })
    expect(seen.at(-1)).toEqual({ state: 'off' })
  })

  test('закрытие вкладки с живым мостом сначала выключает его', async () => {
    const { session, driver } = makeSession()
    const order: number[] = []
    const realDispose = driver.dispose.bind(driver)
    driver.dispose = async () => {
      order.push(driver.remoteCalls.length)
      return realDispose()
    }
    await session.start()
    await session.setRemote(true)
    await session.dispose()
    expect(driver.remoteCalls.at(-1)).toEqual({ enabled: false })
    // The bridge was off before the driver was closed.
    expect(order).toEqual([2])
  })

  test('выключение моста, которое не отвечает, не держит закрытие дольше секунды', async () => {
    const { session, driver } = makeSession()
    await session.start()
    await session.setRemote(true)
    driver.setRemoteControl = () => new Promise(() => undefined)
    const started = Date.now()
    await session.dispose()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(session.status).toBe('stopped')
  })

  test('закрытие вкладки без моста ничего не выключает', async () => {
    const { session, driver } = makeSession()
    await session.start()
    await session.dispose()
    expect(driver.remoteCalls).toEqual([])
  })
})

describe('AgentSession: итоговое ревью этапа 2', () => {
  const slow: NonNullable<NonNullable<FakeScript>['nextTurn']> = [
    { kind: 'textStream', pieces: ['один ', 'два ', 'три ', 'четыре ', 'пять'], pauseMs: 50 }
  ]

  test('сообщение во время запуска ждёт в очереди и уходит, когда агент поднялся', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const driver = createFakeSdk({ steps: [] })
    const slowStart = makeSession(
      { steps: [] },
      {
        createDriver: async () => {
          await gate
          return driver as unknown as AgentDriver
        }
      }
    ).session
    const starting = slowStart.start()
    await vi.waitFor(() => expect(slowStart.status).toBe('starting'))

    const options: Array<{ uuid?: string } | undefined> = []
    const send = driver.send.bind(driver)
    driver.send = (input, opts) => {
      options.push(opts)
      send(input, opts)
    }

    expect(slowStart.send({ text: 'пока запускается', attachments: [] })).toBe(true)
    expect(slowStart.send({ text: 'и это', attachments: [] })).toBe(true)
    expect(driver.sent).toHaveLength(0)
    expect(slowStart.panel.queue).toEqual([
      { id: expect.any(String), text: 'пока запускается', attachments: 0, state: 'waiting', canSendNow: false },
      { id: expect.any(String), text: 'и это', attachments: 0, state: 'waiting', canSendNow: false }
    ])
    const ids = slowStart.panel.queue.map((q) => q.id)

    release()
    await starting
    // All of it at once, in order, each under the uuid it was given on the strip.
    expect(driver.sent.map((s) => s.text)).toEqual(['пока запускается', 'и это'])
    expect(options.map((o) => o?.uuid)).toEqual(ids)
    expect(slowStart.panel.queue).toEqual([])
    await slowStart.whenIdle()
    await slowStart.dispose()
  })

  test('незапущенная и упавшая сессия не принимают сообщение и говорят об этом', async () => {
    const fresh = makeSession({ steps: [] }).session
    expect(fresh.send({ text: 'никуда', attachments: [] })).toBe(false)

    const { session } = makeSession({ steps: [{ kind: 'crash', message: 'агент умер' }] })
    await session.start()
    await settle(session)
    expect(session.status).toBe('error')
    expect(session.send({ text: 'никуда', attachments: [] })).toBe(false)
  })

  test('очередь не растёт больше 20 сообщений', async () => {
    const { session } = makeSession({ steps: [], turns: [slow] })
    await session.start()
    expect(session.send({ text: 'первое', attachments: [] })).toBe(true)
    // The strip is there once the CLI has said it keeps a queue.
    await vi.waitFor(() => expect(session.sessionId).toBeTruthy())
    for (let i = 0; i < 20; i++) expect(session.send({ text: `в очередь ${i}`, attachments: [] })).toBe(true)
    expect(session.send({ text: 'лишнее', attachments: [] })).toBe(false)
    expect(session.panel.queue).toHaveLength(20)
    await session.interrupt()
    await session.dispose()
  })

  test('Стоп возвращает картинку с копией на диске без её байт', async () => {
    const { session } = makeSession({ steps: [], turns: [slow] })
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await vi.waitFor(() => expect(session.sessionId).toBeTruthy())
    session.send({
      text: 'два',
      attachments: [
        { kind: 'image', mediaType: 'image/png', dataBase64: 'QUJD', path: 'C:/ud/pastes/a.png', thumbnail: 'data:x' },
        { kind: 'image', mediaType: 'image/png', dataBase64: 'REVG' }
      ]
    })

    expect(await session.interrupt()).toEqual([
      {
        text: 'два',
        attachments: [
          { kind: 'image', mediaType: 'image/png', dataBase64: '', path: 'C:/ud/pastes/a.png', thumbnail: 'data:x' },
          { kind: 'image', mediaType: 'image/png', dataBase64: 'REVG' }
        ]
      }
    ])
    await session.dispose()
  })

  test('поток, кончившийся сам, — сессия мертва: драйвер брошен, ход окончен, вопросы закрыты', async () => {
    let end!: () => void
    const ended = new Promise<void>((resolve) => (end = resolve))
    const sent: unknown[] = []
    const driver = {
      messages: (async function* () {
        await ended
      })(),
      send: (input: unknown) => sent.push(input),
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedCommands: async () => [],
      mcpServerStatus: async () => [],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1, percentage: 0, categories: [] }),
      supportedModels: async () => [],
      setModel: async () => undefined,
      setEffort: async () => undefined,
      planLimits: async () => null,
      taskOutput: async () => null,
      stopTask: async () => undefined,
      dispose: async () => undefined
    } as unknown as AgentDriver
    const { session } = makeSession({}, { createDriver: () => driver })
    await session.start()
    expect(session.send({ text: 'раз', attachments: [] })).toBe(true)
    expect(session.status).toBe('busy')

    end()
    await vi.waitFor(() => expect(session.status).toBe('error'))
    expect(session.send({ text: 'два', attachments: [] })).toBe(false)
    expect(sent).toHaveLength(1)
    await session.dispose()
  })
})

describe('AgentSession: ответы на карточки', () => {
  function planSession(plan: string, script: FakeScript = {}): ReturnType<typeof makeSession> {
    return makeSession(
      { ...script, init: { permissionMode: 'plan', ...script.init }, steps: [{ kind: 'plan', plan }] },
      { overrides: { permissionMode: 'plan' } }
    )
  }

  async function openPlan(session: AgentSession, rec: Recorder): Promise<{ requestId: string }> {
    await session.start()
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    return rec.items.find((i) => i.kind === 'plan') as { requestId: string }
  }

  test('отклонить план с комментарием', async () => {
    const { session, driver } = planSession('1. всё переписать')
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: false, comment: 'сначала тесты' })
    await settle(session)

    expect(driver.permissionLog.at(-1)).toEqual({
      name: 'ExitPlanMode',
      behavior: 'deny',
      message: 'сначала тесты'
    })
    const item = rec.items.find((i) => i.kind === 'plan')
    expect(item).toMatchObject({
      state: 'rejected',
      comment: 'сначала тесты',
      text: '1. всё переписать'
    })
    // Refused, not sent back for rework.
    expect(item).not.toHaveProperty('sentBack')
    expect(session.panel.permissionMode).toBe('plan')
  })

  test('отклонить план без комментария — отказ без своего текста', async () => {
    const { session, driver } = planSession('1. шаг')
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: false })
    await settle(session)

    expect(driver.permissionLog.at(-1)).toEqual({ name: 'ExitPlanMode', behavior: 'deny' })
    expect(rec.items.find((i) => i.kind === 'plan')).not.toHaveProperty('comment')
  })

  test('одобрить с правкой', async () => {
    const { session, driver } = planSession('1. всё переписать')
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: true, plan: '1. поправить одну функцию' })
    await settle(session)

    const answer = driver.permissionLog.at(-1)!
    expect(answer.behavior).toBe('allow')
    expect(answer.updatedInput).toEqual({ plan: '1. поправить одну функцию' })
    expect(rec.items.find((i) => i.kind === 'plan')).toMatchObject({
      state: 'approved',
      text: '1. поправить одну функцию',
      edited: true
    })
    expect(rec.changes).toContainEqual(
      expect.objectContaining({
        kind: 'update',
        patch: { state: 'approved', text: '1. поправить одну функцию', edited: true }
      })
    )
    expect(session.panel.permissionMode).toBe('acceptEdits')
    expect(driver.permissionMode).toBe('acceptEdits')
    // The edit went with the tool's answer, not as a message.
    expect(driver.sent).toEqual([])
  })

  test('пустая правка — обычное одобрение', async () => {
    for (const edit of ['   ', '1. шаг']) {
      const { session, driver } = planSession('1. шаг')
      const rec = watch(session)
      const plan = await openPlan(session, rec)

      await session.answerPlan(plan.requestId, { approve: true, plan: edit })
      await settle(session)

      expect(driver.permissionLog.at(-1)).toEqual({ name: 'ExitPlanMode', behavior: 'allow' })
      const item = rec.items.find((i) => i.kind === 'plan')
      expect(item).toMatchObject({ state: 'approved', text: '1. шаг' })
      expect(item).not.toHaveProperty('edited')
      expect(session.panel.permissionMode).toBe('acceptEdits')
      expect(driver.sent).toEqual([])
    }
  })

  // S2-R8.2: on a CLI that carries updatedInput.plan, the comment goes under the plan.
  test('новый CLI: комментарий одобрения — под планом в updatedInput.plan, без сообщения', async () => {
    const { session, driver } = planSession('1. шаг')
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: true, comment: 'и потом прогони тесты' })
    await settle(session)

    expect(driver.permissionLog.at(-1)).toEqual({
      name: 'ExitPlanMode',
      behavior: 'allow',
      updatedInput: { plan: '1. шаг\n\nКомментарий пользователя: и потом прогони тесты' }
    })
    const item = rec.items.find((i) => i.kind === 'plan')
    expect(item).toMatchObject({ state: 'approved', text: '1. шаг', comment: 'и потом прогони тесты' })
    expect(item).not.toHaveProperty('edited')
    expect(session.panel.permissionMode).toBe('acceptEdits')
    expect(driver.sent).toEqual([])
  })

  test('новый CLI: правка и комментарий — правленый план с комментарием под ним', async () => {
    const { session, driver } = planSession('1. всё переписать')
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, {
      approve: true,
      plan: '1. поправить одну функцию',
      comment: 'без миграций'
    })
    await settle(session)

    expect(driver.permissionLog.at(-1)!.updatedInput).toEqual({
      plan: '1. поправить одну функцию\n\nКомментарий пользователя: без миграций'
    })
    // The card shows the plan as edited; the comment stands beside it.
    expect(rec.items.find((i) => i.kind === 'plan')).toMatchObject({
      state: 'approved',
      text: '1. поправить одну функцию',
      edited: true,
      comment: 'без миграций'
    })
    expect(driver.sent).toEqual([])
  })

  // S2-R8.1: an older CLI gets the plan sent back, and plan mode stays.
  const OLD_CLI: FakeScript = { init: { claudeCodeVersion: '2.1.300' } }

  test('старый CLI: правка плана — ExitPlanMode отклонён с правкой, режим остаётся «план»', async () => {
    const { session, driver } = planSession('1. всё переписать', OLD_CLI)
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: true, plan: '1. поправить одну функцию' })
    await settle(session)

    expect(driver.permissionLog.at(-1)).toEqual({
      name: 'ExitPlanMode',
      behavior: 'deny',
      message:
        'Пользователь поправил план. Не начинай работу — предложи этот вариант снова через ExitPlanMode:\n' +
        '1. поправить одну функцию'
    })
    expect(driver.executedTools).not.toContain('ExitPlanMode')
    expect(rec.items.find((i) => i.kind === 'plan')).toMatchObject({
      state: 'rejected',
      text: '1. поправить одну функцию',
      edited: true,
      sentBack: true
    })
    expect(session.panel.permissionMode).toBe('plan')
    expect(driver.permissionMode).toBe('plan')
    expect(driver.sent).toEqual([])
  })

  test('старый CLI: правка и комментарий — оба в отказе', async () => {
    const { session, driver } = planSession('1. всё переписать', OLD_CLI)
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, {
      approve: true,
      plan: '1. поправить одну функцию',
      comment: 'без миграций'
    })
    await settle(session)

    expect(driver.permissionLog.at(-1)).toEqual({
      name: 'ExitPlanMode',
      behavior: 'deny',
      message:
        'Пользователь поправил план. Не начинай работу — предложи этот вариант снова через ExitPlanMode:\n' +
        '1. поправить одну функцию\n\nКомментарий пользователя: без миграций'
    })
    expect(rec.items.find((i) => i.kind === 'plan')).toMatchObject({
      state: 'rejected',
      text: '1. поправить одну функцию',
      edited: true,
      comment: 'без миграций',
      sentBack: true
    })
    expect(session.panel.permissionMode).toBe('plan')
    expect(driver.sent).toEqual([])
  })

  test('старый CLI: комментарий без правки — план отправлен на доработку с комментарием', async () => {
    const { session, driver } = planSession('1. шаг', OLD_CLI)
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: true, comment: 'и потом прогони тесты' })
    await settle(session)

    expect(driver.permissionLog.at(-1)).toEqual({
      name: 'ExitPlanMode',
      behavior: 'deny',
      message:
        'Пользователь одобрит план с учётом комментария. Не начинай работу — учти комментарий и предложи ' +
        'план снова через ExitPlanMode.\n\nКомментарий: и потом прогони тесты'
    })
    const item = rec.items.find((i) => i.kind === 'plan')
    // Sent back, not refused: the ribbon says so, though the agent reads a refusal.
    expect(item).toMatchObject({ state: 'rejected', text: '1. шаг', comment: 'и потом прогони тесты', sentBack: true })
    expect(item).not.toHaveProperty('edited')
    expect(session.panel.permissionMode).toBe('plan')
    expect(driver.sent).toEqual([])
  })

  test('старый CLI: одобрение без правки и комментария — обычное одобрение', async () => {
    const { session, driver } = planSession('1. шаг', OLD_CLI)
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: true, plan: '1. шаг' })
    await settle(session)

    expect(driver.permissionLog.at(-1)).toEqual({ name: 'ExitPlanMode', behavior: 'allow' })
    expect(rec.items.find((i) => i.kind === 'plan')).toMatchObject({ state: 'approved', text: '1. шаг' })
    expect(rec.items.find((i) => i.kind === 'plan')).not.toHaveProperty('sentBack')
    expect(session.panel.permissionMode).toBe('acceptEdits')
  })

  test('старый CLI: отклонение с комментарием — отказ, а не доработка', async () => {
    const { session, driver } = planSession('1. шаг', OLD_CLI)
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: false, comment: 'сначала тесты' })
    await settle(session)

    expect(driver.permissionLog.at(-1)).toEqual({ name: 'ExitPlanMode', behavior: 'deny', message: 'сначала тесты' })
    const item = rec.items.find((i) => i.kind === 'plan')
    expect(item).toMatchObject({ state: 'rejected', comment: 'сначала тесты' })
    expect(item).not.toHaveProperty('sentBack')
  })

  // S2-R8.3: nothing of a plan answer goes as a message, so a full queue loses nothing.
  test.each([
    ['2.1.317', 'allow'],
    ['2.1.300', 'deny']
  ])('CLI %s: правка и комментарий не уходят сообщением — очереди нечего терять', async (version, behavior) => {
    const { session, driver } = planSession('1. шаг', { init: { claudeCodeVersion: version } })
    const rec = watch(session)
    const plan = await openPlan(session, rec)

    await session.answerPlan(plan.requestId, { approve: true, plan: '1. другой шаг', comment: 'коротко' })
    await settle(session)

    expect(driver.permissionLog.at(-1)!.behavior).toBe(behavior)
    expect(driver.sent).toEqual([])
    expect(session.panel.queue).toEqual([])
    expect(rec.items.filter((i) => i.kind === 'notice')).toEqual([])
    // Whatever reached the agent carries the edit and the comment.
    const carried = JSON.stringify(driver.permissionLog.at(-1))
    expect(carried).toContain('1. другой шаг')
    expect(carried).toContain('коротко')
  })

  // S2-R8.4: a closed session asks nobody, so no «до конца сессии» rule can outlive it.
  test.each(['2.1.317', '2.1.300'])('CLI %s: закрытая сессия отказывает сразу и никого не спрашивает', async (version) => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const { session } = brokeredSession(
      broker,
      sessions,
      { init: { claudeCodeVersion: version }, steps: [{ kind: 'text', text: 'ок' }] },
      { overrides: { permissionMode: 'plan' } }
    )
    const rec = watch(session)
    await session.start()
    await settle(session)
    await session.dispose()
    const before = rec.items.length

    const late = (session as unknown as {
      onToolPermission: (n: string, i: Record<string, unknown>, o: object) => Promise<{ behavior: string }>
    }).onToolPermission.bind(session)
    await expect(late('Bash', { command: 'npm test' }, { toolUseId: 'late-1' })).resolves.toEqual({ behavior: 'deny' })
    await expect(late('ExitPlanMode', { plan: 'x' }, { toolUseId: 'late-2' })).resolves.toEqual({ behavior: 'deny' })
    await expect(
      late('AskUserQuestion', { questions: [{ question: 'Q', options: [{ label: 'A' }] }] }, { toolUseId: 'late-3' })
    ).resolves.toEqual({ behavior: 'deny' })

    expect(asked).toEqual([])
    expect(rec.items).toHaveLength(before)
    // A click meant for a card that never was saves nothing for the tab.
    broker.answer('late-1', { behavior: 'allow', forSession: true })
    void broker.request('t1', 'Bash', { command: 'npm test' })
    expect(asked).toHaveLength(1)
  })

  test('разрешить до конца сессии', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const { session, driver } = brokeredSession(broker, sessions, {
      steps: [
        { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } },
        { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }
      ]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(asked).toHaveLength(1), { timeout: 2000 })
    broker.answer(asked[0]!.requestId, { behavior: 'allow', forSession: true })
    await settle(session)

    expect(asked).toHaveLength(1)
    const cards = rec.items.filter((i) => i.kind === 'permission')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ state: 'allowed', scope: 'session' })
    expect(driver.executedTools).toEqual(['Bash', 'Bash'])
    await session.dispose()
  })

  test('разово и навсегда: scope once и always', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const { session } = brokeredSession(broker, sessions, {
      steps: [
        { kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } },
        { kind: 'askPermission', name: 'Read', input: { file_path: 'a.ts' } }
      ]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(asked).toHaveLength(1), { timeout: 2000 })
    broker.answer(asked[0]!.requestId, { behavior: 'allow' })
    await vi.waitFor(() => expect(asked).toHaveLength(2), { timeout: 2000 })
    broker.answer(asked[1]!.requestId, { behavior: 'allow', remember: true })
    await settle(session)

    const cards = rec.items.filter((i) => i.kind === 'permission')
    expect(cards[0]).toMatchObject({ toolName: 'Bash', state: 'allowed', scope: 'once' })
    expect(cards[1]).toMatchObject({ toolName: 'Read', state: 'allowed', scope: 'always' })
    await session.dispose()
  })

  test('отказ с причиной: причина в ленте, агенту — явный запрет с ней', async () => {
    const sessions = new Map<string, AgentSession>()
    const { broker, asked } = makeBrokerFor(sessions)
    const { session, driver } = brokeredSession(broker, sessions, {
      steps: [
        { kind: 'askPermission', name: 'Bash', input: { command: 'git push' } },
        { kind: 'askPermission', name: 'Bash', input: { command: 'git push --force' } }
      ]
    })
    const rec = watch(session)

    await session.start()
    await vi.waitFor(() => expect(asked).toHaveLength(1), { timeout: 2000 })
    broker.answer(asked[0]!.requestId, { behavior: 'deny', message: 'не трогай main' })
    await vi.waitFor(() => expect(asked).toHaveLength(2), { timeout: 2000 })
    broker.answer(asked[1]!.requestId, { behavior: 'deny' })
    await settle(session)

    expect(driver.permissionLog).toEqual([
      {
        name: 'Bash',
        behavior: 'deny',
        message:
          'Пользователь запретил этот вызов. Причина: не трогай main. Не выполняй это действие другим ' +
          'способом и не обходи запрет — спроси пользователя, если нужно.'
      },
      {
        name: 'Bash',
        behavior: 'deny',
        message:
          'Пользователь запретил этот вызов. Не выполняй это действие другим способом и не обходи запрет — ' +
          'спроси пользователя, если нужно.'
      }
    ])
    const cards = rec.items.filter((i) => i.kind === 'permission')
    expect(cards[0]).toMatchObject({ state: 'denied', reason: 'не трогай main' })
    expect(cards[0]).not.toHaveProperty('scope')
    expect(cards[1]).toMatchObject({ state: 'denied' })
    expect(cards[1]).not.toHaveProperty('reason')
    await session.dispose()
  })

  function questionSession(script: FakeScript = {}): ReturnType<typeof makeSession> {
    return makeSession({
      ...script,
      steps: [
        {
          kind: 'askQuestion',
          questions: [
            { question: 'Язык?', options: ['Go', 'Rust'] },
            { question: 'Что ещё?', options: ['Тесты', 'Доки', 'CI'], multiSelect: true }
          ]
        },
        { kind: 'text', text: 'принял' }
      ]
    })
  }

  async function openQuestion(session: AgentSession, rec: Recorder): Promise<string> {
    await session.start()
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    return (rec.items.find((i) => i.kind === 'question') as { toolUseId: string }).toolUseId
  }

  test('заметка к варианту: новый CLI — в annotations, ответ как есть', async () => {
    const { session, driver } = questionSession()
    const rec = watch(session)
    const id = await openQuestion(session, rec)

    session.answerQuestion(
      id,
      { 'Язык?': 'Go', 'Что ещё?': 'Тесты, CI' },
      { 'Язык?': 'только без generics', 'Что ещё?': 'по минимуму' }
    )
    await vi.waitFor(() => expect(texts(rec.items)).toContain('принял'), { timeout: 2000 })
    await settle(session)

    const answer = driver.permissionLog.at(-1)!
    expect(answer.updatedInput?.['answers']).toEqual({ 'Язык?': 'Go', 'Что ещё?': 'Тесты, CI' })
    expect(answer.updatedInput?.['annotations']).toEqual({
      'Язык?': { notes: 'только без generics' },
      'Что ещё?': { notes: 'по минимуму' }
    })
    expect(rec.items.find((i) => i.kind === 'question')).toMatchObject({
      answers: { 'Язык?': 'Go', 'Что ещё?': 'Тесты, CI' },
      notes: { 'Язык?': 'только без generics', 'Что ещё?': 'по минимуму' }
    })
  })

  test('заметка к варианту: старый CLI — «Вариант — комментарий» в самом ответе', async () => {
    const { session, driver } = questionSession({ init: { claudeCodeVersion: '2.1.200' } })
    const rec = watch(session)
    const id = await openQuestion(session, rec)

    session.answerQuestion(
      id,
      { 'Язык?': 'Go', 'Что ещё?': 'Тесты, CI' },
      { 'Язык?': 'только без generics', 'Что ещё?': 'по минимуму' }
    )
    await vi.waitFor(() => expect(texts(rec.items)).toContain('принял'), { timeout: 2000 })
    await settle(session)

    expect(driver.questionAnswers).toEqual([
      { 'Язык?': 'Go — только без generics', 'Что ещё?': 'Тесты, CI — по минимуму' }
    ])
    expect(driver.permissionLog.at(-1)!.updatedInput).not.toHaveProperty('annotations')
    // The ribbon keeps the labels as they are, and the notes beside them.
    expect(rec.items.find((i) => i.kind === 'question')).toMatchObject({
      answers: { 'Язык?': 'Go', 'Что ещё?': 'Тесты, CI' },
      notes: { 'Язык?': 'только без generics', 'Что ещё?': 'по минимуму' }
    })
  })

  test('заметка к своему тексту отброшена, к чужому вопросу — тоже', async () => {
    const { session, driver } = questionSession()
    const rec = watch(session)
    const id = await openQuestion(session, rec)

    session.answerQuestion(
      id,
      { 'Язык?': 'Zig, пожалуйста', 'Что ещё?': 'Доки' },
      { 'Язык?': 'заметка', Чужой: 'x' }
    )
    await vi.waitFor(() => expect(texts(rec.items)).toContain('принял'), { timeout: 2000 })
    await settle(session)

    expect(driver.permissionLog.at(-1)!.updatedInput).not.toHaveProperty('annotations')
    expect(rec.items.find((i) => i.kind === 'question')).not.toHaveProperty('notes')
  })

  test('никто не ждёт: заметка уходит в сообщении «Вопрос» — Вариант — комментарий', async () => {
    const { session, driver } = questionSession({ nextTurn: [{ kind: 'text', text: 'ок' }] })
    const rec = watch(session)
    const id = await openQuestion(session, rec)
    await session.interrupt()

    session.answerQuestion(
      id,
      { 'Язык?': 'Go', 'Что ещё?': 'Тесты, CI' },
      { 'Язык?': 'только без generics' }
    )

    expect(driver.sent.at(-1)?.text).toBe('«Язык?» — Go — только без generics\n«Что ещё?» — Тесты, CI')
    expect(rec.items.find((i) => i.kind === 'question')).toMatchObject({
      notes: { 'Язык?': 'только без generics' }
    })
    await session.dispose()
  })
})

describe('AgentSession: автономность', () => {
  const slowTurn: NonNullable<NonNullable<FakeScript>['nextTurn']> = [
    { kind: 'textStream', pieces: ['один ', 'два ', 'три ', 'четыре ', 'пять'], pauseMs: 50 }
  ]
  const asking: NonNullable<FakeScript>['nextTurn'] = [
    { kind: 'askQuestion', questions: [{ question: 'Куда?', options: ['Справа (Recommended)', 'Снизу'] }] },
    { kind: 'text', text: 'понял' }
  ]
  const phoneAnswers: NonNullable<FakeScript>['nextTurn'] = [
    {
      kind: 'remoteAnswer',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Куда?', options: [{ label: 'туда' }] }] },
      decision: 'deny'
    }
  ]

  function listen(session: AgentSession): AutonomyInput[] {
    const inputs: AutonomyInput[] = []
    session.onAutonomyInput((input) => inputs.push(input))
    return inputs
  }

  type UserItem = Extract<RibbonItem, { kind: 'user' }>
  type QuestionItem = Extract<RibbonItem, { kind: 'question' }>
  type PlanItem = Extract<RibbonItem, { kind: 'plan' }>

  const userItems = (items: RibbonItem[]): UserItem[] => items.filter((i): i is UserItem => i.kind === 'user')
  const questionCard = (session: AgentSession): QuestionItem =>
    session.items.find((i) => i.kind === 'question') as QuestionItem
  const closed = (inputs: AutonomyInput[]): AutonomyInput[] => inputs.filter((i) => i.type === 'waitClosed')
  const acted = (inputs: AutonomyInput[]): AutonomyInput[] => inputs.filter((i) => i.type === 'personActed')

  async function openAsk(session: AgentSession): Promise<string> {
    await session.start()
    session.send({ text: 'спроси', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    return questionCard(session).toolUseId
  }

  test('вопрос даёт questionOpened с подписями вариантов как пришли', async () => {
    const { session } = makeSession({ steps: [], nextTurn: asking })
    const inputs = listen(session)
    const id = await openAsk(session)

    expect(inputs.filter((i) => i.type === 'questionOpened')).toEqual([
      {
        type: 'questionOpened',
        cardId: id,
        questions: [{ question: 'Куда?', options: ['Справа (Recommended)', 'Снизу'], multiSelect: false }]
      }
    ])
    // Every frame and every status reach the core too.
    expect(inputs.some((i) => i.type === 'sdk' && (i.message as { subtype?: string }).subtype === 'init')).toBe(true)
    expect(inputs.filter((i) => i.type === 'status').map((i) => (i as { status: string }).status)).toContain('waiting')
    await session.dispose()
  })

  test('autoAnswerQuestion отвечает ожидающий вопрос: updatedInput.answers дошли до агента, карточка auto', async () => {
    const { session, driver } = makeSession({ steps: [], nextTurn: asking })
    const rec = watch(session)
    const inputs = listen(session)
    const id = await openAsk(session)
    const before = acted(inputs).length

    expect(session.autoAnswerQuestion(id, { 'Куда?': 'Справа (Recommended)' })).toBe(true)
    await vi.waitFor(() => expect(texts(rec.items)).toContain('понял'), { timeout: 2000 })
    await settle(session)

    expect(driver.questionAnswers).toEqual([{ 'Куда?': 'Справа (Recommended)' }])
    expect(questionCard(session)).toMatchObject({ answers: { 'Куда?': 'Справа (Recommended)' }, auto: true })
    expect(closed(inputs)).toEqual([{ type: 'waitClosed', cardId: id, by: 'auto' }])
    // Qclod answered, not a person.
    expect(acted(inputs)).toHaveLength(before)
    expect(driver.sent.map((s) => s.text)).toEqual(['спроси'])
    await session.dispose()
  })

  test('autoAnswerQuestion на вопрос, закрытый Стопом или телефоном, даёт false и ничего не шлёт', async () => {
    // Stopped: the card stays, its question is no longer waited on.
    {
      const { session, driver } = makeSession({ steps: [], nextTurn: asking })
      const rec = watch(session)
      const id = await openAsk(session)
      await session.interrupt()
      await settle(session)
      const sent = driver.sent.length
      const bubbles = userItems(rec.items).length

      expect(session.autoAnswerQuestion(id, { 'Куда?': 'Справа (Recommended)' })).toBe(false)
      await tick()
      expect(driver.sent).toHaveLength(sent)
      expect(userItems(rec.items)).toHaveLength(bubbles)
      expect(driver.questionAnswers).toEqual([])
      // Nothing in the ribbon reads as answered by Qclod.
      expect(session.items.some((i) => 'auto' in i)).toBe(false)
      await session.dispose()
    }
    // Answered on the phone.
    {
      const { session, driver } = makeSession({ nextTurn: phoneAnswers })
      const rec = watch(session)
      await session.start()
      await session.setRemote(true)
      session.send({ text: 'спроси', attachments: [] })
      await settle(session)
      const id = questionCard(session).toolUseId
      const sent = driver.sent.length
      const bubbles = userItems(rec.items).length

      expect(session.autoAnswerQuestion(id, { 'Куда?': 'туда' })).toBe(false)
      await tick()
      expect(driver.sent).toHaveLength(sent)
      expect(userItems(rec.items)).toHaveLength(bubbles)
      expect(questionCard(session)).toMatchObject({ answers: {}, elsewhere: true })
      await session.dispose()
    }
  })

  test('ExitPlanMode в авто-да показывает карточку плана; autoApprovePlan одобряет, режим остаётся autoAllow', async () => {
    const { session, driver } = makeSession(
      { steps: [], nextTurn: [{ kind: 'plan', plan: 'сделать всё' }, { kind: 'text', text: 'делаю' }] },
      { overrides: { permissionMode: 'autoAllow' } }
    )
    const rec = watch(session)
    const inputs = listen(session)
    await session.start()
    session.send({ text: 'спланируй', attachments: [] })
    await vi.waitFor(() => expect(session.status).toBe('waiting'), { timeout: 2000 })
    const card = rec.items.find((i) => i.kind === 'plan') as PlanItem
    expect(card).toMatchObject({ state: 'pending', text: 'сделать всё' })
    expect(inputs).toContainEqual({ type: 'planOpened', cardId: card.requestId })
    expect(driver.executedTools).not.toContain('ExitPlanMode')

    expect(await session.autoApprovePlan(card.requestId)).toBe(true)
    await vi.waitFor(() => expect(texts(rec.items)).toContain('делаю'), { timeout: 2000 })
    await settle(session)

    expect(driver.executedTools).toContain('ExitPlanMode')
    expect(rec.items.find((i) => i.kind === 'plan')).toMatchObject({ state: 'approved', auto: true })
    expect(driver.permissionMode).not.toBe('acceptEdits')
    expect(session.panel.permissionMode).toBe('autoAllow')
    expect(closed(inputs)).toEqual([{ type: 'waitClosed', cardId: card.requestId, by: 'auto' }])
    // A plan no longer waited on is not approved twice.
    expect(await session.autoApprovePlan(card.requestId)).toBe(false)
    await session.dispose()
  })

  test('send с auto: пузырь auto, personActed не приходит; обычный send — personActed', async () => {
    const { session } = makeSession({ steps: [], nextTurn: [{ kind: 'text', text: 'ок' }] })
    const rec = watch(session)
    const inputs = listen(session)
    await session.start()

    expect(session.send({ text: 'продолжай', attachments: [] }, { auto: true })).toBe(true)
    expect(userItems(rec.items).at(-1)).toMatchObject({ text: 'продолжай', auto: true })
    expect(acted(inputs)).toEqual([])
    await settle(session)

    session.send({ text: 'сам', attachments: [] })
    expect(userItems(rec.items).at(-1)).toMatchObject({ text: 'сам' })
    expect(userItems(rec.items).at(-1)).not.toHaveProperty('auto')
    expect(acted(inputs)).toEqual([{ type: 'personActed' }])
    await settle(session)
    await session.dispose()
  })

  test('сообщение с auto при идущем ходе: пузырь на started тоже auto', async () => {
    const { session } = makeSession({ steps: [], turns: [slowTurn] })
    const rec = watch(session)
    await session.start()
    session.send({ text: 'раз', attachments: [] })
    await vi.waitFor(() => expect(session.sessionId).toBeTruthy(), { timeout: 2000 })
    session.send({ text: 'продолжай', attachments: [] }, { auto: true })
    // On the strip first: no bubble until the agent reads it.
    expect(session.panel.queue.map((q) => q.text)).toEqual(['продолжай'])
    expect(userItems(rec.items).map((i) => i.text)).toEqual(['раз'])

    await vi.waitFor(() => expect(userItems(rec.items).map((i) => i.text)).toEqual(['раз', 'продолжай']), {
      timeout: 3000
    })
    expect(userItems(rec.items)[0]).not.toHaveProperty('auto')
    expect(userItems(rec.items)[1]).toMatchObject({ auto: true })
    await settle(session)
    await session.dispose()
  })

  test('авто-сообщение с плашки не уходит преемнику и не возвращается Стопом в поле', async () => {
    {
      const { session } = makeSession({ steps: [], turns: [slowTurn] })
      await session.start()
      session.send({ text: 'раз', attachments: [] })
      await vi.waitFor(() => expect(session.sessionId).toBeTruthy(), { timeout: 2000 })
      session.send({ text: 'продолжай', attachments: [] }, { auto: true })
      session.send({ text: 'сам', attachments: [] })
      expect(session.takeQueue()).toEqual([{ text: 'сам', attachments: [] }])
      expect(session.panel.queue).toEqual([])
      await settle(session)
      await session.dispose()
    }
    {
      const { session } = makeSession({ steps: [], turns: [slowTurn] })
      await session.start()
      session.send({ text: 'раз', attachments: [] })
      await vi.waitFor(() => expect(session.sessionId).toBeTruthy(), { timeout: 2000 })
      session.send({ text: 'продолжай', attachments: [] }, { auto: true })
      session.send({ text: 'сам', attachments: [] })
      expect(await session.interrupt()).toEqual([{ text: 'сам', attachments: [] }])
      expect(session.panel.queue).toEqual([])
      await settle(session)
      await session.dispose()
    }
  })

  test('sentBeforeInit без авто-сообщений', async () => {
    const { session } = makeSession({ steps: [], nextTurn: [{ kind: 'text', text: 'ок' }] })
    await session.start()
    session.send({ text: 'продолжай', attachments: [] }, { auto: true })
    session.send({ text: 'сам', attachments: [] })
    expect(session.sessionId).toBeNull()
    expect(session.sentBeforeInit).toEqual([{ text: 'сам', attachments: [] }])
    await settle(session)
    await session.dispose()
  })

  test('ответ человека: waitClosed person и personActed; аборт SDK при живом мосте: waitClosed elsewhere; Стоп: stop', async () => {
    {
      const { session } = makeSession({ steps: [], nextTurn: asking })
      const inputs = listen(session)
      const id = await openAsk(session)
      const at = inputs.length
      session.answerQuestion(id, { 'Куда?': 'Снизу' })
      const after = inputs.slice(at).filter((i) => i.type === 'waitClosed' || i.type === 'personActed')
      expect(after).toEqual([{ type: 'waitClosed', cardId: id, by: 'person' }, { type: 'personActed' }])
      await settle(session)
      await session.dispose()
    }
    {
      const { session } = makeSession({ nextTurn: phoneAnswers })
      const inputs = listen(session)
      await session.start()
      await session.setRemote(true)
      session.send({ text: 'спроси', attachments: [] })
      await settle(session)
      expect(closed(inputs)).toEqual([
        { type: 'waitClosed', cardId: questionCard(session).toolUseId, by: 'elsewhere' }
      ])
      await session.dispose()
    }
    {
      const { session } = makeSession({ steps: [], nextTurn: asking })
      const inputs = listen(session)
      const id = await openAsk(session)
      await session.interrupt()
      expect(closed(inputs)).toEqual([{ type: 'waitClosed', cardId: id, by: 'stop' }])
      await settle(session)
      await session.dispose()
    }
  })

  test('«Стоп» человека — personActed', async () => {
    const { session } = makeSession({ steps: [], nextTurn: [{ kind: 'thinking', ms: 1000 }] })
    const inputs = listen(session)
    await session.start()
    session.send({ text: 'работай', attachments: [] })
    const before = acted(inputs).length
    await session.interrupt()
    expect(acted(inputs)).toHaveLength(before + 1)
    await settle(session)
    await session.dispose()
  })

  test('пузырь с телефона — personActed', async () => {
    const { session, driver } = makeSession({ steps: [], nextTurn: [{ kind: 'text', text: 'ок' }] })
    const inputs = listen(session)
    await session.start()
    await session.setRemote(true)
    driver.typeOnPhone('с телефона', [{ kind: 'text', text: 'ок' }])
    await vi.waitFor(() => expect(acted(inputs)).toEqual([{ type: 'personActed' }]), { timeout: 2000 })
    await settle(session)
    await session.dispose()
  })

  test('смена режима даёт mode', async () => {
    const { session } = makeSession({ steps: [] })
    const inputs = listen(session)
    await session.start()
    await session.setPermissionMode('plan')
    expect(inputs.filter((i) => i.type === 'mode')).toEqual([{ type: 'mode', mode: 'plan' }])
    // Picking the same mode again is no change.
    await session.setPermissionMode('plan')
    expect(inputs.filter((i) => i.type === 'mode')).toHaveLength(1)
    await session.dispose()
  })

  test('строка при включении авто-да говорит о таймере', async () => {
    const line = (n: number): string =>
      'Режим «авто-да»: Qclod сам отвечает «разрешить» на каждый запрос агента. ' +
      'Сохранённые запреты по-прежнему действуют. ' +
      `На вопрос или план, на который вы не ответите за ${n} мин, Qclod ответит сам: ` +
      'выберет рекомендуемый вариант или одобрит план.'
    const notices = (items: RibbonItem[]): string[] =>
      items.filter((i) => i.kind === 'notice').map((i) => (i as { text: string }).text)

    const { session } = makeSession({ steps: [] }, { confirmAutoAllow: async () => true })
    const rec = watch(session)
    await session.start()
    await session.setPermissionMode('autoAllow')
    expect(notices(rec.items)).toContain(line(5))
    await session.dispose()

    const custom = makeSession({ steps: [] }, { confirmAutoAllow: async () => true, autoAnswerMinutes: () => 12 })
    const seen = watch(custom.session)
    await custom.session.start()
    await custom.session.setPermissionMode('autoAllow')
    expect(notices(seen.items)).toContain(line(12))
    await custom.session.dispose()
  })

  test('setAutonomyView кладёт вид в панель', async () => {
    const { session } = makeSession({ steps: [] })
    const rec = watch(session)
    await session.start()
    const view = { timers: [], limitWait: { resetsAt: null, continueAt: 1000, weekly: false }, gaveUp: null }
    session.setAutonomyView(view)
    expect(session.panel.autonomy).toEqual(view)
    expect(rec.panels.at(-1)).toEqual({ autonomy: view })
    await session.dispose()
  })
})
