import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { VoiceHost, whisperPrompt, type VoiceHostDeps, type WorkerLike } from '@main/voice/voiceHost'
import type { FromWorker, ModelPaths, ToWorker } from '@main/voice/protocol'
import type { VoiceEvent, VoiceModelId, VoiceSettings } from '@shared/voice'
import { DEFAULT_REPLACEMENTS } from '@shared/voiceReplacements'
import type { ErrorEntry } from '@main/system/errorLog'

class FakeWorker extends EventEmitter implements WorkerLike {
  sent: ToWorker[] = []
  killed = false
  /** kill() does not end the process by itself: the test emits its exit. */
  manualExit = false
  tail = ''
  postMessage(m: ToWorker): void {
    this.sent.push(m)
  }
  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    if (!this.manualExit) queueMicrotask(() => this.emit('exit', 0))
    return true
  }
  stderrTail(): string {
    return this.tail
  }
  reply(m: FromWorker): void {
    this.emit('message', m)
  }
  crash(code = 1): void {
    this.emit('exit', code)
  }
  types(): string[] {
    return this.sent.map((m) => m.type)
  }
}

const giga: ModelPaths = {
  kind: 'sherpa',
  model: 'gigaam-v3',
  encoder: 'g/e',
  decoder: 'g/d',
  joiner: 'g/j',
  tokens: 'g/t',
  vad: 'silero'
}
const parakeet: ModelPaths = { ...giga, model: 'parakeet-v3', encoder: 'p/e' }
const whisper: ModelPaths = {
  kind: 'whisper',
  model: 'whisper-turbo-cuda',
  exe: 'w/whisper-server.exe',
  ggml: 'w/ggml.bin',
  vad: 'silero'
}

interface Rig {
  host: VoiceHost
  workers: FakeWorker[]
  events: Array<{ owner: number; e: VoiceEvent }>
  logs: ErrorEntry[]
  killedPids: number[]
  settings: VoiceSettings
  ready: Set<VoiceModelId>
  mic: { value: 'granted' | 'denied' | 'unknown' }
  w(): FakeWorker
}

function rig(model: VoiceModelId = 'gigaam-v3', ready: VoiceModelId[] = ['gigaam-v3']): Rig {
  const r = {
    workers: [] as FakeWorker[],
    events: [] as Array<{ owner: number; e: VoiceEvent }>,
    logs: [] as ErrorEntry[],
    killedPids: [] as number[],
    settings: { model, replacements: null } as VoiceSettings,
    ready: new Set<VoiceModelId>(ready),
    mic: { value: 'granted' as 'granted' | 'denied' | 'unknown' }
  } as Rig
  const all: Record<VoiceModelId, ModelPaths> = {
    'gigaam-v3': giga,
    'parakeet-v3': parakeet,
    'whisper-turbo-cuda': whisper
  }
  const deps: VoiceHostDeps = {
    fork: () => {
      const w = new FakeWorker()
      r.workers.push(w)
      return w
    },
    pathsFor: (id) => (r.ready.has(id) ? all[id] : null),
    settings: () => r.settings,
    micAccess: () => r.mic.value,
    emit: (owner, e) => r.events.push({ owner, e }),
    log: (e) => r.logs.push(e),
    killPid: (pid) => r.killedPids.push(pid),
    now: () => Date.now()
  }
  r.host = new VoiceHost(deps)
  r.w = () => r.workers[r.workers.length - 1]
  return r
}

async function begin(r: Rig, owner = 1, tab = 't1'): Promise<string> {
  const res = await r.host.begin(owner, tab)
  if (!('session' in res)) throw new Error('begin failed: ' + res.error)
  return res.session
}

const kinds = (r: Rig): string[] =>
  r.events.map(({ e }) => (e.kind === 'error' ? `error:${e.code}` : e.kind))

const pcm = (): Float32Array => new Float32Array(1600)
const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-21T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('VoiceHost', () => {
  test('begin без готовой модели — no-model', async () => {
    const r = rig('parakeet-v3', ['gigaam-v3'])
    expect(await r.host.begin(1, 't1')).toEqual({ error: 'no-model' })
    expect(r.workers).toHaveLength(0)
  })

  test('запрет микрофона — mic-denied', async () => {
    const r = rig()
    r.mic.value = 'denied'
    expect(await r.host.begin(1, 't1')).toEqual({ error: 'mic-denied' })
    expect(r.workers).toHaveLength(0)
  })

  test('первое begin форкает и грузит выбранную модель; loading, потом ready', async () => {
    const r = rig('parakeet-v3', ['parakeet-v3'])
    const s = await begin(r)
    expect(r.workers).toHaveLength(1)
    const [load, start] = r.w().sent
    expect(load).toMatchObject({ type: 'load', paths: parakeet })
    if (load.type !== 'load') throw new Error()
    expect(load.threads).toBeGreaterThanOrEqual(1)
    expect(load.threads).toBeLessThanOrEqual(4)
    expect(start).toEqual({ type: 'start', session: s, replacements: [...DEFAULT_REPLACEMENTS] })
    expect(r.events).toEqual([{ owner: 1, e: { session: s, kind: 'loading' } }])
    r.w().reply({ type: 'loaded', model: 'parakeet-v3', ms: 3400 })
    expect(r.events[1]).toEqual({ owner: 1, e: { session: s, kind: 'ready' } })
    // Следующее begin на загруженном процессе не форкает и сразу ready.
    r.host.end(1, s)
    r.w().reply({ type: 'done', session: s })
    const s2 = await begin(r)
    expect(r.workers).toHaveLength(1)
    expect(r.events.slice(-1)).toEqual([{ owner: 1, e: { session: s2, kind: 'ready' } }])
  })

  test('свой словарь уходит в start; prompt Whisper — из словаря', async () => {
    const r = rig()
    r.settings = { model: 'gigaam-v3', replacements: [{ from: 'кьюклод', to: 'Qclod' }] }
    const s = await begin(r)
    expect(r.w().sent[1]).toEqual({
      type: 'start',
      session: s,
      replacements: [{ from: 'кьюклод', to: 'Qclod' }]
    })
    const load = r.w().sent[0]
    expect(load.type === 'load' && load.prompt).toBe('Диктовка задачи для программиста. Qclod')
  })

  test('аудио чужого окна или чужой сессии не доходит до процесса', async () => {
    const r = rig()
    const s = await begin(r, 1)
    r.host.audio(2, s, pcm())
    r.host.audio(1, 'чужая', pcm())
    r.host.end(2, s)
    r.host.end(1, 'чужая')
    expect(r.w().types()).toEqual(['load', 'start'])
    r.host.audio(1, s, pcm())
    r.host.end(1, s)
    expect(r.w().types()).toEqual(['load', 'start', 'audio', 'stop'])
    // после end — сессия закрыта для звука
    r.host.audio(1, s, pcm())
    expect(r.w().types()).toEqual(['load', 'start', 'audio', 'stop'])
  })

  test('partial, final и done уходят владельцу сессии', async () => {
    const r = rig()
    const s = await begin(r, 7)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    r.w().reply({ type: 'partial', session: s, phrase: 0, text: 'При' })
    r.w().reply({ type: 'final', session: s, phrase: 0, text: 'Привет.', joinsPrevious: false })
    r.host.end(7, s)
    r.w().reply({ type: 'done', session: s })
    expect(r.events.map((x) => x.owner)).toEqual([7, 7, 7, 7, 7])
    expect(r.events.slice(2).map((x) => x.e)).toEqual([
      { session: s, kind: 'partial', phrase: 0, text: 'При' },
      { session: s, kind: 'final', phrase: 0, text: 'Привет.', joinsPrevious: false },
      { session: s, kind: 'done' }
    ])
  })

  test('падение посреди сессии — engine-crashed; следующее begin форкает снова', async () => {
    const r = rig()
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    r.w().crash(3221225477)
    expect(r.events.slice(-1)).toEqual([{ owner: 1, e: { session: s, kind: 'error', code: 'engine-crashed' } }])
    expect(r.logs).toHaveLength(1)
    expect(r.logs[0]).toMatchObject({ source: 'main', scope: 'voice' })
    expect(r.logs[0].message).toContain('3221225477')
    r.host.audio(1, s, pcm()) // сессии больше нет
    const s2 = await begin(r)
    expect(r.workers).toHaveLength(2)
    expect(r.w().types()).toEqual(['load', 'start'])
    expect(s2).not.toBe(s)
  })

  test('третье падение за 10 минут — engine-gave-up до перезапуска', async () => {
    const r = rig()
    for (let i = 0; i < 2; i++) {
      await begin(r)
      r.w().crash()
      vi.advanceTimersByTime(60_000)
    }
    expect(kinds(r).filter((k) => k.startsWith('error'))).toEqual(['error:engine-crashed', 'error:engine-crashed'])
    const s = await begin(r)
    r.w().crash()
    expect(r.events.slice(-1)).toEqual([{ owner: 1, e: { session: s, kind: 'error', code: 'engine-gave-up' } }])
    expect(await r.host.begin(1, 't1')).toEqual({ error: 'engine-gave-up' })
    vi.advanceTimersByTime(60 * 60_000)
    expect(await r.host.begin(1, 't1')).toEqual({ error: 'engine-gave-up' })
    expect(r.workers).toHaveLength(3)
  })

  test('падения реже трёх за 10 минут голос не выключают', async () => {
    const r = rig()
    for (let i = 0; i < 3; i++) {
      await begin(r)
      r.w().crash()
      vi.advanceTimersByTime(6 * 60_000)
    }
    expect(kinds(r).filter((k) => k.startsWith('error'))).toEqual([
      'error:engine-crashed',
      'error:engine-crashed',
      'error:engine-crashed'
    ])
    expect('session' in (await r.host.begin(1, 't1'))).toBe(true)
  })

  test('10 минут простоя — процесс закрыт; begin грузит заново', async () => {
    const r = rig()
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    r.host.end(1, s)
    r.w().reply({ type: 'done', session: s })
    vi.advanceTimersByTime(599_000)
    expect(r.w().killed).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(r.w().killed).toBe(true)
    await tick()
    expect(r.logs).toEqual([]) // закрыли сами — не падение
    await begin(r)
    expect(r.workers).toHaveLength(2)
    expect(kinds(r).slice(-1)).toEqual(['loading'])
  })

  test('сессия не даёт закрыть процесс по простою', async () => {
    const r = rig()
    await begin(r)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    vi.advanceTimersByTime(30 * 60_000)
    expect(r.w().killed).toBe(false)
  })

  test('смена модели закрывает процесс после done текущей сессии', async () => {
    const r = rig('gigaam-v3', ['gigaam-v3', 'parakeet-v3'])
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    r.settings = { model: 'parakeet-v3', replacements: null }
    r.host.modelChanged()
    expect(r.w().killed).toBe(false)
    r.host.end(1, s)
    expect(r.w().killed).toBe(false)
    r.w().reply({ type: 'final', session: s, phrase: 0, text: 'Хвост.', joinsPrevious: false })
    r.w().reply({ type: 'done', session: s })
    expect(r.w().killed).toBe(true)
    expect(kinds(r)).toEqual(['loading', 'ready', 'final', 'done'])
    await tick()
    await begin(r)
    expect(r.workers).toHaveLength(2)
    expect(r.w().sent[0]).toMatchObject({ type: 'load', paths: parakeet })
  })

  test('смена модели без сессии закрывает процесс сразу', async () => {
    const r = rig()
    const s = await begin(r)
    r.host.end(1, s)
    r.w().reply({ type: 'done', session: s })
    r.host.modelChanged()
    expect(r.w().killed).toBe(true)
  })

  test('pid whisper-server убит при выходе процесса', async () => {
    const r = rig('whisper-turbo-cuda', ['whisper-turbo-cuda'])
    await begin(r)
    r.w().reply({ type: 'pid', pid: 4242 })
    r.w().crash()
    expect(r.killedPids).toEqual([4242])
    // и при штатном закрытии
    await begin(r)
    r.w().reply({ type: 'pid', pid: 777 })
    r.host.dispose()
    await tick()
    expect(r.killedPids).toEqual([4242, 777])
  })

  test('gpu-failed при готовой GigaAM — gpu-fallback и перезапуск с GigaAM', async () => {
    const r = rig('whisper-turbo-cuda', ['whisper-turbo-cuda', 'gigaam-v3'])
    const s = await begin(r)
    const first = r.w()
    r.host.audio(1, s, pcm())
    r.host.audio(1, s, pcm())
    first.reply({ type: 'failed', code: 'gpu-failed', message: 'no CUDA devices' })
    expect(first.killed).toBe(true)
    expect(r.workers).toHaveLength(2)
    // Сказанное до отказа не теряется: новый процесс получает его заново.
    expect(r.w().types()).toEqual(['load', 'start', 'audio', 'audio'])
    expect(r.w().sent[0]).toMatchObject({ type: 'load', paths: giga })
    expect(r.w().sent[1]).toMatchObject({ type: 'start', session: s })
    expect(kinds(r)).toEqual(['loading', 'error:gpu-fallback'])
    await tick()
    expect(r.logs).toHaveLength(1)
    expect(r.logs[0].message).toContain('no CUDA devices')
    r.host.audio(1, s, pcm())
    expect(r.w().types()).toEqual(['load', 'start', 'audio', 'audio', 'audio'])
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    expect(kinds(r).slice(-1)).toEqual(['ready'])
    // Настройка не меняется: отказ — только на эту сессию.
    expect(r.settings.model).toBe('whisper-turbo-cuda')
  })

  test('gpu-failed без GigaAM — gpu-failed', async () => {
    const r = rig('whisper-turbo-cuda', ['whisper-turbo-cuda'])
    const s = await begin(r)
    r.w().reply({ type: 'failed', code: 'gpu-failed', message: 'no CUDA devices' })
    expect(r.workers).toHaveLength(1)
    expect(r.w().killed).toBe(true)
    expect(r.events.slice(-1)).toEqual([{ owner: 1, e: { session: s, kind: 'error', code: 'gpu-failed' } }])
    r.host.audio(1, s, pcm())
    expect(r.w().types()).toEqual(['load', 'start'])
  })

  test('ort-conflict, engine-missing и load-failed — ошибки с теми же кодами', async () => {
    for (const code of ['ort-conflict', 'engine-missing', 'load-failed'] as const) {
      const r = rig()
      const s = await begin(r)
      r.w().reply({ type: 'failed', code, message: 'x' })
      expect(r.events.slice(-1)).toEqual([{ owner: 1, e: { session: s, kind: 'error', code } }])
      expect(r.w().killed).toBe(true)
      await tick()
      expect(r.logs).toHaveLength(1)
      expect(r.logs[0].message).toContain(code)
      // ort-conflict и engine-missing повторять бессмысленно; load-failed — можно.
      const again = await r.host.begin(1, 't1')
      if (code === 'load-failed') expect('session' in again).toBe(true)
      else expect(again).toEqual({ error: code })
    }
  })

  test('I2: процесс упал при загрузке, в stderr «requested API version» — ort-conflict сразу и до перезапуска', async () => {
    const r = rig()
    const s = await begin(r)
    r.w().tail =
      '[voice] loading\nThe requested API version [28] is not available, only API versions [1, 17] are supported in this build.\n'
    r.w().crash(139)
    expect(r.events.slice(-1)).toEqual([{ owner: 1, e: { session: s, kind: 'error', code: 'ort-conflict' } }])
    expect(r.logs).toHaveLength(1)
    expect(r.logs[0].message).toContain('139')
    expect(r.logs[0].message).toContain('requested API version [28]')
    expect(await r.host.begin(1, 't1')).toEqual({ error: 'ort-conflict' })
    expect(r.workers).toHaveLength(1)
  })

  test('I2: падение после загрузки с тем же stderr — обычное engine-crashed', async () => {
    const r = rig()
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    r.w().tail = 'The requested API version [28] is not available'
    r.w().crash(139)
    expect(r.events.slice(-1)).toEqual([{ owner: 1, e: { session: s, kind: 'error', code: 'engine-crashed' } }])
    expect('session' in (await r.host.begin(1, 't1'))).toBe(true)
  })

  test('журнал падения несёт хвост stderr процесса (код выхода whisper-server)', async () => {
    const r = rig('whisper-turbo-cuda', ['whisper-turbo-cuda'])
    await begin(r)
    r.w().reply({ type: 'loaded', model: 'whisper-turbo-cuda', ms: 1 })
    r.w().tail = '[voice] whisper-server exited with code 3221226505\n'
    r.w().crash(1)
    expect(r.logs[0].message).toContain('exited with code 1')
    expect(r.logs[0].message).toContain('whisper-server exited with code 3221226505')
  })

  test('I1 сторож: после stop нет done за 30 с — процесс закрыт, engine-crashed, сервер убит', async () => {
    const r = rig('whisper-turbo-cuda', ['whisper-turbo-cuda'])
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'whisper-turbo-cuda', ms: 1 })
    r.w().reply({ type: 'pid', pid: 99 })
    r.host.end(1, s)
    vi.advanceTimersByTime(29_000)
    expect(r.w().killed).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(r.w().killed).toBe(true)
    expect(r.killedPids).toEqual([99])
    expect(kinds(r).slice(-1)).toEqual(['error:engine-crashed'])
    expect(r.logs.slice(-1)[0].message).toMatch(/30 s/)
    await tick() // выход процесса — второй ошибки нет
    expect(kinds(r).filter((k) => k.startsWith('error'))).toHaveLength(1)
    await begin(r)
    expect(r.workers).toHaveLength(2)
  })

  test('сторож: stop во время загрузки считает от загрузки; каждый final продлевает', async () => {
    const r = rig()
    const s = await begin(r)
    r.host.end(1, s)
    vi.advanceTimersByTime(40_000)
    expect(r.w().killed).toBe(false)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 40_000 })
    vi.advanceTimersByTime(29_000)
    r.w().reply({ type: 'final', session: s, phrase: 0, text: 'Раз.', joinsPrevious: false })
    vi.advanceTimersByTime(29_000)
    expect(r.w().killed).toBe(false)
    r.w().reply({ type: 'done', session: s })
    vi.advanceTimersByTime(60_000)
    expect(r.w().killed).toBe(false)
    expect(kinds(r)).toEqual(['loading', 'ready', 'final', 'done'])
  })

  test('сторож: новая сессия, сменившая прежнюю, тоже ждёт её done не дольше 30 с', async () => {
    const r = rig()
    await begin(r, 1, 't1')
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    const s2 = await begin(r, 2, 't2')
    vi.advanceTimersByTime(30_000)
    expect(r.w().killed).toBe(true)
    expect(r.events.filter((x) => x.e.kind === 'error').map((x) => x.e.session)).toContain(s2)
  })

  test('I3: release загруженной модели закрывает процесс; промис — после выхода и kill pid сервера', async () => {
    const r = rig('whisper-turbo-cuda', ['whisper-turbo-cuda'])
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'whisper-turbo-cuda', ms: 1 })
    r.w().reply({ type: 'pid', pid: 4242 })
    r.host.end(1, s)
    r.w().reply({ type: 'done', session: s })
    r.w().manualExit = true
    let released = false
    const p = r.host.release('whisper-turbo-cuda').then(() => (released = true))
    await tick()
    expect(r.w().killed).toBe(true)
    expect(released).toBe(false)
    r.w().crash(0)
    await p
    expect(r.killedPids).toEqual([4242])
    expect(r.logs).toEqual([])
    expect(kinds(r).filter((k) => k.startsWith('error'))).toEqual([])
  })

  test('I3: release другой модели процесс не трогает', async () => {
    const r = rig('gigaam-v3', ['gigaam-v3', 'parakeet-v3'])
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    await r.host.release('parakeet-v3')
    expect(r.w().killed).toBe(false)
    r.host.audio(1, s, pcm())
    expect(r.w().types()).toEqual(['load', 'start', 'audio'])
  })

  test('I3: release во время записи — запись заканчивается, её final и done доходят, потом процесс закрыт', async () => {
    const r = rig()
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    let released = false
    const p = r.host.release('gigaam-v3').then(() => (released = true))
    await tick()
    expect(r.w().types()).toEqual(['load', 'start', 'stop'])
    expect(r.w().killed).toBe(false)
    r.w().reply({ type: 'final', session: s, phrase: 0, text: 'Хвост.', joinsPrevious: false })
    r.w().reply({ type: 'done', session: s })
    await p
    expect(released).toBe(true)
    expect(r.w().killed).toBe(true)
    expect(kinds(r)).toEqual(['loading', 'ready', 'final', 'done'])
  })

  test('I3: release ждёт выхода процесса, уже отпущенного сменой модели', async () => {
    const r = rig('gigaam-v3', ['gigaam-v3', 'parakeet-v3'])
    const s = await begin(r)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    r.host.end(1, s)
    r.w().reply({ type: 'done', session: s })
    const old = r.w()
    old.manualExit = true
    r.settings = { model: 'parakeet-v3', replacements: null }
    r.host.modelChanged()
    expect(old.killed).toBe(true)
    let released = false
    const p = r.host.release('gigaam-v3').then(() => (released = true))
    await tick()
    expect(released).toBe(false)
    old.crash(0)
    await p
    expect(released).toBe(true)
  })

  test('I3: процесс не вышел за 5 с после kill — pid сервера убит, release не висит', async () => {
    const r = rig('whisper-turbo-cuda', ['whisper-turbo-cuda'])
    await begin(r)
    r.w().reply({ type: 'pid', pid: 31 })
    const w = r.w()
    w.manualExit = true
    const s = r.events[0].e.session
    r.host.end(1, s)
    w.reply({ type: 'done', session: s })
    const p = r.host.release('whisper-turbo-cuda')
    await vi.advanceTimersByTimeAsync(5_000)
    await p
    expect(r.killedPids).toEqual([31])
  })

  test('M8: окно перезагрузилось или упало — его запись остановлена, звук больше не принимается', async () => {
    const r = rig()
    const s = await begin(r, 5)
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    r.host.endOwner(6)
    expect(r.w().types()).toEqual(['load', 'start'])
    r.host.endOwner(5)
    expect(r.w().types()).toEqual(['load', 'start', 'stop'])
    r.host.audio(5, s, pcm())
    expect(r.w().types()).toEqual(['load', 'start', 'stop'])
  })

  test('новое begin завершает прежнюю сессию, её final уходит прежнему владельцу', async () => {
    const r = rig()
    const s1 = await begin(r, 1, 't1')
    r.w().reply({ type: 'loaded', model: 'gigaam-v3', ms: 1 })
    const s2 = await begin(r, 2, 't2')
    expect(r.w().sent.map((m) => `${m.type}${'session' in m ? ':' + (m.session === s1 ? 1 : 2) : ''}`)).toEqual([
      'load',
      'start:1',
      'stop:1',
      'start:2'
    ])
    r.w().reply({ type: 'final', session: s1, phrase: 0, text: 'Первая.', joinsPrevious: false })
    r.w().reply({ type: 'done', session: s1 })
    r.w().reply({ type: 'final', session: s2, phrase: 0, text: 'Вторая.', joinsPrevious: false })
    const finals = r.events.filter((x) => x.e.kind === 'final')
    expect(finals.map((x) => [x.owner, x.e.session])).toEqual([
      [1, s1],
      [2, s2]
    ])
    expect(r.events.find((x) => x.e.kind === 'done')).toEqual({ owner: 1, e: { session: s1, kind: 'done' } })
    // прежняя сессия больше не принимает звук
    r.host.audio(1, s1, pcm())
    expect(r.w().sent.filter((m) => m.type === 'audio')).toHaveLength(0)
  })
})

test('whisperPrompt: до 20 уникальных замен через запятую', () => {
  expect(whisperPrompt([])).toBe('Диктовка задачи для программиста.')
  const many = Array.from({ length: 30 }, (_, i) => ({ from: `w${i}`, to: `T${i % 25}` }))
  const p = whisperPrompt([{ from: 'a', to: 'Claude' }, { from: 'b', to: 'Claude' }, ...many])
  const list = p.replace('Диктовка задачи для программиста. ', '').split(', ')
  expect(list).toHaveLength(20)
  expect(new Set(list).size).toBe(20)
  expect(list[0]).toBe('Claude')
})
