import { describe, expect, test, vi } from 'vitest'
import { createSdkDriver } from '../../src/main/agent/sdkDriver'
import type { DriverOptions } from '../../src/main/agent/driver'
import type { ToolPermissionContext } from '../../src/main/agent/permissionContext'
import { toPermissionContext } from '../../src/main/agent/permissionContext'

/**
 * The real driver, with the SDK's `query()` replaced. Nothing here starts a
 * process: `importEsm` is the one way sdkDriver reaches the SDK, and it is the
 * thing mocked.
 */
const sdk = vi.hoisted(() => {
  const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = []
  /** Methods the next query() object carries besides the basics. */
  const extra: Record<string, unknown> = {}
  function fakeQuery(args: { prompt: unknown; options: Record<string, unknown> }): unknown {
    calls.push(args)
    return {
      close: () => undefined,
      interrupt: async () => undefined,
      return: async () => ({ done: true, value: undefined }),
      ...extra,
      async *[Symbol.asyncIterator]() {
        // An empty session: no message ever arrives.
      }
    }
  }
  return { calls, extra, fakeQuery }
})

vi.mock('../../src/main/esm', () => ({
  importEsm: async () => ({ query: sdk.fakeQuery })
}))

type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>
) => Promise<Record<string, unknown>>

/**
 * Forgets earlier `query()` calls and gives access to the next one: what
 * sdkDriver passed as `prompt` and `options`.
 */
function mockQuery(methods: Record<string, unknown> = {}): {
  readonly prompt: unknown
  readonly options: Record<string, unknown>
  readonly canUseTool: SdkCanUseTool
} {
  sdk.calls.length = 0
  for (const key of Object.keys(sdk.extra)) delete sdk.extra[key]
  Object.assign(sdk.extra, methods)
  const last = (): { prompt: unknown; options: Record<string, unknown> } => {
    const call = sdk.calls.at(-1)
    if (!call) throw new Error('query() was not called')
    return call
  }
  return {
    get prompt() {
      return last().prompt
    },
    get options() {
      return last().options
    },
    get canUseTool() {
      return last().options['canUseTool'] as SdkCanUseTool
    }
  }
}

function driverOptions(canUseTool: DriverOptions['canUseTool']): DriverOptions {
  return { cwd: 'C:/проект', executablePath: 'C:/bin/claude.exe', canUseTool }
}

describe('sdkDriver: canUseTool', () => {
  test('toolUseID и signal из SDK доходят до DriverOptions.canUseTool', async () => {
    const query = mockQuery()
    const seen: ToolPermissionContext[] = []
    const driver = await createSdkDriver(
      driverOptions(async (_name, _input, context) => {
        seen.push(context)
        return { behavior: 'allow' }
      })
    )

    const signal = new AbortController().signal
    await query.canUseTool('Bash', {}, { toolUseID: 'toolu_1', signal, requestId: 'r1' })

    expect(seen).toEqual([{ toolUseId: 'toolu_1', signal }])
    // The same signal, not a copy: aborting it must reach whoever waits.
    expect(seen[0]!.signal).toBe(signal)
    await driver.dispose()
  })

  test('dispose закрывает запрос SDK через close(), а не return()', async () => {
    const close = vi.fn()
    const ret = vi.fn(async () => ({ done: true, value: undefined }))
    mockQuery({ close, return: ret })
    const driver = await createSdkDriver(driverOptions(async () => ({ behavior: 'allow' })))

    await driver.dispose()

    expect(close).toHaveBeenCalledTimes(1)
    expect(ret).not.toHaveBeenCalled()
  })

  test('allow с updatedInput уходит в SDK как updatedInput', async () => {
    const query = mockQuery()
    const driver = await createSdkDriver(
      driverOptions(async (_name, input) => ({
        behavior: 'allow',
        updatedInput: { ...input, answers: { 'Какой?': 'Справа' } }
      }))
    )

    const input = { questions: [{ question: 'Какой?' }] }
    const result = await query.canUseTool('AskUserQuestion', input, {
      toolUseID: 'toolu_2',
      signal: new AbortController().signal
    })

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { questions: [{ question: 'Какой?' }], answers: { 'Какой?': 'Справа' } }
    })
    await driver.dispose()
  })

  test('allow без updatedInput отдаёт SDK исходный ввод, deny — отказ', async () => {
    const query = mockQuery()
    let behavior: 'allow' | 'deny' = 'allow'
    const driver = await createSdkDriver(driverOptions(async () => ({ behavior })))
    const context = { toolUseID: 'toolu_3', signal: new AbortController().signal }

    await expect(query.canUseTool('Bash', { command: 'ls' }, context)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' }
    })
    behavior = 'deny'
    await expect(query.canUseTool('Bash', { command: 'ls' }, context)).resolves.toMatchObject({
      behavior: 'deny'
    })
    await driver.dispose()
  })
})

const USAGE = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'

function usageAnswer(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: {
      total_cost_usd: 0,
      total_api_duration_ms: 0,
      total_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      model_usage: {}
    },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 13, resets_at: '2026-11-10T15:00:00.000Z' },
      seven_day: { utilization: 38, resets_at: '2026-11-14T00:00:00.000Z' }
    },
    behaviors: null,
    ...patch
  }
}

function allowAll(): DriverOptions {
  return driverOptions(async () => ({ behavior: 'allow' }))
}

describe('sdkDriver: лимиты подписки до первого сообщения', () => {
  test('лимиты подписки спрашиваются с skipBehaviors и переводятся в 0..1 и unix-секунды', async () => {
    const usage = vi.fn(async (_opts: unknown) => usageAnswer())
    mockQuery({ [USAGE]: usage })
    const driver = await createSdkDriver(allowAll())

    await expect(driver.planLimits()).resolves.toEqual({
      fiveHour: { utilization: 0.13, resetsAt: 1794322800 },
      sevenDay: { utilization: 0.38, resetsAt: 1794614400 }
    })
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true })
    await driver.dispose()
  })

  test('нет метода usage — null, без исключения', async () => {
    mockQuery()
    const driver = await createSdkDriver(allowAll())
    await expect(driver.planLimits()).resolves.toBeNull()
    await driver.dispose()
  })

  test('rate_limits_available false — null', async () => {
    mockQuery({
      [USAGE]: async () => usageAnswer({ rate_limits_available: false, rate_limits: null })
    })
    const driver = await createSdkDriver(allowAll())
    await expect(driver.planLimits()).resolves.toBeNull()
    await driver.dispose()
  })

  test('rate_limits null при доступных лимитах — тоже null', async () => {
    mockQuery({ [USAGE]: async () => usageAnswer({ rate_limits: null }) })
    const driver = await createSdkDriver(allowAll())
    await expect(driver.planLimits()).resolves.toBeNull()
    await driver.dispose()
  })

  test('окно без процента или без времени сброса — пустое, второе остаётся', async () => {
    mockQuery({
      [USAGE]: async () =>
        usageAnswer({
          rate_limits: {
            five_hour: { utilization: null, resets_at: '2026-11-10T15:00:00.000Z' },
            seven_day: { utilization: 38, resets_at: '2026-11-14T00:00:00.000Z' }
          }
        })
    })
    const driver = await createSdkDriver(allowAll())
    await expect(driver.planLimits()).resolves.toEqual({
      fiveHour: null,
      sevenDay: { utilization: 0.38, resetsAt: 1794614400 }
    })
    await driver.dispose()
  })

  test('исключение из usage — null, наружу не летит', async () => {
    mockQuery({
      [USAGE]: () => {
        throw new Error('not supported by this CLI')
      }
    })
    const driver = await createSdkDriver(allowAll())
    await expect(driver.planLimits()).resolves.toBeNull()
    await driver.dispose()
  })
})

describe('sdkDriver: контекст', () => {
  test('getContextUsage пробрасывает модель', async () => {
    mockQuery({
      getContextUsage: async () => ({
        categories: [{ name: 'Messages', tokens: 10, color: 'x', kind: 'used' }],
        totalTokens: 10,
        maxTokens: 200000,
        rawMaxTokens: 200000,
        percentage: 0,
        gridRows: [],
        model: 'claude-opus-5'
      })
    })
    const driver = await createSdkDriver(allowAll())
    await expect(driver.getContextUsage()).resolves.toMatchObject({
      model: 'claude-opus-5',
      totalTokens: 10
    })
    await driver.dispose()
  })
})

describe('toPermissionContext', () => {
  test('читает только непустой toolUseID и настоящий AbortSignal', () => {
    const signal = new AbortController().signal
    expect(toPermissionContext({ toolUseID: 'toolu_1', signal, suggestions: [] })).toEqual({
      toolUseId: 'toolu_1',
      signal
    })
    expect(toPermissionContext({ toolUseID: '', signal: { aborted: false } })).toEqual({})
    expect(toPermissionContext({ toolUseId: 'toolu_1' })).toEqual({})
    expect(toPermissionContext(null)).toEqual({})
    expect(toPermissionContext(undefined)).toEqual({})
  })
})

describe('sdkDriver: вложения', () => {
  const FILE = 'C:\Мои проекты\файл 1.ts'
  const MENTION = `@"${FILE}"`

  async function firstMessage(query: { prompt: unknown }): Promise<{
    message: { content: Array<Record<string, unknown>> }
  }> {
    const gen = query.prompt as AsyncGenerator<never, void>
    const first = await gen.next()
    return first.value as never
  }

  test('файл упоминается в тексте ровно один раз', async () => {
    const query = mockQuery()
    const driver = await createSdkDriver(allowAll())

    // The text arrives composed, as AgentSession.send composes it.
    driver.send({
      text: `посмотри\n${MENTION}`,
      attachments: [{ kind: 'file', path: FILE }]
    })

    const { message } = await firstMessage(query)
    const text = message.content[0]!['text'] as string
    expect(text.split(MENTION)).toHaveLength(2)
    expect(text).toBe(`посмотри\n${MENTION}`)
    await driver.dispose()
  })

  test('картинка по-прежнему уходит блоком image', async () => {
    const query = mockQuery()
    const driver = await createSdkDriver(allowAll())

    driver.send({
      text: 'что на картинке',
      attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }]
    })

    const { message } = await firstMessage(query)
    expect(message.content).toEqual([
      { type: 'text', text: 'что на картинке' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ])
    await driver.dispose()
  })
})

describe('sdkDriver: фоновые задачи', () => {
  test('taskOutput зовёт getTaskOutput, если он есть', async () => {
    const getTaskOutput = vi.fn(async (_id: string) => ({
      output: 'готово 2\n',
      total_bytes: 20000,
      truncated: true
    }))
    mockQuery({ getTaskOutput })
    const driver = await createSdkDriver(allowAll())
    await expect(driver.taskOutput('b1')).resolves.toEqual({
      output: 'готово 2\n',
      totalBytes: 20000,
      truncated: true
    })
    expect(getTaskOutput).toHaveBeenCalledWith('b1')
    await driver.dispose()
  })

  test('нет getTaskOutput — null без ошибки', async () => {
    mockQuery()
    const driver = await createSdkDriver(allowAll())
    await expect(driver.taskOutput('b1')).resolves.toBeNull()
    await driver.dispose()
  })

  test('getTaskOutput бросил — null', async () => {
    mockQuery({
      getTaskOutput: async () => {
        throw new Error('not a shell task')
      }
    })
    const driver = await createSdkDriver(allowAll())
    await expect(driver.taskOutput('b1')).resolves.toBeNull()
    await driver.dispose()
  })

  test('stopTask уходит в Query.stopTask', async () => {
    const stopTask = vi.fn(async (_id: string) => undefined)
    mockQuery({ stopTask })
    const driver = await createSdkDriver(allowAll())
    await driver.stopTask('b1')
    expect(stopTask).toHaveBeenCalledWith('b1')
    await driver.dispose()
  })
})

describe('sdkDriver: Remote Control', () => {
  const link = {
    session_url: 'https://claude.ai/code/session_1',
    connect_url: 'https://claude.ai/code?environment=e',
    bridge_session_id: 'b'
  }

  test('нет метода — недоступно по причине sdk', async () => {
    mockQuery({ initializationResult: async () => ({}) })
    const d = await createSdkDriver(allowAll())
    expect(await d.remoteAvailability()).toEqual({ available: false, reason: 'sdk' })
    await d.dispose()
  })

  test('API-ключ — недоступно по причине api_key', async () => {
    mockQuery({
      enableRemoteControl: vi.fn(),
      initializationResult: async () => ({ account: { apiKeySource: 'ANTHROPIC_API_KEY' } })
    })
    const d = await createSdkDriver(allowAll())
    expect(await d.remoteAvailability()).toEqual({ available: false, reason: 'api_key' })
    await d.dispose()
  })

  test('initializationResult отклонён — считаем доступным', async () => {
    mockQuery({
      enableRemoteControl: vi.fn(),
      initializationResult: async () => {
        throw new Error('нет')
      }
    })
    const d = await createSdkDriver(allowAll())
    expect(await d.remoteAvailability()).toEqual({ available: true })
    await d.dispose()
  })

  test('включение передаёт имя и возвращает ссылку', async () => {
    const enable = vi.fn(async () => link)
    mockQuery({ enableRemoteControl: enable })
    const d = await createSdkDriver(allowAll())
    expect(await d.setRemoteControl(true, 'Qclod — проект')).toEqual({
      sessionUrl: 'https://claude.ai/code/session_1',
      connectUrl: 'https://claude.ai/code?environment=e'
    })
    expect(enable).toHaveBeenCalledWith(true, 'Qclod — проект')
    await d.dispose()
  })

  test('connect_url не https — только sessionUrl', async () => {
    mockQuery({ enableRemoteControl: async () => ({ ...link, connect_url: 'http://x' }) })
    const d = await createSdkDriver(allowAll())
    expect(await d.setRemoteControl(true)).toEqual({ sessionUrl: link.session_url })
    await d.dispose()
  })

  test('включение без метода — ошибка', async () => {
    mockQuery()
    const d = await createSdkDriver(allowAll())
    await expect(d.setRemoteControl(true)).rejects.toThrow('enableRemoteControl отсутствует')
    await d.dispose()
  })

  test('ответ без https-ссылки — ошибка, а не пустая панель', async () => {
    mockQuery({ enableRemoteControl: async () => ({ session_url: 'http://x' }) })
    const d = await createSdkDriver(allowAll())
    await expect(d.setRemoteControl(true)).rejects.toThrow('CLI не вернул ссылку на сессию')
    await d.dispose()
  })

  test('выключение зовёт метод с false', async () => {
    const enable = vi.fn(async () => ({}))
    mockQuery({ enableRemoteControl: enable })
    const d = await createSdkDriver(allowAll())
    expect(await d.setRemoteControl(false)).toBeNull()
    expect(enable).toHaveBeenCalledWith(false, undefined)
    await d.dispose()
  })

  test('выключение без метода — null; ошибка выключения пробрасывается', async () => {
    mockQuery()
    const d1 = await createSdkDriver(allowAll())
    expect(await d1.setRemoteControl(false)).toBeNull()
    await d1.dispose()
    mockQuery({
      enableRemoteControl: async () => {
        throw new Error('отказ')
      }
    })
    const d2 = await createSdkDriver(allowAll())
    await expect(d2.setRemoteControl(false)).rejects.toThrow('отказ')
    await d2.dispose()
  })

  test('initializationResult не ответил за 5 с — считаем доступным, таймер не висит', async () => {
    vi.useFakeTimers()
    try {
      mockQuery({
        enableRemoteControl: vi.fn(),
        initializationResult: () => new Promise(() => undefined)
      })
      const d = await createSdkDriver(allowAll())
      const pending = d.remoteAvailability()
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toEqual({ available: true })
      expect(vi.getTimerCount()).toBe(0)
      await d.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
