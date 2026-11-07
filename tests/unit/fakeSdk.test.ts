import { describe, expect, test } from 'vitest'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'

/**
 * One turn's worth of messages. The stream does not end after an answer — a
 * real session waits for the next message — so a consumer reads up to the
 * turn's `result` and stops there.
 */
async function collect(
  driver: { messages: AsyncIterable<Record<string, unknown>> },
  turns = 1
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  let seen = 0
  for await (const m of driver.messages) {
    out.push(m)
    if (m['type'] === 'result' && ++seen === turns) break
  }
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

describe('createFakeSdk: следующий ход', () => {
  test('send проигрывает nextTurn и эхо сообщения пользователя', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'text', text: 'первый ход' }],
      nextTurn: [{ kind: 'text', text: 'второй ход' }]
    })

    const out: Array<Record<string, unknown>> = []
    let results = 0
    const reader = (async () => {
      for await (const m of driver.messages) {
        out.push(m)
        if (m['type'] === 'result' && ++results === 2) break
      }
    })()

    driver.send({ text: 'продолжай', attachments: [] })
    await reader

    const echo = out.find(
      (m) => m['type'] === 'user' && (m['message'] as { content: unknown }).content === 'продолжай'
    )
    expect(echo).toBeDefined()

    const said = out
      .filter((m) => m['type'] === 'assistant')
      .flatMap((m) => ((m['message'] as { content: Array<{ text?: string }> }).content ?? []))
      .map((b) => b.text)
    expect(said).toEqual(['первый ход', 'второй ход'])
  })

  test('dispose отпускает поток, ждущий следующего сообщения', async () => {
    const driver = createFakeSdk({ steps: [] })
    const seen: string[] = []
    const reader = (async () => {
      for await (const m of driver.messages) seen.push(String(m['type']))
    })()

    await driver.dispose()
    await reader

    expect(seen.at(-1)).toBe('result')
    expect(driver.disposed).toBe(true)
  })
})

describe('createFakeSdk: потоковый текст', () => {
  test('textStream даёт дельты и завершающее сообщение с тем же id', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'textStream', pieces: ['Привет', ', ', 'мир'] }]
    })
    const out = await collect(driver)

    const deltas = out.filter((m) => m['type'] === 'stream_event')
    expect(deltas).toHaveLength(4) // message_start + три дельты

    const started = deltas[0]!['event'] as { message: { id: string } }
    const complete = out.find((m) => m['type'] === 'assistant')!
    expect((complete['message'] as { id: string }).id).toBe(started.message.id)
    expect((complete['message'] as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      'Привет, мир'
    )
  })
})
