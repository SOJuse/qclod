import { describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    // Silent until spoken to, as the real CLI is.
    driver.send({ text: 'привет', attachments: [] })
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

  test('crash с times падает только первые times запусков (счётчик в QCLOD_USER_DATA)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-fake-crash-'))
    vi.stubEnv('QCLOD_USER_DATA', dir)
    try {
      const script = {
        steps: [],
        nextTurn: [
          { kind: 'crash' as const, message: 'Not logged in · Please run /login', times: 1 },
          { kind: 'text' as const, text: 'вторая сессия' }
        ]
      }
      const first = createFakeSdk(script)
      first.send({ text: 'привет', attachments: [] })
      await expect(collect(first)).rejects.toThrow('Not logged in')
      expect(existsSync(join(dir, 'fake-sdk-crashes.json'))).toBe(true)

      const second = createFakeSdk(script)
      second.send({ text: 'привет', attachments: [] })
      const said = await collect(second)
      expect(said.some((m) => JSON.stringify(m).includes('вторая сессия'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('crash с times без QCLOD_USER_DATA падает всегда, как раньше', async () => {
    vi.stubEnv('QCLOD_USER_DATA', '')
    try {
      for (let i = 0; i < 2; i++) {
        const driver = createFakeSdk({ steps: [{ kind: 'crash', message: 'агент умер', times: 1 }] })
        await expect(collect(driver)).rejects.toThrow('агент умер')
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('crash с beforeInit падает до system/init: сессия так и не представилась', async () => {
    const driver = createFakeSdk({
      steps: [],
      nextTurn: [{ kind: 'crash', message: 'Not logged in · Please run /login', beforeInit: true }]
    })
    driver.send({ text: 'привет', attachments: [] })
    const seen: Array<Record<string, unknown>> = []
    await expect(async () => {
      for await (const m of driver.messages) seen.push(m)
    }).rejects.toThrow('Not logged in')
    expect(seen).toEqual([])
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
    const driver = createFakeSdk({ steps: [{ kind: 'text', text: 'первый ход' }] })
    const seen: string[] = []
    const reader = (async () => {
      for await (const m of driver.messages) seen.push(String(m['type']))
    })()

    await vi.waitFor(() => expect(seen).toContain('result'), { timeout: 2000 })
    await driver.dispose()
    await reader

    expect(seen.at(-1)).toBe('result')
    expect(driver.disposed).toBe(true)
  })

  test('dispose отпускает и поток, который ещё ничего не сказал', async () => {
    const driver = createFakeSdk({ steps: [] })
    const seen: string[] = []
    const reader = (async () => {
      for await (const m of driver.messages) seen.push(String(m['type']))
    })()

    await driver.dispose()
    await reader

    expect(seen).toEqual([])
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

type Message = Record<string, unknown>

/**
 * Reads the stream in pieces: what arrived within a window, or everything up
 * to a message that matches. One pending read carries over between calls, so
 * nothing is lost when a window closes on an empty stream.
 */
function streamReader(driver: { messages: AsyncIterable<Message> }) {
  const it = driver.messages[Symbol.asyncIterator]()
  let pending: Promise<IteratorResult<Message>> | null = null
  const out: Message[] = []
  const next = (): Promise<IteratorResult<Message>> => (pending ??= it.next())
  return {
    out,
    async within(ms: number): Promise<void> {
      const until = Date.now() + ms
      for (;;) {
        const left = until - Date.now()
        if (left <= 0) return
        const got = await Promise.race([
          next(),
          new Promise<null>((r) => setTimeout(() => r(null), left))
        ])
        if (got === null) return
        pending = null
        if (got.done) return
        out.push(got.value)
      }
    },
    async until(match: (m: Message) => boolean): Promise<void> {
      for (;;) {
        const got = await next()
        pending = null
        if (got.done) throw new Error('поток кончился раньше')
        out.push(got.value)
        if (match(got.value)) return
      }
    }
  }
}

const isResult = (m: Message): boolean => m['type'] === 'result'

describe('createFakeSdk: молчит до первого сообщения, как CLI 2.1.317', () => {
  test('без steps фейк не выдаёт ничего, пока не пришло сообщение', async () => {
    const driver = createFakeSdk({})
    const reader = streamReader(driver)

    await reader.within(100)
    expect(reader.out).toEqual([])

    driver.send({ text: 'привет', attachments: [] })
    await reader.until(isResult)
    expect(kinds(reader.out)).toEqual(['system/init', 'rate_limit_event', 'user', 'result/success'])
    const echo = reader.out[2]!['message'] as { content: unknown }
    expect(echo.content).toBe('привет')
    await driver.dispose()
  })

  test('result до первого сообщения не приходит никогда', async () => {
    const driver = createFakeSdk({ steps: [], nextTurn: [{ kind: 'text', text: 'ответ' }] })
    const reader = streamReader(driver)

    await reader.within(150)
    expect(reader.out).toHaveLength(0)

    driver.send({ text: 'привет', attachments: [] })
    await reader.until(isResult)
    // Exactly one result, and it closes the turn the message opened.
    expect(reader.out.filter(isResult)).toHaveLength(1)
    expect(kinds(reader.out)).toEqual([
      'system/init',
      'rate_limit_event',
      'user',
      'assistant',
      'result/success'
    ])
    await driver.dispose()
  })

  test('init и лимиты приходят один раз, в начале первого хода', async () => {
    const driver = createFakeSdk({ steps: [] })
    const reader = streamReader(driver)
    driver.send({ text: 'раз', attachments: [] })
    await reader.until(isResult)
    driver.send({ text: 'два', attachments: [] })
    await reader.until(isResult)

    expect(kinds(reader.out)).toEqual([
      'system/init',
      'rate_limit_event',
      'user',
      'result/success',
      'user',
      'result/success'
    ])
    await driver.dispose()
  })

  test('со steps ход играется сразу и начинается с init и лимитов', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'text', text: 'привет' }] })
    expect(kinds(await collect(driver))).toEqual([
      'system/init',
      'rate_limit_event',
      'assistant',
      'result/success'
    ])
  })
})

describe('createFakeSdk: контекст и лимиты по запросу', () => {
  test('getContextUsage знает модель', async () => {
    const driver = createFakeSdk({})
    expect((await driver.getContextUsage()).model).toBe('claude-opus-5')
    await driver.setModel('claude-sonnet-5')
    expect((await driver.getContextUsage()).model).toBe('claude-sonnet-5')
  })

  test('getContextUsage берёт модель из init сценария', async () => {
    const driver = createFakeSdk({ init: { model: 'claude-sonnet-5' } })
    expect((await driver.getContextUsage()).model).toBe('claude-sonnet-5')
  })

  test('contextUsageDelayMs задерживает ответ', async () => {
    const driver = createFakeSdk({ contextUsageDelayMs: 120 })
    const began = Date.now()
    const usage = await driver.getContextUsage()
    expect(Date.now() - began).toBeGreaterThanOrEqual(100)
    expect(usage.percentage).toBe(21)
  })

  test('contextPercentByTurn меняет процент после каждого хода, последний держится', async () => {
    const driver = createFakeSdk({ steps: [], contextPercent: 10, contextPercentByTurn: [82, 92] })
    expect((await driver.getContextUsage()).percentage).toBe(10)
    // One iterator for all three turns: breaking out of for-await would close the stream.
    const stream = (driver.messages as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]()
    const percents: number[] = []
    for (const text of ['один', 'два', 'три']) {
      driver.send({ text, attachments: [] })
      for (let next = await stream.next(); next.value?.['type'] !== 'result'; next = await stream.next());
      percents.push((await driver.getContextUsage()).percentage)
    }
    expect(percents).toEqual([82, 92, 92])
    expect((await driver.getContextUsage()).totalTokens).toBe(184000)
  })

  test('planLimits по умолчанию — те же окна, что в rate_limit_event', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'text', text: 'ок' }] })
    const event = (await collect(driver)).find((m) => m['type'] === 'rate_limit_event') as {
      rate_limit_info: { unifiedWindows: { five_hour: object; seven_day: object } }
    }
    const limits = await driver.planLimits()
    expect(limits).toEqual({
      fiveHour: event.rate_limit_info.unifiedWindows.five_hour,
      sevenDay: event.rate_limit_info.unifiedWindows.seven_day
    })
    expect(limits!.fiveHour!.utilization).toBe(0.13)
    expect(limits!.sevenDay!.utilization).toBe(0.38)
  })

  test('planLimits из сценария, null — это null', async () => {
    const custom = createFakeSdk({
      planLimits: { fiveHour: { utilization: 0.5, resetsAt: 1794322800 }, sevenDay: null }
    })
    await expect(custom.planLimits()).resolves.toEqual({
      fiveHour: { utilization: 0.5, resetsAt: 1794322800 },
      sevenDay: null
    })
    await expect(createFakeSdk({ planLimits: null }).planLimits()).resolves.toBeNull()
  })
})

function toolResultOf(m: Message): Record<string, unknown> | undefined {
  const content = (m['message'] as { content: unknown } | undefined)?.content
  if (m['type'] !== 'user' || !Array.isArray(content)) return undefined
  return (content as Array<Record<string, unknown>>).find((b) => b['type'] === 'tool_result')
}

function resultText(block: Record<string, unknown>): string {
  const content = block['content']
  if (typeof content === 'string') return content
  return (content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n')
}

describe('createFakeSdk: фоновый подагент', () => {
  test('backgroundAgent: async_launched, потом task_started, progress и notification', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'backgroundAgent',
          name: 'Прогон тестов',
          agentType: 'general-purpose',
          progress: [{ tokens: 500, toolUses: 2, durationMs: 3000, lastTool: 'Bash' }],
          finish: { status: 'completed', summary: 'готово', tokens: 900, toolUses: 4, durationMs: 9000 }
        }
      ]
    })
    const reader = streamReader(driver)
    await reader.until((m) => m['origin'] !== undefined)
    const out = reader.out

    // Ruling C2: the turn that launched the agent ends first; the agent's
    // progress and its notification come after that turn's result.
    expect(kinds(out)).toEqual([
      'system/init',
      'rate_limit_event',
      'assistant',
      'user',
      'system/task_started',
      'result/success',
      'system/task_progress',
      'system/task_notification',
      'user'
    ])

    const [call] = toolUses(out)
    expect(call!.name).toBe('Agent')
    const callBlock = (out[2]!['message'] as { content: Array<Record<string, unknown>> }).content[0]!
    expect(callBlock['input']).toEqual({
      description: 'Прогон тестов',
      subagent_type: 'general-purpose',
      run_in_background: true
    })
    const id = call!.id

    const launched = out[3]!
    const result = toolResultOf(launched)!
    expect(result['tool_use_id']).toBe(id)
    const launchedOutput = launched['tool_use_result'] as Record<string, unknown>
    const agentId = String(launchedOutput['agentId'])
    expect(agentId).toMatch(/^a[0-9a-f]{16}$/)
    expect(launchedOutput).toEqual(
      expect.objectContaining({
        isAsync: true,
        status: 'async_launched',
        agentId,
        description: 'Прогон тестов',
        outputFile: expect.any(String)
      })
    )
    expect(resultText(result).startsWith('Async agent launched successfully.')).toBe(true)
    expect(resultText(result)).toContain(`agentId: ${agentId}`)

    expect(out[4]).toEqual(
      expect.objectContaining({
        subtype: 'task_started',
        task_id: agentId,
        tool_use_id: id,
        description: 'Прогон тестов',
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
        is_backgrounded: true
      })
    )
    expect(out[6]).toEqual(
      expect.objectContaining({
        subtype: 'task_progress',
        task_id: agentId,
        tool_use_id: id,
        usage: { total_tokens: 500, tool_uses: 2, duration_ms: 3000 },
        last_tool_name: 'Bash'
      })
    )
    expect(out[7]).toEqual(
      expect.objectContaining({
        subtype: 'task_notification',
        task_id: agentId,
        tool_use_id: id,
        status: 'completed',
        summary: 'готово',
        output_file: launchedOutput['outputFile'],
        usage: { total_tokens: 900, tool_uses: 4, duration_ms: 9000 }
      })
    )

    const notice = out[8]!
    expect(notice['origin']).toEqual({ kind: 'task-notification' })
    const text = (notice['message'] as { content: unknown }).content
    expect(text).toBe(
      `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n` +
        `<output-file>${String(launchedOutput['outputFile'])}</output-file>\n<status>completed</status>\n` +
        `<summary>готово</summary>\n<usage><subagent_tokens>900</subagent_tokens><tool_uses>4</tool_uses>` +
        `<duration_ms>9000</duration_ms></usage>\n</task-notification>`
    )
    await driver.dispose()
  })

  test('backgroundAgent с finish: null не присылает уведомления', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'backgroundAgent',
          name: 'Долгий обзор',
          agentId: 'a0123456789abcdef',
          progress: [{ tokens: 100, toolUses: 1, durationMs: 1000 }],
          finish: null
        }
      ]
    })
    const reader = streamReader(driver)
    await reader.until((m) => m['subtype'] === 'task_progress')
    await reader.within(150)

    expect(kinds(reader.out)).toEqual([
      'system/init',
      'rate_limit_event',
      'assistant',
      'user',
      'system/task_started',
      'result/success',
      'system/task_progress'
    ])
    expect(reader.out[4]!['task_id']).toBe('a0123456789abcdef')
    expect(reader.out.some((m) => m['origin'] !== undefined)).toBe(false)
    await driver.dispose()
  })

  test('pauseMs разносит события по времени', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'backgroundAgent',
          name: 'Прогон тестов',
          pauseMs: 40,
          finish: { status: 'failed', summary: 'упал', tokens: 10, toolUses: 1, durationMs: 100 }
        }
      ]
    })
    const reader = streamReader(driver)
    await reader.until(isResult)
    const turnEnded = Date.now()
    await reader.until((m) => m['subtype'] === 'task_notification')

    expect(Date.now() - turnEnded).toBeGreaterThanOrEqual(30)
    expect(reader.out.at(-1)!['status']).toBe('failed')
    await driver.dispose()
  })
})

describe('createFakeSdk: подагент на переднем плане', () => {
  test('subagent отдаёт totalTokens/totalDurationMs/totalToolUseCount', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'subagent',
          name: 'Обзор вставки',
          agentType: 'Explore',
          stats: { totalTokens: 18000, totalDurationMs: 42000, totalToolUseCount: 7 },
          steps: [{ kind: 'text', text: 'смотрю' }]
        }
      ]
    })
    const out = await collect(driver)
    const finished = out.find((m) => toolResultOf(m) !== undefined)!
    const output = finished['tool_use_result'] as Record<string, unknown>

    expect(toolResultOf(finished)!['tool_use_id']).toBe(toolUses(out)[0]!.id)
    expect(output).toEqual(
      expect.objectContaining({
        status: 'completed',
        agentId: expect.stringMatching(/^a[0-9a-f]{16}$/),
        totalTokens: 18000,
        totalDurationMs: 42000,
        totalToolUseCount: 7,
        prompt: 'Обзор вставки',
        usage: expect.objectContaining({ input_tokens: 0, output_tokens: 0 }),
        content: [{ type: 'text', text: 'подагент закончил' }]
      })
    )
  })

  test('subagent без stats всё равно отдаёт AgentOutput', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'subagent', name: 'Обзор', steps: [] }]
    })
    const out = await collect(driver)
    const output = out.find((m) => toolResultOf(m) !== undefined)!['tool_use_result'] as Record<
      string,
      unknown
    >
    expect(output['status']).toBe('completed')
    expect(output['totalTokens']).toBe(0)
    expect(output['totalDurationMs']).toBe(0)
    expect(output['totalToolUseCount']).toBe(0)
  })
})

describe('createFakeSdk: структурный выход инструмента', () => {
  test('шаг tool с output отдаёт tool_use_result', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'tool',
          name: 'Bash',
          input: { command: 'ls' },
          result: 'a',
          output: { stdout: 'a', stderr: '', interrupted: false }
        }
      ]
    })
    driver.send({ text: 'go', attachments: [] })
    const result = (await collect(driver)).find((m) => m['tool_use_result'] !== undefined)!
    expect(result['tool_use_result']).toEqual({ stdout: 'a', stderr: '', interrupted: false })
    expect(JSON.stringify(result['message'])).toContain('tool_result')
  })

  test('шаг toolError с output отдаёт его рядом с ошибкой', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'toolError',
          name: 'Bash',
          error: 'Exit code 1',
          output: { stdout: '', stderr: 'boom', interrupted: false }
        }
      ]
    })
    driver.send({ text: 'go', attachments: [] })
    const result = (await collect(driver)).find((m) => m['tool_use_result'] !== undefined)!
    expect(result['tool_use_result']).toMatchObject({ stderr: 'boom' })
  })

  test('без output tool_use_result не добавляется', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'tool', name: 'Read', result: 'x' }] })
    driver.send({ text: 'go', attachments: [] })
    expect((await collect(driver)).some((m) => 'tool_use_result' in m)).toBe(false)
  })

  test('шаг tool с pauseMs держит паузу до результата', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'tool', name: 'Bash', pauseMs: 120 }] })
    driver.send({ text: 'go', attachments: [] })
    const stamps: Array<{ kind: string; at: number }> = []
    for await (const m of driver.messages) {
      const content = (m['message'] as { content?: Array<{ type: string }> } | undefined)?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_use' || b.type === 'tool_result') stamps.push({ kind: b.type, at: Date.now() })
        }
      }
      if (m['type'] === 'result') break
    }
    expect(stamps.map((s) => s.kind)).toEqual(['tool_use', 'tool_result'])
    expect(stamps[1]!.at - stamps[0]!.at).toBeGreaterThanOrEqual(100)
  })

  test('шаг thinking с ms идёт потоком и держит паузу до конца блока', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'thinking', text: 'думаю', ms: 120 }] })
    driver.send({ text: 'go', attachments: [] })
    const seen: Array<{ what: string; at: number }> = []
    let wholeId = ''
    let startId = ''
    for await (const m of driver.messages) {
      if (m['type'] === 'stream_event') {
        const e = m['event'] as { type: string; message?: { id: string }; delta?: { type: string } }
        if (e.type === 'message_start') startId = e.message!.id
        seen.push({ what: e.type === 'content_block_delta' ? e.delta!.type : e.type, at: Date.now() })
      }
      if (m['type'] === 'assistant') wholeId = (m['message'] as { id: string }).id
      if (m['type'] === 'result') break
    }
    expect(seen.map((x) => x.what)).toEqual(['message_start', 'thinking_delta', 'content_block_stop'])
    expect(seen[2]!.at - seen[0]!.at).toBeGreaterThanOrEqual(100)
    expect(wholeId).toBe(startId)
  })
})

describe('createFakeSdk: reportInput', () => {
  test('говорит, сколько картинок, каких типов и байт пришло в последнем send', async () => {
    const driver = createFakeSdk({ steps: [], nextTurn: [{ kind: 'reportInput' }] })
    driver.send({
      text: 'смотри',
      attachments: [
        { kind: 'image', mediaType: 'image/png', dataBase64: Buffer.alloc(10).toString('base64') },
        { kind: 'file', path: 'C:/a.ts' },
        { kind: 'image', mediaType: 'image/jpeg', dataBase64: Buffer.alloc(5).toString('base64') }
      ]
    })
    const said = (await collect(driver))
      .filter((m) => m['type'] === 'assistant')
      .flatMap((m) => (m['message'] as { content: Array<{ text?: string }> }).content)
      .map((b) => b.text)
    expect(said).toEqual(['картинок: 2; типы: image/png, image/jpeg; байт: 15'])
  })
})
