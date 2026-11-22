import { describe, expect, test, vi } from 'vitest'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { AgentSession } from '../../src/main/agent/AgentSession'
import type { AgentDriver } from '../../src/main/agent/driver'
import { toPermissionContext } from '../../src/main/agent/permissionContext'
import { PermissionBroker } from '../../src/main/agent/permissions'
import { PanelCollector, clampPercent, estimatedWindow } from '../../src/main/agent/panelData'
import { agentCommandLine, encodePowerShell, openAgentTerminal } from '../../src/main/system/console'
import { RibbonBuilder } from '../../src/shared/ribbon'
import { clockTime } from '../../src/shared/format'
import {
  PERMISSION_MODES,
  sdkPermissionMode,
  type PermissionRequest,
  type RibbonItem,
  type SessionStatus
} from '../../src/shared/types'
import { sanitizeDefaults, sanitizeOverrides } from '../../src/main/tabs/sanitize'

function syntheticText(text: string): unknown {
  return {
    type: 'assistant',
    message: { id: `s-${text.length}`, role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }
  }
}

describe('«авто-да»: Qclod сам отвечает «разрешить»', () => {
  test('режим известен окну и проходит проверку, но SDK видит default', () => {
    expect(PERMISSION_MODES).toContain('autoAllow')
    expect(sanitizeOverrides({ permissionMode: 'autoAllow' })).toEqual({ permissionMode: 'autoAllow' })
    expect(sdkPermissionMode('autoAllow')).toBe('default')
    expect(sdkPermissionMode('plan')).toBe('plan')
  })

  test('брокер в авто-режиме разрешает без вопроса, но сохранённый запрет сильнее', async () => {
    const asked: PermissionRequest[] = []
    const broker = new PermissionBroker({
      loadRules: () => [{ id: 'r1', toolName: 'Bash', target: 'rm -rf /', behavior: 'deny' }],
      saveRules: () => undefined,
      ask: (r) => asked.push(r)
    })
    await expect(broker.request('t', 'Bash', { command: 'npm test' }, 'a', undefined, true)).resolves.toEqual({
      behavior: 'allow'
    })
    await expect(broker.request('t', 'Bash', { command: 'rm -rf /' }, 'b', undefined, true)).resolves.toEqual({
      behavior: 'deny'
    })
    expect(asked).toHaveLength(0)
  })

  test('allowTab разрешает то, что уже ждёт ответа на этой вкладке, и не трогает другие', async () => {
    const broker = new PermissionBroker({ loadRules: () => [], saveRules: () => undefined, ask: () => undefined })
    const mine = broker.request('t1', 'Bash', { command: 'a' }, 'x')
    const other = broker.request('t2', 'Bash', { command: 'b' }, 'y')
    broker.allowTab('t1')
    await expect(mine).resolves.toEqual({ behavior: 'allow' })
    const still = await Promise.race([other, Promise.resolve('ждёт')])
    expect(still).toBe('ждёт')
    broker.cancelAll()
  })

  test('сессия в «авто-да» не показывает карточку и не встаёт в «ждёт»', async () => {
    const requests: PermissionRequest[] = []
    const gate = { ask: async (..._a: unknown[]) => ({ behavior: 'deny' }) as never }
    const driver = createFakeSdk({
      steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }],
      canUseTool: (name: string, input: Record<string, unknown>, opts: unknown) => gate.ask(name, input, opts)
    })
    let launchedMode: string | undefined
    const session = new AgentSession({
      tabId: 't1',
      cwd: 'C:/проект',
      overrides: { permissionMode: 'autoAllow' },
      agentPath: 'claude',
      resolveAgent: () => 'C:/bin/claude.exe',
      askPermission: async (request) => {
        requests.push(request)
        return { behavior: request.auto ? ('allow' as const) : ('deny' as const) }
      },
      createDriver: (options) => {
        launchedMode = options.permissionMode
        gate.ask = (name, input, opts) =>
          options.canUseTool(name as string, input as Record<string, unknown>, toPermissionContext(opts)) as never
        return driver as unknown as AgentDriver
      },
      panelRefreshMs: 0
    })
    const statuses: SessionStatus[] = []
    session.onStatus((s) => statuses.push(s))

    await session.start()
    await session.whenIdle()

    expect(launchedMode).toBe('default')
    expect(requests).toHaveLength(1)
    expect(requests[0]!.auto).toBe(true)
    expect(session.items.some((i) => i.kind === 'permission')).toBe(false)
    expect(statuses).not.toContain('waiting')
    expect(driver.executedTools).toContain('Bash')
    // init says «default»; the panel keeps the tab's own mode.
    expect(session.panel.permissionMode).toBe('autoAllow')
    await session.dispose()
  })

  test('включение «авто-да» спрашивает подтверждение; без него режим не меняется', async () => {
    const make = (confirmAutoAllow?: () => Promise<boolean>): AgentSession =>
      new AgentSession({
        tabId: 't1',
        cwd: 'C:/проект',
        overrides: {},
        agentPath: 'claude',
        resolveAgent: () => 'C:/bin/claude.exe',
        askPermission: async () => ({ behavior: 'deny' as const }),
        createDriver: () => createFakeSdk({ steps: [] }) as unknown as AgentDriver,
        panelRefreshMs: 0,
        ...(confirmAutoAllow ? { confirmAutoAllow } : {})
      })

    const unconfirmed = make()
    await unconfirmed.start()
    await unconfirmed.setPermissionMode('autoAllow')
    expect(unconfirmed.panel.permissionMode).not.toBe('autoAllow')
    await unconfirmed.dispose()

    const refused = make(async () => false)
    await refused.start()
    await refused.setPermissionMode('autoAllow')
    expect(refused.panel.permissionMode).not.toBe('autoAllow')
    await refused.dispose()

    const confirm = vi.fn(async () => true)
    const agreed = make(confirm)
    await agreed.start()
    await agreed.setPermissionMode('autoAllow')
    expect(agreed.panel.permissionMode).toBe('autoAllow')
    // Already on: picking it again asks nothing.
    await agreed.setPermissionMode('autoAllow')
    expect(confirm).toHaveBeenCalledTimes(1)
    await agreed.dispose()
  })

  test('«авто-да» не становится режимом по умолчанию для новых вкладок', () => {
    expect(sanitizeDefaults({ permissionMode: 'autoAllow' })).toEqual({ permissionMode: 'default' })
  })

  test('если CLI отказался сменить режим, панель остаётся на прежнем и в ленте есть объяснение', async () => {
    const driver = createFakeSdk({ steps: [] })
    const session = new AgentSession({
      tabId: 't1',
      cwd: 'C:/проект',
      overrides: {},
      agentPath: 'claude',
      resolveAgent: () => 'C:/bin/claude.exe',
      askPermission: async () => ({ behavior: 'deny' as const }),
      confirmBypass: async () => true,
      createDriver: () => driver as unknown as AgentDriver,
      panelRefreshMs: 0
    })
    await session.start()
    await session.whenIdle()
    ;(driver as unknown as AgentDriver).setPermissionMode = async () => {
      throw new Error('bypass is disabled')
    }
    await session.setPermissionMode('bypassPermissions')

    expect(session.panel.permissionMode).not.toBe('bypassPermissions')
    const notice = session.items.find((i) => i.kind === 'notice' && i.tone === 'error')
    expect(notice).toMatchObject({ text: expect.stringContaining('без проверок') })
    await session.dispose()
  })
})

describe('контекст и лимиты', () => {
  test('процент контекста не выходит за 0–100', () => {
    expect(clampPercent(190)).toBe(100)
    expect(clampPercent(101)).toBe(100)
    expect(clampPercent(-3)).toBe(0)
    expect(clampPercent(Number.NaN)).toBe(0)
    const collector = new PanelCollector()
    collector.setContext({ totalTokens: 380_000, maxTokens: 200_000, percentage: 190, categories: [] })
    expect(collector.data.context?.percent).toBe(100)
  })

  test('оценка по записи: больше 200K — значит окно 1M, а не 190%', () => {
    expect(estimatedWindow('claude-sonnet-4-5', 380_000)).toBe(1_000_000)
    expect(estimatedWindow('claude-opus-5-5', 30_000)).toBe(1_000_000)
    expect(estimatedWindow('claude-sonnet-4-5', 30_000)).toBe(200_000)
    const collector = new PanelCollector()
    collector.seedFromTranscript([
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 380_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }
        }
      }
    ])
    expect(collector.data.context).toMatchObject({ max: 1_000_000, percent: 38 })
  })

  test('событие об одном окне лимита не стирает другое', () => {
    const collector = new PanelCollector()
    collector.setLimits({ fiveHour: { utilization: 0.5, resetsAt: 100 }, sevenDay: { utilization: 0.2, resetsAt: 200 } })
    collector.apply({
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.7, resetsAt: 150 } } }
    })
    expect(collector.data.limits).toEqual({
      fiveHour: { utilization: 0.7, resetsAt: 150 },
      sevenDay: { utilization: 0.2, resetsAt: 200 }
    })
  })

  test('процент в событии лимита (97) читается как доля 0,97', () => {
    const collector = new PanelCollector()
    collector.apply({
      type: 'rate_limit_event',
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 97, resetsAt: 150 } } }
    })
    expect(collector.data.limits.fiveHour?.utilization).toBeCloseTo(0.97)
  })

  test('живая сессия сама переспрашивает лимиты и контекст по таймеру', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const driver = createFakeSdk({ steps: [] }) as unknown as AgentDriver
      const limits = vi.spyOn(driver, 'planLimits')
      const context = vi.spyOn(driver, 'getContextUsage')
      const session = new AgentSession({
        tabId: 't1',
        cwd: 'C:/проект',
        overrides: {},
        agentPath: 'claude',
        resolveAgent: () => 'C:/bin/claude.exe',
        askPermission: async () => ({ behavior: 'deny' as const }),
        createDriver: () => driver,
        panelRefreshMs: 1000
      })
      await session.start()
      await session.whenIdle()
      const before = limits.mock.calls.length
      vi.advanceTimersByTime(1000)
      expect(limits.mock.calls.length).toBe(before + 1)
      expect(context).toHaveBeenLastCalledWith({ detail: 'summary' })
      await session.dispose()
      const afterDispose = limits.mock.calls.length
      vi.advanceTimersByTime(5000)
      expect(limits.mock.calls.length).toBe(afterDispose)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('лента: время и команды терминала', () => {
  test('сообщение помнит, когда отправлено, а конец хода — когда закончен и сколько длился', () => {
    let now = 1_000
    const builder = new RibbonBuilder({ now: () => now })
    const [sent] = builder.addUser('привет')
    expect(sent).toMatchObject({ kind: 'append', item: { kind: 'user', at: 1_000 } })
    now = 61_000
    const changes = builder.apply({ type: 'result', subtype: 'success', num_turns: 1, duration_ms: 60_000, duration_api_ms: 50_000 })
    const end = changes.find((c) => c.kind === 'append')
    expect(end).toMatchObject({ item: { kind: 'turnEnd', at: 61_000, durationMs: 60_000 } })
  })

  test('ответ на локальную команду без хода модели не даёт строки «готово»', () => {
    const builder = new RibbonBuilder()
    const changes = builder.apply({ type: 'result', subtype: 'success', num_turns: 0, duration_ms: 3, duration_api_ms: 0 })
    expect(changes.some((c) => c.kind === 'append')).toBe(false)
  })

  test('прерванный ход помечен', () => {
    const builder = new RibbonBuilder()
    const changes = builder.apply({ type: 'result', subtype: 'error_during_execution', num_turns: 2, duration_api_ms: 10 })
    expect(changes.find((c) => c.kind === 'append')).toMatchObject({ item: { kind: 'turnEnd', failed: true } })
  })

  test('история берёт время из записи, а без него времени нет', () => {
    const builder = new RibbonBuilder({ replay: true })
    builder.apply({ type: 'user', timestamp: '2026-11-17T10:00:00.000Z', message: { role: 'user', content: 'раз' } })
    builder.apply({ type: 'user', message: { role: 'user', content: 'два' } })
    const users = builder.items.filter((i): i is Extract<RibbonItem, { kind: 'user' }> => i.kind === 'user')
    expect(users[0]!.at).toBe(Date.parse('2026-11-17T10:00:00.000Z'))
    expect(users[1]!.at).toBeUndefined()
  })

  test('«/chrome isn\'t available in this environment» становится заметкой с кнопкой терминала', () => {
    const builder = new RibbonBuilder()
    builder.apply(syntheticText("/chrome isn't available in this environment."))
    expect(builder.items).toHaveLength(1)
    expect(builder.items[0]).toMatchObject({
      kind: 'notice',
      action: 'terminal',
      text: expect.stringContaining('/chrome')
    })
  })

  test('неизвестная команда — понятная заметка, обычный текст модели не трогается', () => {
    const builder = new RibbonBuilder()
    builder.apply(syntheticText('Unknown command: /foo'))
    expect(builder.items[0]).toMatchObject({ kind: 'notice', text: expect.stringContaining('/foo') })
    builder.apply({
      type: 'assistant',
      message: { id: 'm2', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: "/x isn't available in this environment." }] }
    })
    expect(builder.items[1]).toMatchObject({ kind: 'agentText' })
  })

  test('время по часам системы: сегодня — с секундами, другой день — с датой', () => {
    const now = new Date(2026, 10, 17, 18, 0, 0).getTime()
    expect(clockTime(new Date(2026, 10, 17, 14, 35, 7).getTime(), now)).toBe('14:35:07')
    expect(clockTime(new Date(2026, 10, 17, 14, 35, 7).getTime(), now, false)).toBe('14:35')
    expect(clockTime(new Date(2026, 10, 16, 9, 5, 0).getTime(), now)).toMatch(/^16 нояб\.?, 09:05$/)
  })
})

describe('консоль и голос', () => {
  test('терминал открывается в папке вкладки, путь не проходит через внешний cmd', () => {
    const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
    openAgentTerminal('C:/Program Files/claude & co/claude.exe', 'D:/проект', (file, args, opts) => {
      calls.push({ file, args, opts: opts as Record<string, unknown> })
      return { on: () => undefined, unref: () => undefined }
    }, 'win32')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe('cmd.exe')
    expect(calls[0]!.opts['cwd']).toBe('D:/проект')
    expect(calls[0]!.args.join(' ')).not.toContain('claude & co')
    expect((calls[0]!.opts['env'] as Record<string, string>)['QCLOD_AGENT_LINE']).toBe(
      agentCommandLine('C:/Program Files/claude & co/claude.exe')
    )
  })

  test('скрипт PowerShell уходит в UTF-16LE base64', () => {
    expect(Buffer.from(encodePowerShell('Win+H'), 'base64').toString('utf16le')).toBe('Win+H')
  })
})
