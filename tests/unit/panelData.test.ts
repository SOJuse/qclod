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
