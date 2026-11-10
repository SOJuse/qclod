import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PanelCollector, readProjectSettings } from '../../src/main/agent/panelData'

function init(extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    model: 'claude-opus-5',
    permissionMode: 'default',
    mcp_servers: [],
    ...extra
  }
}

function rateLimit(fiveHour: number, sevenDay: number): unknown {
  return {
    type: 'rate_limit_event',
    session_id: 's1',
    rate_limit_info: {
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: 1794083400,
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: 1794083400 },
        seven_day: { utilization: sevenDay, resetsAt: 1794481200 }
      }
    }
  }
}

describe('PanelCollector', () => {
  test('модель и режим приходят со старта', () => {
    const collector = new PanelCollector()
    const patch = collector.apply(init())

    expect(patch).toMatchObject({ model: 'claude-opus-5', permissionMode: 'default' })
    expect(collector.data.model).toBe('claude-opus-5')
  })

  test('MCP-серверы приходят со старта со статусом', () => {
    const collector = new PanelCollector()
    collector.apply(
      init({
        mcp_servers: [
          { name: 'plugin:github:github', status: 'needs-auth' },
          { name: 'unity-mcp', status: 'pending' }
        ]
      })
    )

    // Four states, not two: «требует входа» is real and the panel must say so.
    expect(collector.data.mcp).toEqual([
      { name: 'plugin:github:github', status: 'needs-auth' },
      { name: 'unity-mcp', status: 'pending' }
    ])
  })

  test('лимиты подписки приходят каждым ходом и видны оба окна', () => {
    // The first draft of the spec said these were unreachable. The probe
    // disproved it (note 2), and the user asked for exactly this.
    const collector = new PanelCollector()
    const patch = collector.apply(rateLimit(0.13, 0.38))

    expect(patch).toEqual({
      limits: {
        fiveHour: { utilization: 0.13, resetsAt: 1794083400 },
        sevenDay: { utilization: 0.38, resetsAt: 1794481200 }
      }
    })
  })

  test('лимиты обновляются, а не накапливаются', () => {
    const collector = new PanelCollector()
    collector.apply(rateLimit(0.13, 0.38))
    collector.apply(rateLimit(0.42, 0.55))

    expect(collector.data.limits.fiveHour?.utilization).toBe(0.42)
  })

  test('расход за сессию берётся из результата хода', () => {
    const collector = new PanelCollector()
    collector.apply({ type: 'result', subtype: 'success', total_cost_usd: 0.0421 })
    collector.apply({ type: 'result', subtype: 'success', total_cost_usd: 0.1337 })

    // The SDK reports the session total, not a per-turn delta: the later
    // number replaces the earlier one rather than adding to it.
    expect(collector.data.cost?.session).toBeCloseTo(0.1337)
  })

  test('смена модели в середине сессии обновляет панель', () => {
    const collector = new PanelCollector()
    collector.apply(init({ model: 'claude-opus-5' }))
    const patch = collector.apply({
      type: 'system',
      subtype: 'model_changed',
      model: 'claude-sonnet-5'
    })

    expect(patch).toEqual({ model: 'claude-sonnet-5' })
    expect(collector.data.model).toBe('claude-sonnet-5')
  })

  test('режим разрешений ведём сами, SDK сообщает его только на старте', () => {
    const collector = new PanelCollector()
    collector.apply(init({ permissionMode: 'default' }))

    expect(collector.setPermissionMode('plan')).toEqual({ permissionMode: 'plan' })
    expect(collector.data.permissionMode).toBe('plan')

    // A later init (a restart) must not quietly undo what the user chose.
    collector.apply(init({ permissionMode: 'default' }))
    expect(collector.data.permissionMode).toBe('plan')
  })

  test('контекст берётся готовым процентом, а не считается заново', () => {
    const collector = new PanelCollector()
    const patch = collector.setContext({
      totalTokens: 42000,
      maxTokens: 200000,
      percentage: 21,
      categories: [
        { name: 'messages', tokens: 30000, kind: 'used' },
        { name: 'free_space', tokens: 158000, kind: 'free' }
      ]
    })

    expect(patch.context).toEqual({
      used: 42000,
      max: 200000,
      percent: 21,
      categories: [{ name: 'messages', tokens: 30000 }]
    })
  })

  test('неизвестное сообщение ничего не меняет', () => {
    const collector = new PanelCollector()
    expect(collector.apply({ type: 'hook_started' })).toBeNull()
    expect(collector.apply(null)).toBeNull()
    expect(collector.apply('мусор')).toBeNull()
  })

  test('до запуска всё пусто, а не ноль', () => {
    const collector = new PanelCollector()
    expect(collector.data.context).toBeNull()
    expect(collector.data.cost).toBeNull()
    expect(collector.data.model).toBeNull()
    expect(collector.data.limits).toEqual({ fiveHour: null, sevenDay: null })
  })
})

describe('readProjectSettings', () => {
  let project = ''

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'qclod-project-'))
  })

  afterEach(() => {
    rmSync(project, { recursive: true, force: true })
  })

  test('своих хуков и MCP у папки нет — строки настроек проекта нет вовсе', () => {
    expect(readProjectSettings(project)).toBeNull()
  })

  test('у папки есть свои хуки — панель это показывает', () => {
    mkdirSync(join(project, '.claude'))
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ command: 'echo раз' }, { command: 'echo два' }] }],
          Stop: [{ hooks: [{ command: 'echo три' }] }]
        }
      }),
      'utf8'
    )

    expect(readProjectSettings(project)).toEqual({ hooks: 3, mcpServers: [] })
  })

  test('свои MCP-серверы папки видны по именам', () => {
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'мой-сервер': {}, второй: {} } }),
      'utf8'
    )

    expect(readProjectSettings(project)).toEqual({ hooks: 0, mcpServers: ['мой-сервер', 'второй'] })
  })

  test('повреждённые настройки проекта не роняют панель', () => {
    mkdirSync(join(project, '.claude'))
    writeFileSync(join(project, '.claude', 'settings.json'), '{это не json', 'utf8')

    expect(() => readProjectSettings(project)).not.toThrow()
    expect(readProjectSettings(project)).toBeNull()
  })

  test('чужие настройки только читаются, файл не меняется', () => {
    mkdirSync(join(project, '.claude'))
    const path = join(project, '.claude', 'settings.local.json')
    const before = JSON.stringify({ permissions: { allow: ['Read'] } })
    writeFileSync(path, before, 'utf8')

    readProjectSettings(project)

    // Constraint 5: the user's settings files are never modified.
    expect(require('node:fs').readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('PanelCollector: нулевой расход', () => {
  test('ноль не показывается как цена', () => {
    const collector = new PanelCollector()
    expect(collector.apply({ type: 'result', subtype: 'success', total_cost_usd: 0 })).toBeNull()
    expect(collector.data.cost).toBeNull()

    collector.apply({ type: 'result', subtype: 'success', total_cost_usd: 0.004 })
    expect(collector.data.cost?.session).toBeCloseTo(0.004)
  })
})

describe('PanelCollector: до первого сообщения', () => {
  test('seedModel не перезаписывает модель от процесса', () => {
    const fromInit = new PanelCollector()
    fromInit.apply(init({ model: 'claude-opus-5' }))
    expect(fromInit.seedModel('claude-sonnet-5')).toEqual({})
    expect(fromInit.data.model).toBe('claude-opus-5')

    const fromContext = new PanelCollector()
    fromContext.setContext({
      model: 'claude-opus-5',
      totalTokens: 1,
      maxTokens: 2,
      percentage: 50,
      categories: []
    })
    fromContext.seedModel('claude-sonnet-5')
    expect(fromContext.data.model).toBe('claude-opus-5')

    // Nothing from the process yet: the history's model stands in…
    const early = new PanelCollector()
    expect(early.seedModel('claude-sonnet-5')).toEqual({ model: 'claude-sonnet-5' })
    // …until the process names its own.
    early.apply(init({ model: 'claude-opus-5' }))
    expect(early.data.model).toBe('claude-opus-5')
  })

  test('контекст приносит модель, если она в ответе есть', () => {
    const collector = new PanelCollector()
    const usage = { totalTokens: 1, maxTokens: 2, percentage: 50, categories: [] }

    expect(collector.setContext(usage)).not.toHaveProperty('model')
    expect(collector.data.model).toBeNull()

    expect(collector.setContext({ ...usage, model: 'claude-opus-5' })).toMatchObject({
      model: 'claude-opus-5'
    })
    expect(collector.data.model).toBe('claude-opus-5')
  })

  test('setLimits ставит оба окна, rate_limit_event потом их обновляет', () => {
    const collector = new PanelCollector()
    const limits = {
      fiveHour: { utilization: 0.1, resetsAt: 1794083400 },
      sevenDay: { utilization: 0.2, resetsAt: 1794481200 }
    }
    expect(collector.setLimits(limits)).toEqual({ limits })
    expect(collector.data.limits).toEqual(limits)

    collector.apply(rateLimit(0.5, 0.6))
    expect(collector.data.limits.fiveHour?.utilization).toBe(0.5)
    expect(collector.data.limits.sevenDay?.utilization).toBe(0.6)
  })

  test('после markResumed расход помечен «с момента открытия»', () => {
    const fresh = new PanelCollector()
    fresh.apply({ type: 'result', subtype: 'success', total_cost_usd: 0.25 })
    expect(fresh.data.cost).toEqual({ session: 0.25 })

    const resumed = new PanelCollector()
    resumed.markResumed()
    resumed.apply({ type: 'result', subtype: 'success', total_cost_usd: 0.25 })
    expect(resumed.data.cost).toEqual({ session: 0.25, sinceOpen: true })
  })
})

describe('PanelCollector: живой MCP и ревизии', () => {
  test('init не откатывает живой статус MCP на pending', () => {
    const collector = new PanelCollector()
    collector.setMcp([{ name: 'unity', status: 'connected' }])

    const patch = collector.apply(init({ mcp_servers: [{ name: 'unity', status: 'pending' }] }))

    expect(patch).not.toHaveProperty('mcp')
    expect(collector.data.mcp).toEqual([{ name: 'unity', status: 'connected' }])
    // The rest of init still lands.
    expect(collector.data.model).toBe('claude-opus-5')
  })

  test('до живого ответа init показывает MCP как есть', () => {
    const collector = new PanelCollector()
    collector.apply(init({ mcp_servers: [{ name: 'unity', status: 'pending' }] }))
    expect(collector.data.mcp).toEqual([{ name: 'unity', status: 'pending' }])
  })

  test('ревизия растёт и у новой сессии продолжается, а не начинается с нуля', () => {
    const first = new PanelCollector()
    expect(first.rev).toBe(0)
    first.setModel('claude-opus-5')
    const a = first.rev
    first.setEffort('high')
    const b = first.rev
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)

    // A restarted tab gets a new collector; its patches must still outrank
    // what the window already holds from the old one.
    const second = new PanelCollector()
    second.setModel('claude-sonnet-5')
    expect(second.rev).toBeGreaterThan(b)
  })

  test('пустой патч ревизию не тратит', () => {
    const collector = new PanelCollector()
    collector.setModel('claude-opus-5')
    const before = collector.rev
    expect(collector.seedModel('claude-sonnet-5')).toEqual({})
    expect(collector.rev).toBe(before)
  })
})
