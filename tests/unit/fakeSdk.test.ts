import { describe, expect, test, vi } from 'vitest'
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

type Ctx = { toolUseID: string; signal: AbortSignal }
type Answer = { behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }

function toolUses(messages: Array<Record<string, unknown>>): Array<{ id: string; name: string }> {
  return messages
    .filter((m) => m['type'] === 'assistant')
    .flatMap((m) => (m['message'] as { content: Array<Record<string, unknown>> }).content)
    .filter((b) => b['type'] === 'tool_use')
    .map((b) => ({ id: String(b['id']), name: String(b['name']) }))
}

function toolResults(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages
    .filter((m) => m['type'] === 'user' && Array.isArray((m['message'] as { content: unknown }).content))
    .flatMap((m) => (m['message'] as { content: Array<Record<string, unknown>> }).content)
    .filter((b) => b['type'] === 'tool_result')
}

describe('createFakeSdk: id запросов, как у настоящего SDK', () => {
  test('askPermission передаёт toolUseID будущего tool_use и AbortSignal', async () => {
    const contexts: Ctx[] = []
    const driver = createFakeSdk({
      steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }],
      canUseTool: async (_name, _input, ctx) => {
        contexts.push(ctx)
        return { behavior: 'allow' as const }
      }
    })
    const out = await collect(driver)

    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(typeof contexts[0]!.toolUseID).toBe('string')
    expect(toolUses(out)).toEqual([{ id: contexts[0]!.toolUseID, name: 'Bash' }])
    expect(toolResults(out)[0]!['tool_use_id']).toBe(contexts[0]!.toolUseID)
  })

  test('askQuestion сначала выдаёт tool_use, потом спрашивает canUseTool с его id', async () => {
    const order: string[] = []
    const driver = createFakeSdk({
      steps: [{ kind: 'askQuestion', question: 'Какой?', options: ['Справа', 'Снизу'] }],
      canUseTool: async (name, _input, ctx) => {
        order.push(`ask:${name}:${ctx.toolUseID}`)
        return { behavior: 'allow' as const }
      }
    })
    for await (const m of driver.messages) {
      for (const use of toolUses([m])) order.push(`tool_use:${use.name}:${use.id}`)
      if (m['type'] === 'result') break
    }

    expect(order).toHaveLength(2)
    const id = order[0]!.split(':')[2]
    expect(order).toEqual([`tool_use:AskUserQuestion:${id}`, `ask:AskUserQuestion:${id}`])
  })

  test('ответ на вопрос через updatedInput.answers попадает в tool_result', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'askQuestion', question: 'Какой?', options: ['Справа', 'Снизу'] }],
      canUseTool: async (_name, input): Promise<Answer> => ({
        behavior: 'allow',
        updatedInput: { ...input, answers: { 'Какой?': 'Справа' } }
      })
    })
    const out = await collect(driver)

    const result = toolResults(out)[0]!
    expect(result['tool_use_id']).toBe(toolUses(out)[0]!.id)
    expect(result['is_error']).toBeUndefined()
    expect(String(result['content'])).toContain('Справа')
    expect(driver.questionAnswers).toEqual([{ 'Какой?': 'Справа' }])
  })

  test('отказ на вопрос — tool_result с is_error', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'askQuestion', question: 'Какой?', options: ['Справа'] }],
      canUseTool: async () => ({ behavior: 'deny' as const, message: 'не сейчас' })
    })
    const out = await collect(driver)

    const result = toolResults(out)[0]!
    expect(result['is_error']).toBe(true)
    expect(String(result['content'])).toContain('не сейчас')
    expect(driver.questionAnswers).toEqual([])
  })

  test('askPermissions спрашивает о всех инструментах сразу, у каждого свой id', async () => {
    const calls: Array<{ name: string; ctx: Ctx; resolve: (a: Answer) => void }> = []
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'askPermissions',
          tools: [
            { name: 'Bash', input: { command: 'npm test' } },
            { name: 'Edit', input: { file_path: 'a.ts' } }
          ]
        }
      ],
      canUseTool: (name, _input, ctx) =>
        new Promise<Answer>((resolve) => calls.push({ name, ctx, resolve }))
    })
    const reading = collect(driver)

    // Both questions are open before either is answered.
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 2000 })
    expect(calls.map((c) => c.name)).toEqual(['Bash', 'Edit'])
    expect(calls[0]!.ctx.toolUseID).not.toBe(calls[1]!.ctx.toolUseID)

    for (const call of calls) call.resolve({ behavior: 'allow' })
    const out = await reading

    expect(driver.executedTools).toEqual(['Bash', 'Edit'])
    expect(toolUses(out)).toEqual([
      { id: calls[0]!.ctx.toolUseID, name: 'Bash' },
      { id: calls[1]!.ctx.toolUseID, name: 'Edit' }
    ])
    // One assistant message carries both calls, as the real one would.
    const withTools = out.filter((m) => m['type'] === 'assistant' && toolUses([m]).length > 0)
    expect(withTools).toHaveLength(1)
  })

  test('interrupt абортит сигнал открытого вопроса', async () => {
    let signal: AbortSignal | undefined
    const driver = createFakeSdk({
      steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }],
      canUseTool: (_name, _input, ctx) => {
        signal = ctx.signal
        return new Promise<Answer>(() => undefined)
      }
    })
    const reading = collect(driver)

    await vi.waitFor(() => expect(signal).toBeDefined(), { timeout: 2000 })
    expect(signal!.aborted).toBe(false)
    await driver.interrupt()
    expect(signal!.aborted).toBe(true)

    // An aborted question no longer holds the turn open, and nothing ran.
    await reading
    expect(driver.executedTools).toEqual([])
  })
})
