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

import { registerVoiceIpc, type ModelStoreLike } from '@main/voice/voiceIpc'
import type { VoiceHost } from '@main/voice/voiceHost'
import { CHANNELS } from '@shared/channels'

const OUR = 5
let calls: Array<[string, ...unknown[]]>
let mic: 'granted' | 'denied' | 'unknown' = 'unknown'

function setup(): void {
  handlers.clear()
  listeners.clear()
  calls = []
  const host = {
    begin: async (...a: unknown[]) => {
      calls.push(['begin', ...a])
      return { session: 's1' }
    },
    end: (...a: unknown[]) => calls.push(['end', ...a]),
    audio: (...a: unknown[]) => calls.push(['audio', ...a])
  } as unknown as VoiceHost
  const store: ModelStoreLike = {
    snapshot: () => [{ id: 'gigaam-v3', state: { kind: 'ready' }, available: true }],
    download: async (id) => void calls.push(['download', id]),
    cancel: (id) => void calls.push(['cancel', id]),
    remove: async (id) => void calls.push(['remove', id])
  }
  registerVoiceIpc({
    host,
    store,
    isOurWindow: (id) => id === OUR,
    micAccess: () => mic,
    openMicSettings: async () => void calls.push(['mic']),
    openVcRedist: async () => void calls.push(['vc'])
  })
}

const from = (id: number): unknown => ({ sender: { id } })
const invoke = (channel: string, sender: number, ...args: unknown[]): unknown =>
  handlers.get(channel)!(from(sender), ...args)
const send = (channel: string, sender: number, ...args: unknown[]): unknown =>
  listeners.get(channel)!(from(sender), ...args)

beforeEach(setup)

describe('registerVoiceIpc', () => {
  test('begin и end от нашего окна доходят до host с владельцем', async () => {
    expect(await invoke(CHANNELS.voiceBegin, OUR, 'tab-1')).toEqual({ session: 's1' })
    await invoke(CHANNELS.voiceEnd, OUR, 's1')
    expect(calls).toEqual([
      ['begin', OUR, 'tab-1'],
      ['end', OUR, 's1']
    ])
  })

  test('не-строка tabId → отказ без вызова host', async () => {
    for (const bad of [42, null, undefined, {}, ['t'], '', 'x'.repeat(101)]) {
      await expect(Promise.resolve().then(() => invoke(CHANNELS.voiceBegin, OUR, bad))).rejects.toThrow()
    }
    await invoke(CHANNELS.voiceEnd, OUR, 7)
    await invoke(CHANNELS.voiceEnd, OUR, 'x'.repeat(101))
    expect(calls).toEqual([])
  })

  test('begin из чужого webContents — отказ', async () => {
    await expect(Promise.resolve().then(() => invoke(CHANNELS.voiceBegin, 99, 't1'))).rejects.toThrow()
    await invoke(CHANNELS.voiceEnd, 99, 's1')
    expect(calls).toEqual([])
  })

  test('чужая модель в voiceDownload → отказ', async () => {
    await invoke(CHANNELS.voiceDownload, OUR, 'whisper-large-v9')
    await invoke(CHANNELS.voiceDownload, OUR, { id: 'gigaam-v3' })
    await invoke(CHANNELS.voiceCancelDownload, OUR, 'nope')
    await invoke(CHANNELS.voiceDelete, OUR, '../../etc')
    expect(calls).toEqual([])
    await invoke(CHANNELS.voiceDownload, OUR, 'parakeet-v3')
    await invoke(CHANNELS.voiceCancelDownload, OUR, 'parakeet-v3')
    await invoke(CHANNELS.voiceDelete, OUR, 'gigaam-v3')
    expect(calls).toEqual([
      ['download', 'parakeet-v3'],
      ['cancel', 'parakeet-v3'],
      ['remove', 'gigaam-v3']
    ])
  })

  test('voiceAudio с number[] → отброшено', () => {
    send(CHANNELS.voiceAudio, OUR, 's1', [0.1, 0.2])
    send(CHANNELS.voiceAudio, OUR, 's1', new Float64Array(10))
    send(CHANNELS.voiceAudio, OUR, 42, new Float32Array(10))
    expect(calls).toEqual([])
    send(CHANNELS.voiceAudio, OUR, 's1', new Float32Array([0.5, 2, Number.NaN]))
    expect(calls).toHaveLength(1)
    const [name, owner, session, pcm] = calls[0]
    expect([name, owner, session]).toEqual(['audio', OUR, 's1'])
    expect(Array.from(pcm as Float32Array)).toEqual([0.5, 1, 0])
  })

  test('voiceAudio от другого webContents → отброшено', () => {
    send(CHANNELS.voiceAudio, 99, 's1', new Float32Array(10))
    expect(calls).toEqual([])
  })

  test('voiceModels отдаёт снимок хранилища с micAccess', async () => {
    mic = 'denied'
    expect(await invoke(CHANNELS.voiceModels, OUR)).toEqual({
      models: [{ id: 'gigaam-v3', state: { kind: 'ready' }, available: true }],
      micAccess: 'denied'
    })
    mic = 'unknown'
  })

  test('отказ скачивания не уходит в окно: состояние ошибки скажет само', async () => {
    handlers.clear()
    registerVoiceIpc({
      host: {} as VoiceHost,
      store: {
        snapshot: () => [],
        download: () => Promise.reject(new Error('network')),
        cancel: () => {},
        remove: async () => {}
      },
      isOurWindow: () => true,
      micAccess: () => 'unknown',
      openMicSettings: async () => {},
      openVcRedist: async () => {}
    })
    await expect(invoke(CHANNELS.voiceDownload, OUR, 'gigaam-v3')).resolves.toBeUndefined()
  })

  test('openMicSettings', async () => {
    await invoke(CHANNELS.voiceOpenMicSettings, OUR)
    expect(calls).toEqual([['mic']])
  })

  test('I4: voiceOpenVcRedist открывает установщик VC++ — без аргументов из окна', async () => {
    await invoke(CHANNELS.voiceOpenVcRedist, OUR, 'https://evil.example/')
    expect(calls).toEqual([['vc']])
  })
})
