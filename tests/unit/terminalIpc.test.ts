import { beforeEach, describe, expect, test, vi } from 'vitest'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
const listeners = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => listeners.set(channel, fn)
  }
}))

import { CHANNELS } from '../../src/shared/channels'
import { registerTerminalIpc } from '../../src/main/ssh/terminalIpc'

const ID = '0b9a6c2e-4f1d-4a7b-9c3e-1d2f3a4b5c6d'
const calls: unknown[][] = []

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  calls.length = 0
  registerTerminalIpc({
    hub: {
      input: (...a: unknown[]) => (calls.push(['input', ...a]), true),
      resize: (...a: unknown[]) => (calls.push(['resize', ...a]), true),
      close: (...a: unknown[]) => void calls.push(['close', ...a]),
      attach: (...a: unknown[]) => (calls.push(['attach', ...a]), a[0] === 't1' ? 'вывод' : null)
    } as never,
    open: async (tabId, size) => {
      calls.push(['open', tabId, size])
      return tabId === 't1' ? ID : null
    }
  })
})

describe('каналы терминала', () => {
  test('terminalOpen: размер в границах, вкладка — строка', async () => {
    expect(await handlers.get(CHANNELS.terminalOpen)!({}, 't1', 80, 24)).toBe(ID)
    expect(await handlers.get(CHANNELS.terminalOpen)!({}, 't1', 1, 24)).toBeNull()
    expect(await handlers.get(CHANNELS.terminalOpen)!({}, 5, 80, 24)).toBeNull()
    expect(await handlers.get(CHANNELS.terminalOpen)!({}, 't1', '80', 24)).toBeNull()
    expect(await handlers.get(CHANNELS.terminalOpen)!({}, 'чужая', 80, 24)).toBeNull()
    expect(calls).toEqual([
      ['open', 't1', { cols: 80, rows: 24 }],
      ['open', 'чужая', { cols: 80, rows: 24 }]
    ])
  })

  test('не-строки отвергнуты, чужой termId игнорируется', () => {
    const input = listeners.get(CHANNELS.terminalInput)!
    input({}, ID, 'ls\r')
    input({}, ID, 5)
    input({}, 7, 'ls')
    input({}, 'не-uuid', 'ls')
    input({}, ID, 'x'.repeat(64 * 1024 + 1))
    void handlers.get(CHANNELS.terminalResize)!({}, ID, 100, 30)
    void handlers.get(CHANNELS.terminalResize)!({}, ID, '100', 30)
    void handlers.get(CHANNELS.terminalResize)!({}, 'не-uuid', 100, 30)
    void handlers.get(CHANNELS.terminalClose)!({}, ID)
    void handlers.get(CHANNELS.terminalClose)!({}, { id: ID })
    expect(calls).toEqual([
      ['input', ID, 'ls\r'],
      ['resize', ID, 100, 30],
      ['close', ID]
    ])
  })
})

describe('terminalAttach (R1)', () => {
  test('вкладка — строка, termId — uuid; иначе null без обращения к хабу', async () => {
    const attach = handlers.get(CHANNELS.terminalAttach)!
    expect(await attach({}, 't1', ID)).toBe('вывод')
    expect(await attach({}, 't1', 'не-uuid')).toBeNull()
    expect(await attach({}, 5, ID)).toBeNull()
    expect(calls).toEqual([['attach', 't1', ID]])
  })
})
