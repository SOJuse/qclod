import { describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeSdk, type FakeScript, type FakeStep } from '../fixtures/fake-sdk/index.mjs'

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

  test('crash с times считает сессии: созданная, но не дошедшая до шага, тоже в счёт', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-fake-crash-'))
    vi.stubEnv('QCLOD_USER_DATA', dir)
    try {
      const script = {
        steps: [],
        nextTurn: [
          { kind: 'crash' as const, message: 'агент умер', times: 1 },
          { kind: 'text' as const, text: 'жив' }
        ]
      }
      createFakeSdk(script)
      const second = createFakeSdk(script)
      second.send({ text: 'привет', attachments: [] })
      const said = await collect(second)
      expect(said.some((m) => JSON.stringify(m).includes('жив'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('limitHit: rejected, assistant с error rate_limit, result is_error — в этом порядке', async () => {
    const before = Math.floor(Date.now() / 1000)
    const driver = createFakeSdk({ steps: [{ kind: 'limitHit', resetsInMs: 3_600_000, type: 'seven_day' }] })
    const got = await collect(driver)
    const order = got
      .map((m) => (m['type'] === 'system' ? null : (m['type'] as string)))
      .filter((t): t is string => t !== null && ['rate_limit_event', 'assistant', 'result'].includes(t))
    // The window-state event of the init comes first and is 'allowed'; the rejection follows.
    const rejected = got.findIndex(
      (m) => m['type'] === 'rate_limit_event' && (m['rate_limit_info'] as Record<string, unknown>)['status'] === 'rejected'
    )
    const assistantAt = got.findIndex((m) => m['type'] === 'assistant' && m['error'] === 'rate_limit')
    const resultAt = got.findIndex((m) => m['type'] === 'result')
    expect(order.length).toBeGreaterThan(2)
    expect(rejected).toBeGreaterThan(-1)
    expect(rejected).toBeLessThan(assistantAt)
    expect(assistantAt).toBeLessThan(resultAt)
    const info = got[rejected]!['rate_limit_info'] as Record<string, unknown>
    expect(info['rateLimitType']).toBe('seven_day')
    expect(info['resetsAt'] as number).toBeGreaterThanOrEqual(before + 3599)
    const result = got[resultAt]!
    expect(result['is_error']).toBe(true)
    expect(String(result['result'])).toContain("You've hit your session limit")
  })

  test('limitHit times 1: второй ход проходит', async () => {
    const driver = createFakeSdk({
      steps: [],
      nextTurn: [{ kind: 'limitHit', resetsInMs: 1000, times: 1 }, { kind: 'text', text: 'дальше' }]
    })
    driver.send({ text: 'раз', attachments: [] })
    driver.send({ text: 'два', attachments: [] })
    const got = await collect(driver, 2)
    const results = got.filter((m) => m['type'] === 'result')
    expect(results.map((r) => r['is_error'])).toEqual([true, false])
    expect(got.filter((m) => m['error'] === 'rate_limit')).toHaveLength(1)
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
  test('turns: i-е сообщение играет turns[i], дальше — nextTurn', async () => {
    const driver = createFakeSdk({
      steps: [],
      turns: [[{ kind: 'text', text: 'ответ один' }], [{ kind: 'text', text: 'ответ два' }]],
      nextTurn: [{ kind: 'text', text: 'ответ потом' }]
    })

    const said: string[] = []
    let results = 0
    const reader = (async () => {
      for await (const m of driver.messages) {
        if (m['type'] === 'assistant') {
          const content = (m['message'] as { content: Array<{ type: string; text?: string }> }).content
          for (const block of content) if (block.type === 'text' && block.text) said.push(block.text)
        }
        if (m['type'] === 'result' && ++results === 3) break
      }
    })()

    driver.send({ text: 'раз', attachments: [] })
    driver.send({ text: 'два', attachments: [] })
    driver.send({ text: 'три', attachments: [] })
    await reader

    expect(said).toEqual(['ответ один', 'ответ два', 'ответ потом'])
  })

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

  test('строки разбивки контекста сходятся с процентом: занятое = totalTokens, всё вместе = maxTokens', async () => {
    for (const [percent, used] of [[13, 26000], [21, 42000], [92, 184000], [99, 198000]] as const) {
      const usage = await createFakeSdk({ steps: [], contextPercent: percent }).getContextUsage()
      const sum = (kind: string): number =>
        usage.categories.filter((c: { kind: string }) => c.kind === kind).reduce((a: number, c: { tokens: number }) => a + c.tokens, 0)
      expect(usage.totalTokens).toBe(used)
      expect(sum('used')).toBe(used)
      expect(sum('used') + sum('buffer') + sum('free')).toBe(usage.maxTokens)
      expect(usage.categories.every((c: { tokens: number }) => c.tokens >= 0)).toBe(true)
    }
    // At 21% the rows are the ones the panel tests and the shots were made with.
    const base = await createFakeSdk({ steps: [] }).getContextUsage()
    expect(base.categories.map((c: { tokens: number }) => c.tokens)).toEqual([30000, 12000, 9000, 149000, 700])
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

describe('createFakeSdk: фоновая команда', () => {
  test('backgroundBash: Bash в фоне, task_started local_bash, вывод копится после result, потом уведомление', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'backgroundBash',
          command: 'npm run dev',
          description: 'Сервер',
          taskId: 'b1',
          chunks: ['готово 1\n', 'готово 2\n'],
          pauseMs: 20,
          finish: 'completed'
        }
      ]
    })
    const reader = streamReader(driver)
    await reader.until(isResult)
    expect(kinds(reader.out)).toEqual([
      'system/init',
      'rate_limit_event',
      'assistant',
      'user',
      'system/task_started',
      'system/background_tasks_changed',
      'result/success'
    ])
    const call = (reader.out[2]!['message'] as { content: Array<Record<string, unknown>> }).content[0]!
    expect(call).toMatchObject({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'npm run dev', description: 'Сервер', run_in_background: true }
    })
    const result = reader.out[3]!
    expect((result['message'] as { content: Array<Record<string, unknown>> }).content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: call['id'],
      content: 'Command running in background with ID: b1'
    })
    expect(result['tool_use_result']).toEqual({
      stdout: '',
      stderr: '',
      interrupted: false,
      backgroundTaskId: 'b1'
    })
    expect(reader.out[4]).toMatchObject({
      task_id: 'b1',
      tool_use_id: call['id'],
      description: 'Сервер',
      task_type: 'local_bash',
      is_backgrounded: true
    })
    expect(reader.out[5]!['tasks']).toEqual([
      { task_id: 'b1', task_type: 'local_bash', description: 'Сервер' }
    ])
    await expect(driver.taskOutput('b1')).resolves.toEqual({ output: '', totalBytes: 0, truncated: false })

    await reader.until((m) => m['subtype'] === 'task_notification')
    expect(reader.out.at(-1)).toMatchObject({ task_id: 'b1', tool_use_id: call['id'], status: 'completed' })
    expect(typeof reader.out.at(-1)!['output_file']).toBe('string')
    await expect(driver.taskOutput('b1')).resolves.toEqual({
      output: 'готово 1\nготово 2\n',
      totalBytes: Buffer.byteLength('готово 1\nготово 2\n'),
      truncated: false
    })
    await reader.until((m) => m['subtype'] === 'background_tasks_changed')
    expect(reader.out.at(-1)!['tasks']).toEqual([])
    await driver.dispose()
  })

  test('taskOutput отдаёт последние 8 КиБ', async () => {
    const big = 'x'.repeat(10000)
    const driver = createFakeSdk({
      steps: [{ kind: 'backgroundBash', command: 'yes', taskId: 'b1', chunks: [big, 'конец'], finish: null }]
    })
    const reader = streamReader(driver)
    await reader.until(isResult)
    await reader.within(50)
    const out = await driver.taskOutput('b1')
    expect(out?.truncated).toBe(true)
    expect(out?.totalBytes).toBe(10000 + Buffer.byteLength('конец'))
    expect(Buffer.byteLength(out!.output)).toBeLessThanOrEqual(8192)
    expect(out!.output.endsWith('конец')).toBe(true)
    await expect(driver.taskOutput('нет-такой')).resolves.toBeNull()
    await driver.dispose()
  })

  test('stopTask: уведомление stopped и пустой список вне хода, вывод больше не растёт', async () => {
    const driver = createFakeSdk({
      steps: [
        { kind: 'backgroundBash', command: 'npm run dev', taskId: 'b1', chunks: ['раз\n', 'два\n'], pauseMs: 300, finish: 'completed' }
      ]
    })
    const reader = streamReader(driver)
    await reader.until(isResult)
    await driver.stopTask('b1')
    await reader.until((m) => m['subtype'] === 'task_notification')
    expect(reader.out.at(-1)).toMatchObject({ task_id: 'b1', status: 'stopped' })
    await reader.until((m) => m['subtype'] === 'background_tasks_changed')
    expect(reader.out.at(-1)!['tasks']).toEqual([])
    await reader.within(700)
    // No second notification: the stopped task does not finish again.
    expect(reader.out.filter((m) => m['subtype'] === 'task_notification')).toHaveLength(1)
    expect((await driver.taskOutput('b1'))?.output).not.toContain('два')
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

async function nextMatching(
  messages: AsyncIterable<Message>,
  match: (m: Message) => boolean
): Promise<Message> {
  for await (const m of messages) if (match(m)) return m
  throw new Error('поток кончился раньше')
}

describe('createFakeSdk: Remote Control', () => {
  test('включение отвечает ссылкой и шлёт bridge_state connected', async () => {
    const d = createFakeSdk({})
    const link = await d.setRemoteControl(true, 'Qclod — проект')
    expect(link?.sessionUrl).toMatch(/^https:\/\/claude\.ai\//)
    expect(d.remoteCalls).toEqual([{ enabled: true, name: 'Qclod — проект' }])
    const m = await nextMatching(d.messages, (x) => x['subtype'] === 'bridge_state')
    expect(m).toMatchObject({ type: 'system', state: 'connected', bridge_epoch: 1, detail: null })
  })

  test('выключение шлёт worker_shutting_down remote_control_disabled', async () => {
    const d = createFakeSdk({})
    expect(await d.setRemoteControl(false)).toBeNull()
    expect(d.remoteCalls).toEqual([{ enabled: false }])
    const m = await nextMatching(d.messages, (x) => x['subtype'] === 'worker_shutting_down')
    expect(m).toMatchObject({ type: 'system', reason: 'remote_control_disabled' })
  })

  test('blocked и enableError', async () => {
    expect(await createFakeSdk({ remoteControl: { blocked: 'api_key' } }).remoteAvailability()).toEqual({
      available: false,
      reason: 'api_key'
    })
    expect(await createFakeSdk({}).remoteAvailability()).toEqual({ available: true })
    await expect(
      createFakeSdk({ remoteControl: { enableError: 'нет подписки' } }).setRemoteControl(true)
    ).rejects.toThrow('нет подписки')
  })

  test('sessionUrl и failed получают failure_kind', async () => {
    const d = createFakeSdk({
      remoteControl: { sessionUrl: 'https://claude.ai/code/session_x', bridge: [{ state: 'failed' }] }
    })
    expect((await d.setRemoteControl(true))?.sessionUrl).toBe('https://claude.ai/code/session_x')
    const m = await nextMatching(d.messages, (x) => x['subtype'] === 'bridge_state')
    expect(m).toMatchObject({ state: 'failed', failure_kind: 'terminal' })
  })

  test('ход с телефона: user-сообщение, шаги, result; в sent не попадает', async () => {
    const d = createFakeSdk({})
    d.typeOnPhone('привет с телефона', [{ kind: 'text', text: 'ответ' }])
    const got = await collect(d)
    const user = got.find((m) => m['type'] === 'user') as { message: { content: string } }
    expect(user.message.content).toBe('привет с телефона')
    expect(kinds(got)).toContain('assistant')
    expect(d.sent).toHaveLength(0)
  })

  test('phoneTurns играются после включения', async () => {
    const d = createFakeSdk({
      remoteControl: { phoneTurns: [{ text: 'с телефона', steps: [{ kind: 'text', text: 'ок' }] }] }
    })
    await d.setRemoteControl(true)
    const got = await collect(d)
    expect(kinds(got)).toContain('system/bridge_state')
    expect(got.some((m) => m['type'] === 'user')).toBe(true)
  })

  test('remoteAnswer: сигнал абортится, инструмент выполняется по decision', async () => {
    const seen: AbortSignal[] = []
    const d = createFakeSdk({
      steps: [{ kind: 'remoteAnswer', name: 'Bash', input: { command: 'ls' }, decision: 'allow' }],
      canUseTool: (_n, _i, o) => {
        seen.push(o.signal)
        return new Promise(() => {})
      }
    })
    await collect(d)
    expect(seen[0]!.aborted).toBe(true)
    expect(d.executedTools).toContain('Bash')
  })

  test('remoteAnswer: ответ Qclod до afterMs игнорируется, сигнал всё равно абортится', async () => {
    const seen: AbortSignal[] = []
    const d = createFakeSdk({
      steps: [{ kind: 'remoteAnswer', name: 'Bash', decision: 'allow' }],
      canUseTool: async (_n, _i, o) => {
        seen.push(o.signal)
        return { behavior: 'deny' }
      }
    })
    const got = await collect(d)
    expect(seen[0]!.aborted).toBe(true)
    expect(d.executedTools).toContain('Bash')
    expect(kinds(got)).not.toContain('permission_denied')
  })

  test('remoteAnswer deny: permission_denied, инструмент не выполняется', async () => {
    const d = createFakeSdk({
      steps: [{ kind: 'remoteAnswer', name: 'Bash', decision: 'deny' }],
      canUseTool: () => new Promise(() => {})
    })
    expect(kinds(await collect(d))).toContain('permission_denied')
    expect(d.executedTools).not.toContain('Bash')
  })
})

type Frame = Record<string, unknown>

/** Reads one stream across several calls, so a test can send between frames. */
function reader(driver: { messages: AsyncIterable<Frame> }) {
  const it = driver.messages[Symbol.asyncIterator]()
  return {
    async next(): Promise<Frame> {
      const r = await it.next()
      if (r.done) throw new Error('stream ended')
      return r.value
    },
    /** Frames up to and including the first one that `stop` accepts. */
    async until(stop: (m: Frame) => boolean): Promise<Frame[]> {
      const out: Frame[] = []
      for (;;) {
        const m = await this.next()
        out.push(m)
        if (stop(m)) return out
      }
    }
  }
}

const isType = (type: string) => (m: Frame) => m['type'] === type
const lifecycleOf = (frames: Frame[]) =>
  frames
    .filter(isType('command_lifecycle'))
    .map((m) => `${String(m['state'])}:${String(m['command_uuid'])}`)
const shape = (frames: Frame[]) =>
  frames.map((m) =>
    m['type'] === 'command_lifecycle'
      ? `${String(m['state'])}:${String(m['command_uuid'])}`
      : `${String(m['type'])}${m['subtype'] ? '/' + String(m['subtype']) : ''}`
  )
const said = (text: string) => ({ text, attachments: [] })
const frameIs = (state: string, uuid: string) => (m: Frame) =>
  m['state'] === state && m['command_uuid'] === uuid

describe('createFakeSdk: очередь команд CLI', () => {
  const three: FakeStep[] = [
    { kind: 'text', text: 'раз' },
    { kind: 'text', text: 'два' },
    { kind: 'text', text: 'три' }
  ]

  test('сообщение во время хода: queued, затем started до result, completed перед result', async () => {
    const driver = createFakeSdk({ steps: [], turns: [three] })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    const head = await r.until(isType('assistant'))
    driver.send(said('B'), { uuid: 'B' })
    const tail = await r.until(frameIs('completed', 'A'))
    expect(shape(head)).toEqual([
      'queued:A',
      'started:A',
      'system/init',
      'rate_limit_event',
      'user',
      'assistant'
    ])
    // No echo for the folded message; its completed comes before the result,
    // the starter's after it.
    expect(shape(tail)).toEqual([
      'queued:B',
      'started:B',
      'assistant',
      'assistant',
      'completed:B',
      'result/success',
      'completed:A'
    ])
    const result = tail.find(isType('result'))!
    expect(result['user_message_uuids']).toEqual(['A', 'B'])
    expect(result['queued_turn_count']).toBe(0)
    expect(driver.folded).toEqual(['B'])
    const frame = tail[0]!
    expect(frame['session_id']).toEqual(expect.any(String))
    expect(frame['uuid']).toEqual(expect.any(String))
    expect(frame['uuid']).not.toBe('B')
  })

  test('влитое сообщение получает ответ в том же ходе, сразу после started (05a §1)', async () => {
    const driver = createFakeSdk({ steps: [], turns: [three, [{ kind: 'text', text: 'бэ' }]] })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    await r.until(isType('assistant'))
    driver.send(said('B'), { uuid: 'B' })
    const tail = await r.until(frameIs('completed', 'A'))
    const texts = tail
      .filter(isType('assistant'))
      .map((m) => (m['message'] as { content: Array<{ text?: string }> }).content[0]?.text)
    expect(shape(tail)).toEqual([
      'queued:B',
      'started:B',
      'assistant',
      'assistant',
      'assistant',
      'completed:B',
      'result/success',
      'completed:A'
    ])
    // The answer to B comes at the boundary where B was taken, then A's turn goes on.
    expect(texts).toEqual(['бэ', 'два', 'три'])
    expect(tail.filter(isType('result'))).toHaveLength(1)
    expect(tail.find(isType('result'))!['user_message_uuids']).toEqual(['A', 'B'])
  })

  test('send без хода: queued и started до init, ход, result, completed после него', async () => {
    const driver = createFakeSdk({ steps: [], turns: [[{ kind: 'text', text: 'ок' }]] })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    const got = await r.until(frameIs('completed', 'A'))
    expect(shape(got)).toEqual([
      'queued:A',
      'started:A',
      'system/init',
      'rate_limit_event',
      'user',
      'assistant',
      'result/success',
      'completed:A'
    ])
  })

  test('init несёт claude_code_version и capabilities', async () => {
    const driver = createFakeSdk({ steps: [], turns: [[]] })
    driver.send(said('A'))
    const init = (await collect(driver))[0] as Record<string, unknown>
    expect(init['claude_code_version']).toBe('2.1.317')
    expect(init['capabilities']).toEqual([
      'interrupt_receipt_v1',
      'interrupt_cancel_queued_v1',
      'interrupt_send_now_v1',
      'msg_lifecycle_v1'
    ])
    const old = createFakeSdk({ steps: [], turns: [[]], lifecycle: false })
    old.send(said('A'))
    const oldInit = (await collect(old))[0] as Record<string, unknown>
    expect(oldInit['claude_code_version']).toBe('2.1.200')
    expect(oldInit).not.toHaveProperty('capabilities')
  })

  test('cancelAsyncMessage до started — true и cancelled; после — false', async () => {
    const driver = createFakeSdk({ steps: [], turns: [three] })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    await r.until(isType('assistant'))
    driver.send(said('B'), { uuid: 'B' })
    driver.send(said('C'), { uuid: 'C' })
    await expect(driver.cancelAsyncMessage('B')).resolves.toBe(true)
    await expect(driver.cancelAsyncMessage('B')).resolves.toBe(false)
    const tail = await r.until(frameIs('completed', 'A'))
    expect(lifecycleOf(tail)).toEqual([
      'queued:B',
      'queued:C',
      'cancelled:B',
      'started:C',
      'completed:C',
      'completed:A'
    ])
    // C was taken into the turn: too late to cancel.
    await expect(driver.cancelQueued('C')).resolves.toBe(false)
    await expect(driver.cancelQueued('nobody')).resolves.toBe(false)
    expect(driver.folded).toEqual(['C'])
  })

  test('interrupt cancelQueued возвращает uuid всех из очереди', async () => {
    const driver = createFakeSdk({ steps: [], turns: [three] })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    await r.until(isType('assistant'))
    driver.send(said('B'), { uuid: 'B' })
    driver.send(said('C'), { uuid: 'C' })
    await expect(driver.interrupt({ cancelQueued: true })).resolves.toEqual({
      stillQueued: [],
      cancelled: ['B', 'C']
    })
    const tail = await r.until(frameIs('cancelled', 'A'))
    expect(shape(tail)).toEqual([
      'queued:B',
      'queued:C',
      'cancelled:B',
      'cancelled:C',
      'result/error_during_execution',
      'cancelled:A'
    ])
    const result = tail.find(isType('result'))!
    expect(result['subtype']).toBe('error_during_execution')
    expect(result['is_error']).toBe(true)
    expect(result['terminal_reason']).toBe('aborted_tools')
    expect(result['user_message_uuids']).toEqual(['A'])
    expect(driver.folded).toEqual([])
  })

  test('interrupt без флага: очередь остаётся в квитанции и выполнится после прерывания', async () => {
    const driver = createFakeSdk({
      steps: [],
      turns: [three, [{ kind: 'text', text: 'потом' }]]
    })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    await r.until(isType('assistant'))
    driver.send(said('B'), { uuid: 'B' })
    await expect(driver.interrupt()).resolves.toEqual({ stillQueued: ['B'], cancelled: [] })
    const tail = await r.until(frameIs('completed', 'B'))
    expect(shape(tail)).toEqual([
      'queued:B',
      'result/error_during_execution',
      'cancelled:A',
      'started:B',
      'user',
      'assistant',
      'result/success',
      'completed:B'
    ])
    expect(tail.find(isType('result'))!['queued_turn_count']).toBe(1)
  })

  test('cancelQueuedOnInterrupt false: квитанция без cancelled, флаг не слышен, очередь выполнится', async () => {
    const driver = createFakeSdk({
      steps: [],
      turns: [three, [{ kind: 'text', text: 'потом' }]],
      cancelQueuedOnInterrupt: false
    })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    const head = await r.until(isType('assistant'))
    const init = head.find((m) => m['type'] === 'system' && m['subtype'] === 'init')!
    expect(init['capabilities']).not.toContain('interrupt_cancel_queued_v1')
    expect(init['capabilities']).toContain('interrupt_receipt_v1')
    driver.send(said('B'), { uuid: 'B' })
    const receipt = await driver.interrupt({ cancelQueued: true })
    expect(receipt).toEqual({ stillQueued: ['B'] })
    expect(receipt).not.toHaveProperty('cancelled')
    const tail = await r.until(frameIs('completed', 'B'))
    expect(shape(tail)).toContain('started:B')
  })

  test('priority now прерывает ход и начинает новый', async () => {
    const driver = createFakeSdk({
      steps: [],
      turns: [three, [{ kind: 'text', text: 'срочно' }]]
    })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    await r.until(isType('assistant'))
    driver.send(said('N'), { uuid: 'N', priority: 'now' })
    const tail = await r.until(frameIs('completed', 'N'))
    expect(shape(tail)).toEqual([
      'queued:N',
      'result/error_during_execution',
      'cancelled:A',
      'started:N',
      'user',
      'assistant',
      'result/success',
      'completed:N'
    ])
    const [first, second] = tail.filter(isType('result'))
    expect(first!['subtype']).toBe('error_during_execution')
    expect(first!['queued_turn_count']).toBe(1)
    expect(second!['subtype']).toBe('success')
    expect(second!['queued_turn_count']).toBe(0)
  })

  test('lifecycle false: кадров нет, cancelQueued даёт null, сообщение всё равно вливается', async () => {
    const driver = createFakeSdk({ steps: [], turns: [three], lifecycle: false })
    const r = reader(driver)
    driver.send(said('A'), { uuid: 'A' })
    const head = await r.until(isType('assistant'))
    driver.send(said('B'), { uuid: 'B' })
    await expect(driver.cancelQueued('B')).resolves.toBeNull()
    await expect(driver.cancelAsyncMessage('B')).resolves.toBeNull()
    const tail = await r.until(isType('result'))
    expect([...head, ...tail].some(isType('command_lifecycle'))).toBe(false)
    expect(tail.find(isType('result'))!['subtype']).toBe('success')
    expect(driver.folded).toEqual(['B'])
  })

  test('lifecycle false: interrupt не отдаёт квитанции', async () => {
    const driver = createFakeSdk({ steps: [], turns: [three], lifecycle: false })
    await expect(driver.interrupt({ cancelQueued: true })).resolves.toBeUndefined()
  })

  test('phoneCancel: кадр cancelled с чужим uuid', async () => {
    const driver = createFakeSdk({
      steps: [],
      turns: [
        [
          { kind: 'text', text: 'а' },
          { kind: 'tool', name: 'Bash', input: {}, pauseMs: 60 }
        ]
      ],
      phoneCancel: { afterMs: 10, uuid: 'phone-1' }
    })
    driver.send(said('A'), { uuid: 'A' })
    const got = await collect(driver)
    expect(lifecycleOf(got)).toContain('cancelled:phone-1')
  })
})

function agentTexts(messages: Array<Record<string, unknown>>): string[] {
  return messages
    .filter((m) => m['type'] === 'assistant')
    .flatMap((m) => (m['message'] as { content: Array<Record<string, unknown>> }).content)
    .filter((b) => b['type'] === 'text')
    .map((b) => String(b['text']))
}

describe('createFakeSdk: ответы на карточки', () => {
  test('permissionLog пишет каждый ответ canUseTool', async () => {
    const driver = createFakeSdk({
      steps: [
        { kind: 'askPermission', name: 'Bash', input: { command: 'git push' } },
        { kind: 'askQuestion', question: 'Какой?', options: ['Справа'] }
      ],
      canUseTool: async (name, input): Promise<Answer> =>
        name === 'Bash'
          ? { behavior: 'deny', message: 'не трогай main' }
          : { behavior: 'allow', updatedInput: { ...input, answers: { 'Какой?': 'Справа' } } }
    })
    await collect(driver)

    expect(driver.permissionLog).toEqual([
      { name: 'Bash', behavior: 'deny', message: 'не трогай main' },
      {
        name: 'AskUserQuestion',
        behavior: 'allow',
        updatedInput: expect.objectContaining({ answers: { 'Какой?': 'Справа' } })
      }
    ])
  })

  test('plan спрашивает ExitPlanMode с планом; одобрили — вызов с исправленным планом', async () => {
    const asked: Array<[string, Record<string, unknown>]> = []
    const driver = createFakeSdk({
      steps: [{ kind: 'plan', plan: '1. шаг' }],
      canUseTool: async (name, input): Promise<Answer> => {
        asked.push([name, input])
        return { behavior: 'allow', updatedInput: { ...input, plan: '1. другой шаг' } }
      }
    })
    const out = await collect(driver)

    expect(asked).toEqual([['ExitPlanMode', { plan: '1. шаг' }]])
    expect(toolUses(out).map((t) => t.name)).toEqual(['ExitPlanMode'])
    expect(driver.executedTools).toEqual(['ExitPlanMode'])
  })

  test('plan: отказ — tool_result с is_error и текстом отказа', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'plan', plan: '1. шаг' }],
      canUseTool: async () => ({ behavior: 'deny' as const, message: 'сначала тесты' })
    })
    const out = await collect(driver)

    const result = toolResults(out)[0]!
    expect(result['is_error']).toBe(true)
    expect(String(result['content'])).toContain('сначала тесты')
    expect(driver.executedTools).toEqual([])
  })

  test('echo: true у шага плана пишет «Получено:» с plan', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'plan', plan: '1. шаг', echo: true }],
      canUseTool: async (_name, input): Promise<Answer> => ({
        behavior: 'allow',
        updatedInput: { ...input, plan: '1. другой шаг' }
      })
    })
    const out = await collect(driver)

    expect(agentTexts(out)).toEqual([`Получено: ${JSON.stringify({ plan: '1. другой шаг' })}`])
  })

  test('echo: true у разрешения и вопроса пишет message, answers и annotations', async () => {
    const driver = createFakeSdk({
      steps: [
        { kind: 'askPermission', name: 'Bash', input: { command: 'git push' }, echo: true },
        { kind: 'askQuestion', question: 'Какой?', options: ['Справа'], echo: true }
      ],
      canUseTool: async (name, input): Promise<Answer> =>
        name === 'Bash'
          ? { behavior: 'deny', message: 'не трогай main' }
          : {
              behavior: 'allow',
              updatedInput: {
                ...input,
                answers: { 'Какой?': 'Справа' },
                annotations: { 'Какой?': { notes: 'ближе' } }
              }
            }
    })
    const out = await collect(driver)

    expect(agentTexts(out)).toEqual([
      `Получено: ${JSON.stringify({ message: 'не трогай main' })}`,
      `Получено: ${JSON.stringify({ answers: { 'Какой?': 'Справа' }, annotations: { 'Какой?': { notes: 'ближе' } } })}`
    ])
  })

  test('init.claudeCodeVersion меняет claude_code_version в system/init', async () => {
    const driver = createFakeSdk({ steps: [{ kind: 'text', text: 'ок' }], init: { claudeCodeVersion: '2.1.300' } })
    const out = await collect(driver)
    expect(out[0]).toMatchObject({ type: 'system', subtype: 'init', claude_code_version: '2.1.300' })
  })
})

// ---------------------------------------------------------------- этап 4

const RELAY = (ref: string, text: string): string =>
  `Передай агенту ${ref} через SendMessage (to: "${ref}") это сообщение от пользователя, дословно:\n\n${text}`

function sub(m: Message): string {
  return `${String(m['type'])}${m['subtype'] ? '/' + String(m['subtype']) : ''}`
}

function blocksOf(m: Message): Array<Record<string, unknown>> {
  const content = (m['message'] as { content?: unknown } | undefined)?.content
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
}

describe('createFakeSdk: этап 4 — сабагенты', () => {
  test('сабагент на переднем плане: tool_use, task_started local_agent, шаги с agent_id, task_updated completed, tool_result — по порядку', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'subagent',
          name: 'обзор',
          agentType: 'Explore',
          agentId: 'a0000000000000001',
          label: 'scout',
          prompt: 'посмотри src',
          model: 'claude-haiku-5-5',
          steps: [
            { kind: 'textStream', pieces: ['смот', 'рю'] },
            { kind: 'tool', name: 'Read', input: { file_path: 'a.ts' }, result: 'ок' }
          ]
        }
      ]
    })
    const out = await collect(driver)
    const call = toolUses(out).find((t) => t.name === 'Agent')!
    const callMsg = out.find((m) => blocksOf(m).some((b) => b['id'] === call.id))!
    expect(blocksOf(callMsg)[0]!['input']).toMatchObject({
      description: 'обзор',
      subagent_type: 'Explore',
      prompt: 'посмотри src',
      name: 'scout'
    })

    const started = out.find((m) => m['subtype'] === 'task_started')!
    expect(started).toMatchObject({
      task_id: 'a0000000000000001',
      tool_use_id: call.id,
      task_type: 'local_agent',
      is_backgrounded: false,
      spawn_depth: 1,
      subagent_type: 'Explore',
      description: 'обзор',
      prompt: 'посмотри src'
    })
    expect(typeof started['run_id']).toBe('string')
    expect(started['parent_task_id']).toBeUndefined()

    const nested = out.filter((m) => m['parent_tool_use_id'] === call.id)
    expect(nested.length).toBeGreaterThanOrEqual(4) // prompt, text, Read call, Read result
    for (const m of nested) {
      expect(m).toMatchObject({ agent_id: 'a0000000000000001', subagent_type: 'Explore', task_description: 'обзор' })
      expect(typeof m['timestamp']).toBe('string')
    }
    // Проба 05b: stream_event от сабагента не приходит, только целые сообщения.
    expect(nested.some((m) => m['type'] === 'stream_event')).toBe(false)
    expect(nested.some((m) => blocksOf(m).some((b) => b['type'] === 'text' && b['text'] === 'смотрю'))).toBe(true)
    // Его промпт — user-кадр сабагента.
    expect(nested[0]).toMatchObject({ type: 'user', message: { content: 'посмотри src' } })

    const order = out.map(sub)
    const at = (pred: (m: Message) => boolean): number => out.findIndex(pred)
    const iCall = at((m) => m === callMsg)
    const iStarted = at((m) => m === started)
    const iNested = at((m) => m === nested[0])
    const iUpdated = at((m) => m['subtype'] === 'task_updated')
    const iNotice = at((m) => m['subtype'] === 'task_notification')
    const iResult = at((m) => toolResultOf(m)?.['tool_use_id'] === call.id)
    expect(iCall).toBeLessThan(iStarted)
    expect(iStarted).toBeLessThan(iNested)
    expect(iNested).toBeLessThan(iUpdated)
    expect(iUpdated).toBeLessThan(iNotice)
    expect(iNotice).toBeLessThan(iResult)
    expect(order.at(-1)).toBe('result/success')
    expect(out[iUpdated]).toMatchObject({ task_id: 'a0000000000000001', patch: { status: 'completed' } })
    expect(typeof (out[iUpdated]!['patch'] as Record<string, unknown>)['end_time']).toBe('number')
    expect(out[iNotice]).toMatchObject({ task_id: 'a0000000000000001', status: 'completed', tool_use_id: call.id })
    expect(out[iResult]!['tool_use_result']).toMatchObject({
      status: 'completed',
      agentId: 'a0000000000000001',
      resolvedModel: 'claude-haiku-5-5'
    })
  })

  test('forwardSubagentText false убирает текст сабагента, вызовы остаются', async () => {
    const driver = createFakeSdk({
      forwardSubagentText: false,
      steps: [
        {
          kind: 'subagent',
          name: 'обзор',
          steps: [
            { kind: 'thinking', text: 'думаю' },
            { kind: 'text', text: 'вижу' },
            { kind: 'tool', name: 'Grep', input: { pattern: 'x' }, result: 'ок' }
          ]
        },
        { kind: 'text', text: 'главный пишет' }
      ]
    })
    const out = await collect(driver)
    const call = toolUses(out).find((t) => t.name === 'Agent')!
    const nested = out.filter((m) => m['parent_tool_use_id'] === call.id && m['type'] === 'assistant')
    const types = nested.flatMap((m) => blocksOf(m).map((b) => b['type']))
    expect(types).toEqual(['tool_use'])
    // Главный агент свой текст пишет как прежде.
    expect(
      out.some((m) => m['parent_tool_use_id'] == null && blocksOf(m).some((b) => b['text'] === 'главный пишет'))
    ).toBe(true)
  })

  test('task_progress несёт summary', async () => {
    const driver = createFakeSdk({
      steps: [
        {
          kind: 'backgroundAgent',
          name: 'фон',
          agentId: 'a00000000000000b1',
          progress: [{ tokens: 10, toolUses: 1, durationMs: 100, summary: 'читает тесты', lastTool: 'Read' }],
          finish: { status: 'completed', summary: 'готово', tokens: 20, toolUses: 2, durationMs: 200 }
        },
        {
          kind: 'subagent',
          name: 'передний',
          agentId: 'a00000000000000f1',
          progress: [{ tokens: 5, toolUses: 1, durationMs: 50, summary: 'смотрит код' }],
          steps: []
        }
      ]
    })
    const reader = streamReader(driver)
    await reader.until((m) => m['subtype'] === 'task_notification' && m['task_id'] === 'a00000000000000b1')
    const started = reader.out.find((m) => m['subtype'] === 'task_started' && m['task_id'] === 'a00000000000000b1')!
    expect(typeof started['run_id']).toBe('string')
    const progress = reader.out.filter((m) => m['subtype'] === 'task_progress')
    expect(progress.find((m) => m['task_id'] === 'a00000000000000b1')).toMatchObject({
      summary: 'читает тесты',
      last_tool_name: 'Read'
    })
    expect(progress.find((m) => m['task_id'] === 'a00000000000000f1')).toMatchObject({ summary: 'смотрит код' })
    await driver.dispose()
  })

  test('backgroundTask уводит работающего в фон и сразу отдаёт async_launched; чужой id — false; выключенный фон — ошибка', async () => {
    const driver = createFakeSdk({
      steps: [
        { kind: 'subagent', name: 'долгий', agentId: 'a00000000000000c1', holdMs: 60_000, steps: [] },
        { kind: 'text', text: 'дальше' }
      ]
    })
    const reader = streamReader(driver)
    await reader.until((m) => m['subtype'] === 'task_started')
    const toolUseId = String(reader.out.at(-1)!['tool_use_id'])
    await reader.within(50)
    expect(reader.out.some((m) => toolResultOf(m) !== undefined)).toBe(false)

    expect(await driver.backgroundTask('чужой')).toBe(false)
    expect(await driver.backgroundTask(toolUseId)).toBe(true)
    await reader.until((m) => toolResultOf(m)?.['tool_use_id'] === toolUseId)
    const launched = reader.out.at(-1)!
    expect(launched['tool_use_result']).toMatchObject({
      status: 'async_launched',
      isAsync: true,
      agentId: 'a00000000000000c1',
      description: 'долгий',
      prompt: 'долгий'
    })
    expect(typeof (launched['tool_use_result'] as Record<string, unknown>)['outputFile']).toBe('string')
    const changed = reader.out.find((m) => m['subtype'] === 'background_tasks_changed')!
    expect(changed['tasks']).toEqual([
      expect.objectContaining({ task_id: 'a00000000000000c1', task_type: 'local_agent' })
    ])
    expect(reader.out.find((m) => m['subtype'] === 'task_updated')).toMatchObject({
      task_id: 'a00000000000000c1',
      patch: { is_backgrounded: true }
    })
    // Ход главного идёт дальше, не дожидаясь агента.
    await reader.until(isResult)
    expect(reader.out.some((m) => blocksOf(m).some((b) => b['text'] === 'дальше'))).toBe(true)
    expect(reader.out.some((m) => m['subtype'] === 'task_notification')).toBe(false)
    expect(driver.backgrounded).toEqual(['чужой', toolUseId])
    // Уже в фоне — второй раз не уводится.
    expect(await driver.backgroundTask(toolUseId)).toBe(false)
    await driver.dispose()

    const disabled = createFakeSdk({
      backgroundTasksDisabled: true,
      steps: [{ kind: 'subagent', name: 'долгий', holdMs: 60_000, steps: [] }]
    })
    const r2 = streamReader(disabled)
    await r2.until((m) => m['subtype'] === 'task_started')
    await expect(disabled.backgroundTask(String(r2.out.at(-1)!['tool_use_id']))).rejects.toThrow(
      'background tasks are disabled'
    )
    await disabled.dispose()
  })

  test('stopTask останавливает агента на переднем плане: stopped, killed, tool_result is_error', async () => {
    const driver = createFakeSdk({
      steps: [
        { kind: 'subagent', name: 'долгий', agentId: 'a00000000000000d1', holdMs: 60_000, steps: [] },
        { kind: 'text', text: 'главный продолжил' }
      ]
    })
    const reader = streamReader(driver)
    await reader.until((m) => m['subtype'] === 'task_started')
    const toolUseId = String(reader.out.at(-1)!['tool_use_id'])
    await driver.stopTask('a00000000000000d1')
    await reader.until(isResult)
    const killed = reader.out.findIndex(
      (m) => m['subtype'] === 'task_updated' && (m['patch'] as Record<string, unknown>)['status'] === 'killed'
    )
    const stopped = reader.out.findIndex((m) => m['subtype'] === 'task_notification' && m['status'] === 'stopped')
    const result = reader.out.findIndex((m) => toolResultOf(m)?.['tool_use_id'] === toolUseId)
    expect(killed).toBeGreaterThan(0)
    expect(stopped).toBeGreaterThan(killed)
    expect(result).toBeGreaterThan(stopped)
    expect(toolResultOf(reader.out[result]!)).toMatchObject({ is_error: true })
    expect(resultText(toolResultOf(reader.out[result]!)!)).toContain('Request interrupted by user for tool use')
    expect(reader.out.some((m) => blocksOf(m).some((b) => b['text'] === 'главный продолжил'))).toBe(true)
    expect(driver.stopped).toEqual(['a00000000000000d1'])
    await driver.dispose()
  })

  test('stopTask фонового агента: killed, stopped и список без него, вне хода', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'backgroundAgent', name: 'фон', agentId: 'a00000000000000e1', finish: null }]
    })
    const reader = streamReader(driver)
    await reader.until(isResult)
    await driver.stopTask('a00000000000000e1')
    await reader.until((m) => m['subtype'] === 'background_tasks_changed')
    const tail = reader.out.slice(reader.out.findIndex(isResult))
    expect(tail.find((m) => m['subtype'] === 'task_updated')).toMatchObject({
      task_id: 'a00000000000000e1',
      patch: { status: 'killed' }
    })
    expect(tail.find((m) => m['subtype'] === 'task_notification')).toMatchObject({
      task_id: 'a00000000000000e1',
      status: 'stopped'
    })
    expect(reader.out.at(-1)!['tasks']).toEqual([])
    await driver.dispose()
  })

  test('foregroundStop ignored: stopTask агента на переднем плане ничего не меняет', async () => {
    const driver = createFakeSdk({
      foregroundStop: 'ignored',
      steps: [{ kind: 'subagent', name: 'долгий', agentId: 'a00000000000000d2', holdMs: 150, steps: [] }]
    })
    const reader = streamReader(driver)
    await reader.until((m) => m['subtype'] === 'task_started')
    await driver.stopTask('a00000000000000d2')
    await reader.until(isResult)
    expect(reader.out.some((m) => m['subtype'] === 'task_notification' && m['status'] === 'stopped')).toBe(false)
    expect(reader.out.find((m) => m['subtype'] === 'task_updated')).toMatchObject({ patch: { status: 'completed' } })
    const result = reader.out.find((m) => toolResultOf(m) !== undefined && m['parent_tool_use_id'] == null)!
    expect(toolResultOf(result)!['is_error']).toBeUndefined()
    expect(driver.stopped).toEqual(['a00000000000000d2'])
    await driver.dispose()
  })

  test('поручение: SendMessage с to и message; законченный агент возобновляется тем же task_id с новым run_id', async () => {
    const driver = createFakeSdk({
      steps: [
        { kind: 'subagent', name: 'счётчик', agentId: 'a00000000000000a1', steps: [{ kind: 'text', text: '7' }] }
      ],
      resumeReply: 'восемь'
    })
    const reader = streamReader(driver)
    await reader.until(isResult)
    const firstStart = reader.out.find((m) => m['subtype'] === 'task_started')!
    const agentToolUse = String(firstStart['tool_use_id'])
    const before = reader.out.length

    driver.send({ text: RELAY('a00000000000000a1', 'напиши про 8'), attachments: [] }, { uuid: 'u-relay' })
    await reader.until((m) => m['subtype'] === 'task_notification' && m['tool_use_id'] !== agentToolUse)
    const turn = reader.out.slice(before)
    const calls = toolUses(turn)
    // Проба 05b: SendMessage отложен — сначала ToolSearch.
    expect(calls.map((c) => c.name)).toEqual(['ToolSearch', 'SendMessage'])
    const sendMsg = turn.find((m) => blocksOf(m).some((b) => b['name'] === 'SendMessage'))!
    expect(blocksOf(sendMsg)[0]!['input']).toMatchObject({ to: 'a00000000000000a1', message: 'напиши про 8' })
    expect(driver.relayed).toEqual([{ to: 'a00000000000000a1', message: 'напиши про 8' }])

    const resumed = turn.find((m) => m['subtype'] === 'task_started')!
    expect(resumed).toMatchObject({
      task_id: 'a00000000000000a1',
      is_backgrounded: true,
      tool_use_id: calls[1]!.id,
      prompt: 'напиши про 8'
    })
    expect(resumed['run_id']).not.toBe(firstStart['run_id'])
    // Возобновление — после хода главного.
    expect(turn.findIndex(isResult)).toBeLessThan(turn.indexOf(resumed))
    const reply = turn.find((m) => blocksOf(m).some((b) => b['text'] === 'восемь'))!
    // Проба 05b: кадры второго прогона несут parent_tool_use_id исходного Agent.
    expect(reply).toMatchObject({ agent_id: 'a00000000000000a1', parent_tool_use_id: agentToolUse })
    expect(reader.out.at(-1)).toMatchObject({
      task_id: 'a00000000000000a1',
      status: 'completed',
      tool_use_id: calls[1]!.id
    })
    await reader.until(
      (m) => m['type'] === 'user' && (m['origin'] as Record<string, unknown> | undefined)?.['kind'] === 'task-notification'
    )
    await driver.dispose()
  })

  test('поручение работающему агенту — только relayed, без возобновления; relay false — обычный текст', async () => {
    const driver = createFakeSdk({
      steps: [{ kind: 'backgroundAgent', name: 'фон', agentId: 'a00000000000000a2', finish: null }]
    })
    const reader = streamReader(driver)
    await reader.until(isResult)
    driver.send({ text: RELAY('a00000000000000a2', 'и ещё'), attachments: [] }, { uuid: 'u1' })
    await reader.until(isResult)
    await reader.within(50)
    expect(driver.relayed).toEqual([{ to: 'a00000000000000a2', message: 'и ещё' }])
    expect(reader.out.filter((m) => m['subtype'] === 'task_started')).toHaveLength(1)
    await driver.dispose()

    const deaf = createFakeSdk({ relay: false, steps: [] })
    const r2 = streamReader(deaf)
    deaf.send({ text: RELAY('a1', 'привет'), attachments: [] }, { uuid: 'u2' })
    await r2.until(isResult)
    expect(toolUses(r2.out)).toEqual([])
    expect(deaf.relayed).toEqual([])
    await deaf.dispose()
  })

  test('init без SendMessage при noSendMessage', async () => {
    const withIt = await collect(createFakeSdk({ steps: [{ kind: 'text', text: 'ок' }] }))
    expect(withIt[0]!['tools']).toContain('SendMessage')
    const without = await collect(createFakeSdk({ noSendMessage: true, steps: [{ kind: 'text', text: 'ок' }] }))
    expect(without[0]!['tools']).not.toContain('SendMessage')
  })

  test('nestedToolCalls false: от вложенного только task_started с parent_task_id', async () => {
    const script = (nestedToolCalls?: boolean): FakeScript => ({
      ...(nestedToolCalls === undefined ? {} : { nestedToolCalls }),
      steps: [
        {
          kind: 'subagent',
          name: 'внешний',
          agentId: 'a00000000000000o1',
          steps: [
            {
              kind: 'subagent',
              name: 'внутренний',
              agentId: 'a00000000000000i1',
              steps: [{ kind: 'text', text: 'внутри' }]
            }
          ]
        }
      ]
    })
    const full = await collect(createFakeSdk(script()))
    const inner = full.find((m) => m['subtype'] === 'task_started' && m['task_id'] === 'a00000000000000i1')!
    expect(inner).toMatchObject({ parent_task_id: 'a00000000000000o1', spawn_depth: 2 })
    expect(full.some((m) => m['agent_id'] === 'a00000000000000i1')).toBe(true)
    // Вызов внутреннего Agent — кадр внешнего агента.
    const innerCall = full.find((m) =>
      blocksOf(m).some((b) => b['name'] === 'Agent' && b['id'] === inner['tool_use_id'])
    )!
    expect(innerCall['agent_id']).toBe('a00000000000000o1')

    const hidden = await collect(createFakeSdk(script(false)))
    const started = hidden.find((m) => m['subtype'] === 'task_started' && m['task_id'] === 'a00000000000000i1')!
    expect(started).toMatchObject({ parent_task_id: 'a00000000000000o1', spawn_depth: 2 })
    expect(hidden.some((m) => m['agent_id'] === 'a00000000000000i1')).toBe(false)
    expect(toolUses(hidden).filter((t) => t.name === 'Agent')).toHaveLength(1)
  })
})
