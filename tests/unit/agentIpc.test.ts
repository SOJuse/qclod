import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { LayoutStore } from '@main/store/layoutStore'
import { DEFAULT_LAYOUT, type LaunchOverrides, type LayoutState, type UserInput } from '@shared/types'

const USER_DATA = mkdtempSync(join(tmpdir(), 'qclod-agent-ipc-'))
afterAll(() => rmSync(USER_DATA, { recursive: true, force: true }))

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

describe('этап 2: проекты и раскладка', () => {
  const OPEN = 'C:\\Открытый'
  let layout: LayoutStore
  const listed: string[] = []
  const opened: Array<[string, string, string | undefined]> = []
  const panes: string[][] = []
  const changes: LayoutState[] = []
  const tabs = [
    { id: 't1', cwd: OPEN, title: 'открытый' },
    { id: 't2', cwd: OPEN, title: 'второй' }
  ]

  let layoutDir = ''
  afterEach(() => rmSync(layoutDir, { recursive: true, force: true }))

  beforeEach(() => {
    handlers.clear()
    for (const list of [listed, opened, panes, changes]) list.length = 0
    layoutDir = mkdtempSync(join(tmpdir(), 'qclod-layout-ipc-'))
    layout = new LayoutStore(layoutDir, (l) => changes.push(l))
    registerAgentIpc({
      getWindow: () => null,
      controller: {
        list: () => tabs,
        setPanes: async (ids: string[]) => {
          panes.push(ids)
          layout.patch({ panes: ids })
        },
        openSession: (cwd: string, sessionId: string, title?: string) => {
          opened.push([cwd, sessionId, title])
          return { id: 'новая', cwd }
        }
      },
      manager: { get: () => undefined },
      broker: { cancelTab: () => undefined },
      layout,
      history: {
        list: async (cwd: string) => {
          listed.push(cwd)
          return [{ sessionId: 's1', summary: 'прошлый', lastModified: 1 }]
        }
      },
      rememberDefault: () => undefined,
      resolver: { forget: () => undefined },
      getEditorCommand: () => '',
      userData: USER_DATA
    } as unknown as AgentIpcDeps)
  })

  test('история чужой папки — пусто, history.list не вызван', async () => {
    expect(await call(CHANNELS.projectHistory, 'C:\\чужая')).toEqual([])
    expect(await call(CHANNELS.projectHistory, 42)).toEqual([])
    expect(await call(CHANNELS.projectHistory, '')).toEqual([])
    expect(listed).toEqual([])
  })

  test('история проекта читается по его первой записи (П13), открытого чата — по его папке', async () => {
    layout.addProject('C:\\Проект')
    expect(await call(CHANNELS.projectHistory, 'c:/проект/')).toHaveLength(1)
    expect(await call(CHANNELS.projectHistory, 'c:/открытый')).toHaveLength(1)
    expect(listed).toEqual(['C:\\Проект', OPEN])
  })

  test('с hostId этап 2 отвечает пусто и ничего не открывает', async () => {
    layout.addProject('C:\\Проект')
    expect(await call(CHANNELS.projectHistory, 'C:\\Проект', 'srv1')).toEqual([])
    expect(await call(CHANNELS.projectHistory, OPEN, 7)).toEqual([])
    expect(await call(CHANNELS.projectOpenSession, 'C:\\Проект', 's1', undefined, 'srv1')).toBeNull()
    expect(listed).toEqual([])
    expect(opened).toEqual([])
  })

  test('сессия открывается только в известном проекте и только с id-строкой', async () => {
    layout.addProject('C:\\Проект')
    expect(await call(CHANNELS.projectOpenSession, 'C:\\чужая', 's1')).toBeNull()
    expect(await call(CHANNELS.projectOpenSession, 'C:\\Проект', 5)).toBeNull()
    expect(await call(CHANNELS.projectOpenSession, 'C:\\Проект', '')).toBeNull()
    expect(opened).toEqual([])

    expect(await call(CHANNELS.projectOpenSession, 'c:/проект', 's1', 'Вчера')).toMatchObject({ id: 'новая' })
    expect(await call(CHANNELS.projectOpenSession, OPEN, 's2', 42)).toMatchObject({ id: 'новая' })
    expect(opened).toEqual([
      ['C:\\Проект', 's1', 'Вчера'],
      [OPEN, 's2', undefined]
    ])
  })

  test('layoutGet отдаёт раскладку, layoutSet чистит патч и зовёт setPanes', async () => {
    expect(await call(CHANNELS.layoutGet)).toEqual(DEFAULT_LAYOUT)

    const after = (await call(CHANNELS.layoutSet, {
      panes: ['t1', 't1', 5],
      paneWidths: [1, 3],
      sidebarCollapsed: 'да'
    })) as LayoutState
    expect(panes).toEqual([['t1']])
    expect(after).toMatchObject({ panes: ['t1'], paneWidths: [1], sidebarCollapsed: false })

    expect(await call(CHANNELS.layoutSet, { sidebarCollapsed: true })).toMatchObject({ sidebarCollapsed: true })
    expect(panes).toHaveLength(1)
    expect(await call(CHANNELS.layoutSet, 'мусор')).toEqual(layout.get())
  })

  test('один layoutSet — одна запись и один layoutChanged; мёртвые панели не доходят', async () => {
    const after = (await call(CHANNELS.layoutSet, {
      panes: ['t1', 'нет-такой', 't2'],
      paneWidths: [1, 3],
      sidebarCollapsed: true
    })) as LayoutState
    expect(after).toMatchObject({ panes: ['t1', 't2'], paneWidths: [0.25, 0.75], sidebarCollapsed: true })
    expect(panes).toEqual([['t1', 't2']])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual(after)
  })

  test('projectForget при открытых чатах проекта ничего не меняет и отдаёт раскладку', async () => {
    layout.addProject(OPEN)
    layout.addProject('C:\\Пустой')
    const before = layout.get()
    expect(await call(CHANNELS.projectForget, 'c:/открытый')).toEqual(before)
    expect(layout.get()).toEqual(before)

    expect(await call(CHANNELS.projectForget, 'C:\\Пустой')).toMatchObject({
      projects: [{ cwd: OPEN, collapsed: false }]
    })
    expect(await call(CHANNELS.projectForget, 9)).toEqual(layout.get())
  })
})
