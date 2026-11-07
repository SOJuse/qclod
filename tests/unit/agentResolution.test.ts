import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { resolveAgent } from '@main/sessions/agentFromEnv'
import { DEFAULT_SETTINGS } from '@main/store/settingsStore'

const ENV_KEY = 'QCLOD_AGENT_PATH'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = saved
})

describe('resolveAgent', () => {
  test('берёт путь из настроек', () => {
    expect(resolveAgent({ ...DEFAULT_SETTINGS, agentPath: 'C:/a/claude.exe' }).path).toBe(
      'C:/a/claude.exe'
    )
  })

  test('читает настройки заново при каждом вызове', () => {
    // The agent path is the one thing a user fixes from the error panel. If it
    // is captured once at startup, "Открыть настройки → Перезапустить" can
    // never succeed and spec 6.10's recovery loop is a dead end.
    let agentPath = 'claude'
    const get = (): typeof DEFAULT_SETTINGS => ({ ...DEFAULT_SETTINGS, agentPath })
    expect(resolveAgent(get()).path).toBe('claude')

    agentPath = 'C:/fixed/claude.exe'
    expect(resolveAgent(get()).path).toBe('C:/fixed/claude.exe')
  })

  test('переменная окружения перекрывает настройки', () => {
    process.env[ENV_KEY] = 'C:/test/fake.exe'
    expect(resolveAgent(DEFAULT_SETTINGS).path).toBe('C:/test/fake.exe')
  })

  test('пустая переменная окружения игнорируется', () => {
    process.env[ENV_KEY] = '   '
    expect(resolveAgent({ ...DEFAULT_SETTINGS, agentPath: 'claude' }).path).toBe('claude')
  })

  test('повреждённые префиксные аргументы не роняют запуск', () => {
    process.env['QCLOD_AGENT_PREFIX_ARGS'] = 'это не json'
    expect(() => resolveAgent(DEFAULT_SETTINGS)).not.toThrow()
    expect(resolveAgent(DEFAULT_SETTINGS).prefixArgs).toEqual([])
    delete process.env['QCLOD_AGENT_PREFIX_ARGS']
  })

  test('не массив в префиксных аргументах игнорируется', () => {
    process.env['QCLOD_AGENT_PREFIX_ARGS'] = '{"nope":1}'
    expect(resolveAgent(DEFAULT_SETTINGS).prefixArgs).toEqual([])
    delete process.env['QCLOD_AGENT_PREFIX_ARGS']
  })
})
