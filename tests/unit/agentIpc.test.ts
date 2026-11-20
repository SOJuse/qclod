import { beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  dialog: {},
  BrowserWindow: class {},
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() }
}))

import { registerAgentIpc, type AgentIpcDeps } from '@main/agentIpc'
import { CHANNELS } from '@shared/channels'
import type { LaunchOverrides, UserInput } from '@shared/types'

const USER_DATA = mkdtempSync(join(tmpdir(), 'qclod-agent-ipc-'))

let mode = 'default'
let sendAnswer = true
const sent: UserInput[] = []
const overrides: LaunchOverrides[] = []
const defaults: LaunchOverrides[] = []
const models: string[] = []
const remoteCalls: Array<[boolean, string | undefined]> = []
const resolved: string[][] = []
const queueCalls: Array<[string, string]> = []
let cancelAnswer: UserInput | null = null
let sendNowAnswer = false

function call(channel: string, ...args: unknown[]): unknown {
  return handlers.get(channel)!({}, ...args)
}

beforeEach(() => {
  handlers.clear()
  mode = 'default'
  sendAnswer = true
  for (const list of [sent, overrides, defaults, models, resolved, remoteCalls, queueCalls]) list.length = 0
  cancelAnswer = null
  sendNowAnswer = false
  const session = {
    get panel() {
      return { permissionMode: mode }
    },
    setPermissionMode: async (next: string) => {
      mode = next
    },
    setModel: async (model: string) => {
      models.push(model)
    },
    setRemote: async (enabled: boolean, name?: string) => {
      remoteCalls.push([enabled, name])
    },
    cancelQueued: async (queuedId: string) => {
      queueCalls.push(['cancel', queuedId])
      return cancelAnswer
    },
    sendQueuedNow: async (queuedId: string) => {
      queueCalls.push(['now', queuedId])
      return sendNowAnswer
    }
  }
  registerAgentIpc({
    getWindow: () => null,
    controller: {
      list: () => [{ id: 't1', cwd: USER_DATA, title: 'проект' }],
      send: (_id: string, input: UserInput) => {
        sent.push(input)
        return sendAnswer
      },
      rememberOverride: (_id: string, patch: LaunchOverrides) => overrides.push(patch)
    },
    manager: { get: (id: string) => (id === 't1' ? session : undefined) },
    broker: { cancelTab: () => undefined },
    rememberDefault: (patch: LaunchOverrides) => defaults.push(patch),
    resolver: {
      resolve: async (_cwd: string, raws: string[]) => {
        resolved.push(raws)
        return raws.map(() => null)
      },
      knows: () => false,
      forget: () => undefined
    },
    getEditorCommand: () => '',
    userData: USER_DATA
  } as unknown as AgentIpcDeps)
})

describe('agent:* каналы', () => {
  test('подтверждённый «без проверок» не переписывает сохранённый режим', async () => {
    await call(CHANNELS.agentPermissionMode, 't1', 'acceptEdits')
    expect(overrides).toEqual([{ permissionMode: 'acceptEdits' }])
    expect(defaults).toEqual([{ permissionMode: 'acceptEdits' }])

    await call(CHANNELS.agentPermissionMode, 't1', 'bypassPermissions')
    expect(mode).toBe('bypassPermissions')
    // Neither the tab nor the defaults hear of it: they keep acceptEdits.
    expect(overrides).toEqual([{ permissionMode: 'acceptEdits' }])
    expect(defaults).toEqual([{ permissionMode: 'acceptEdits' }])
  })

  test('send отвечает, приняла ли вкладка сообщение', async () => {
    expect(await call(CHANNELS.agentSend, 't1', { text: 'привет', attachments: [] })).toBe(true)
    expect(sent.map((s) => s.text)).toEqual(['привет'])
    sendAnswer = false
    expect(await call(CHANNELS.agentSend, 't1', { text: 'никуда', attachments: [] })).toBe(false)
    expect(await call(CHANNELS.agentSend, 42, { text: 'x', attachments: [] })).toBe(false)
  })

  test('модель длиннее 200 знаков не принимается', async () => {
    await call(CHANNELS.agentModel, 't1', 'm'.repeat(201))
    expect(models).toEqual([])
    await call(CHANNELS.agentModel, 't1', 'claude-opus-5')
    expect(models).toEqual(['claude-opus-5'])
  })

  test('agent:remote принимает только id-строку и boolean', async () => {
    await call(CHANNELS.agentRemote, 't1', 'yes')
    await call(CHANNELS.agentRemote, 1, true)
    await call(CHANNELS.agentRemote, 'нет-такой', true)
    expect(remoteCalls).toEqual([])
    await call(CHANNELS.agentRemote, 't1', true)
    expect(remoteCalls).toEqual([[true, 'проект']])
  })

  test('agentQueueCancel принимает только строки и отдаёт, что вернула сессия', async () => {
    expect(await call(CHANNELS.agentQueueCancel, 't1', 42)).toBeNull()
    expect(await call(CHANNELS.agentQueueCancel, 1, 'q1')).toBeNull()
    expect(await call(CHANNELS.agentQueueCancel, 't1', { id: 'q1' })).toBeNull()
    expect(await call(CHANNELS.agentQueueCancel, 'нет-такой', 'q1')).toBeNull()
    expect(queueCalls).toEqual([])

    expect(await call(CHANNELS.agentQueueCancel, 't1', 'q1')).toBeNull()
    cancelAnswer = { text: 'два', attachments: [] }
    expect(await call(CHANNELS.agentQueueCancel, 't1', 'q2')).toEqual({ text: 'два', attachments: [] })
    expect(queueCalls).toEqual([
      ['cancel', 'q1'],
      ['cancel', 'q2']
    ])
  })

  test('agentQueueSendNow принимает только строки и отдаёт, что вернула сессия', async () => {
    expect(await call(CHANNELS.agentQueueSendNow, 't1', 42)).toBe(false)
    expect(await call(CHANNELS.agentQueueSendNow, null, 'q1')).toBe(false)
    expect(await call(CHANNELS.agentQueueSendNow, 'нет-такой', 'q1')).toBe(false)
    expect(queueCalls).toEqual([])

    expect(await call(CHANNELS.agentQueueSendNow, 't1', 'q1')).toBe(false)
    sendNowAnswer = true
    expect(await call(CHANNELS.agentQueueSendNow, 't1', 'q2')).toBe(true)
    expect(queueCalls).toEqual([
      ['now', 'q1'],
      ['now', 'q2']
    ])
  })

  test('огромный список путей обрезается до разбора', async () => {
    const raws = Array.from({ length: 100_000 }, (_, i) => `p${i}.ts`)
    const out = (await call(CHANNELS.filesResolve, 't1', raws)) as unknown[]
    expect(out).toHaveLength(200)
    expect(resolved[0]).toHaveLength(200)
  })
})
