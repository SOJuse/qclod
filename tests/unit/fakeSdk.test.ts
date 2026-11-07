import { describe, expect, test } from 'vitest'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'

async function collect(driver: {
  messages: AsyncIterable<Record<string, unknown>>
}): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const m of driver.messages) out.push(m)
  return out
}

function kinds(messages: Array<Record<string, unknown>>): string[] {
  return messages.map((m) => `${m['type']}${m['subtype'] ? '/' + String(m['subtype']) : ''}`)
}

describe('createFakeSdk', () => {
  test('любая сессия начинается с system/init, как настоящая', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'text', text: 'привет' }] })
    expect(kinds(await collect(driver))[0]).toBe('system/init')
  })

  test('init несёт модель, список команд и MCP-серверы', async () => {
    const driver = createFakeSdk({
      steps: [],
      init: { model: 'claude-opus-5', mcpServers: [{ name: 'unity', status: 'connected' }] }
    })
    const init = (await collect(driver))[0] as Record<string, never>
    expect(init['model']).toBe('claude-opus-5')
    expect(init['mcp_servers']).toEqual([{ name: 'unity', status: 'connected' }])
    expect(Array.isArray(init['slash_commands'])).toBe(true)
  })

  test('проигрывает сценарий по шагам и завершает ход result-ом', async () => {
    const driver = createFakeSdk({
      steps: [
        { kind: 'text', text: 'смотрю файл' },
        { kind: 'tool', name: 'Read', input: { file_path: 'auth.ts' }, result: '120 строк' }
      ]
    })
    const got = kinds(await collect(driver))
    expect(got[0]).toBe('system/init')
    expect(got).toContain('assistant')
    expect(got[got.length - 1]).toBe('result/success')
  })

  test('result несёт стоимость и разбивку токенов', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'text', text: 'ок' }] })
    const last = (await collect(driver)).at(-1) as Record<string, never>
    expect(typeof last['total_cost_usd']).toBe('number')
    expect(last['usage']).toBeTruthy()
  })

  test('rate_limit_event отдаёт оба окна лимитов', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'text', text: 'ок' }] })
    const event = (await collect(driver)).find((m) => m['type'] === 'rate_limit_event') as Record<
      string,
      never
    >
    const windows = event['rate_limit_info']['unifiedWindows']
    expect(windows['five_hour']['utilization']).toBeGreaterThanOrEqual(0)
    expect(windows['seven_day']['resetsAt']).toBeGreaterThan(0)
  })

  test('askPermission ждёт ответа и не идёт дальше без него', async () => {
    const driver = createFakeSdk({
      steps: [
        { kind: 'askPermission', name: 'Edit', input: { file_path: 'auth.ts' } },
        { kind: 'text', text: 'правка применена' }
      ],
      canUseTool: async () => ({ behavior: 'allow' as const })
    })
    const seen = await collect(driver)
    expect(driver.permissionRequests).toHaveLength(1)
    expect(kinds(seen)).toContain('assistant')
  })

  test('отказ в разрешении не выполняет инструмент', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'askPermission', name: 'Edit', input: {} }],
      canUseTool: async () => ({ behavior: 'deny' as const })
    })
    await collect(driver)
    expect(driver.executedTools).toEqual([])
  })

  test('crash прерывает поток, уже выданные сообщения остаются', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'text', text: 'начал' }, { kind: 'crash', message: 'агент умер' }]
    })
    const seen: Array<Record<string, unknown>> = []
    await expect(async () => {
      for await (const m of driver.messages) seen.push(m)
    }).rejects.toThrow('агент умер')
    expect(kinds(seen)).toContain('assistant')
  })

  test('compact_boundary отдаёт токены до и после', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'compact', preTokens: 120_000, postTokens: 30_000 }]
    })
    const boundary = (await collect(driver)).find(
      (m) => m['subtype'] === 'compact_boundary'
    ) as Record<string, never>
    expect(boundary['compact_metadata']['pre_tokens']).toBe(120_000)
    expect(boundary['compact_metadata']['post_tokens']).toBe(30_000)
  })

  test('send продолжает разговор новым ходом', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'text', text: 'первый' }],
      nextTurn: [{ kind: 'text', text: 'второй' }]
    })
    const first: Array<Record<string, unknown>> = []
    for await (const m of driver.messages) {
      first.push(m)
      if (m['type'] === 'result') break
    }
    driver.send({ text: 'ещё', attachments: [] })
    expect(driver.sent).toEqual([{ text: 'ещё', attachments: [] }])
  })

  test('методы сессии отвечают', async () => {
    const driver = createFakeSdk({ steps: [] })
    await expect(driver.supportedCommands()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'compact' })])
    )
    await expect(driver.getContextUsage()).resolves.toEqual(
      expect.objectContaining({ percentage: expect.any(Number) })
    )
    await expect(driver.mcpServerStatus()).resolves.toEqual(expect.any(Array))
    await driver.setPermissionMode('plan')
    expect(driver.permissionMode).toBe('plan')
    await driver.interrupt()
    expect(driver.interrupted).toBe(true)
  })
})
