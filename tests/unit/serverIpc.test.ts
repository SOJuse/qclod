import { beforeEach, describe, expect, test, vi } from 'vitest'

type Handler = (e: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
}))

import { registerServerIpc } from '@main/ssh/serverIpc'
import { SshPromptBroker } from '@main/ssh/promptBroker'
import { CHANNELS } from '@shared/channels'
import type { SshPrompt } from '@shared/types'

function call(channel: string, ...args: unknown[]): unknown {
  return handlers.get(channel)!({}, ...args)
}

const saved: unknown[] = []
const opened: Array<[string, string]> = []
const listed: Array<[string, string]> = []
let broker: SshPromptBroker
let shown: SshPrompt[] = []

beforeEach(() => {
  handlers.clear()
  saved.length = 0
  opened.length = 0
  listed.length = 0
  shown = []
  broker = new SshPromptBroker((p) => {
    shown.push(p)
    return true
  })
  registerServerIpc({
    hosts: {
      list: () => [],
      save: (e: unknown, pw?: string) => {
        saved.push([e, pw])
        return []
      },
      remove: () => [],
      connect: async () => true,
      forgetPassword: () => undefined,
      listDir: async (id: string, path: string) => {
        listed.push([id, path])
        return { path, entries: [], truncated: false }
      },
      openFolder: (id: string, path: string) => {
        opened.push([id, path])
        return { id: 't1', cwd: path, title: 'app', overrides: {}, status: 'stopped', badge: false, missingCwd: false, server: { hostId: id } }
      },
      updateRelay: async () => undefined
    } as never,
    askpassAnswers: (a) => broker.answer(a)
  })
})

describe('serverIpc', () => {
  test('saveServer отвергает target с пробелом, переводом строки или началом -', () => {
    for (const target of ['me@ho st', 'me@host\n-oProxyCommand=x', '-oProxyCommand=calc', '', 'a\tb', "me@h'$(id)'", 'a;b', 'x|y']) {
      expect(() => call(CHANNELS.serversSave, { label: 'x', target, auth: 'key' })).toThrow()
    }
    expect(saved).toEqual([])
    call(CHANNELS.serversSave, { label: 'Дом', target: 'me@home.lan', auth: 'key' })
    expect(saved).toEqual([[{ label: 'Дом', target: 'me@home.lan', auth: 'key', fromConfig: false }, undefined]])
  })

  test('порт вне 1–65535 отвергается', () => {
    for (const port of [0, 65536, -1, 22.5, '22']) {
      expect(() => call(CHANNELS.serversSave, { label: '', target: 'box', auth: 'key', port })).toThrow()
    }
    call(CHANNELS.serversSave, { label: '', target: 'box', auth: 'key', port: 2222 })
    expect(saved).toHaveLength(1)
    expect((saved[0] as [Record<string, unknown>])[0]['port']).toBe(2222)
  })

  test('ключ, начинающийся с -, и пароль с переводом строки не проходят', () => {
    expect(() => call(CHANNELS.serversSave, { label: '', target: 'box', auth: 'key', identityFile: '-F/tmp/x' })).toThrow()
    call(CHANNELS.serversSave, { label: '', target: 'box', auth: 'password' }, 'line1\nline2')
    expect((saved[0] as unknown[])[1]).toBeUndefined()
  })

  test('answerSshPrompt с чужим promptId ничего не делает', async () => {
    const answer = broker.ask({ promptId: 'p1', hostId: 'h1', kind: 'password', text: 'me@box', canRemember: true, retry: false })
    expect(shown).toHaveLength(1)
    await call(CHANNELS.serversPromptAnswer, { promptId: 'p-other', ok: true, value: 'x' })
    let settled = false
    void answer.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    await call(CHANNELS.serversPromptAnswer, { promptId: 'p1', ok: true, value: 'secret', remember: true })
    expect(await answer).toEqual({ promptId: 'p1', ok: true, value: 'secret', remember: true })
    // Answered once: a second click is nothing.
    expect(broker.answer({ promptId: 'p1', ok: false })).toBe(false)
  })

  test('длина значения не больше 4096', async () => {
    const answer = broker.ask({ promptId: 'p2', hostId: 'h1', kind: 'other', text: 'Код:', canRemember: false, retry: false })
    await call(CHANNELS.serversPromptAnswer, { promptId: 'p2', ok: true, value: 'x'.repeat(4097) })
    let settled = false
    void answer.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    await call(CHANNELS.serversPromptAnswer, { promptId: 'p2', ok: true, value: 'x'.repeat(4096) })
    expect((await answer).ok).toBe(true)
  })

  test('путь длиннее 4096 или с \\0 отвергнут', async () => {
    await expect(call(CHANNELS.serversListDir, 'h1', 'a'.repeat(4097))).rejects.toThrow()
    await expect(call(CHANNELS.serversListDir, 'h1', '/home/\0x')).rejects.toThrow()
    expect(call(CHANNELS.serversOpenFolder, 'h1', '/srv/\0')).toBeNull()
    expect(call(CHANNELS.serversOpenFolder, 'bad id!', '/srv/app')).toBeNull()
    expect(listed).toEqual([])
    expect(opened).toEqual([])
    await call(CHANNELS.serversListDir, 'h1', '~/projects')
    expect(listed).toEqual([['h1', '~/projects']])
  })

  test('serversOpenFolder возвращает вкладку с server.hostId', () => {
    const tab = call(CHANNELS.serversOpenFolder, 'h1', '/srv/app') as { server: { hostId: string } }
    expect(tab.server.hostId).toBe('h1')
    expect(opened).toEqual([['h1', '/srv/app']])
  })
})
