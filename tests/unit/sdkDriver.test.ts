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
  function fakeQuery(args: { prompt: unknown; options: Record<string, unknown> }): unknown {
    calls.push(args)
    return {
      close: () => undefined,
      interrupt: async () => undefined,
      return: async () => ({ done: true, value: undefined }),
      async *[Symbol.asyncIterator]() {
        // An empty session: no message ever arrives.
      }
    }
  }
  return { calls, fakeQuery }
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
function mockQuery(): {
  readonly prompt: unknown
  readonly options: Record<string, unknown>
  readonly canUseTool: SdkCanUseTool
} {
  sdk.calls.length = 0
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
