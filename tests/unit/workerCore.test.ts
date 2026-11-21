import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkerCore } from '@main/voice/workerCore'
import { FakeSpeechEngine } from '@main/voice/fakeEngine'
import { EnergyVad } from '@main/voice/energyVad'
import type { FromWorker, ModelPaths } from '@main/voice/protocol'
import type { SpeechEngine } from '@main/voice/engine'

const RATE = 16000
const CHUNK = 1600

const PATHS: ModelPaths = {
  kind: 'sherpa',
  model: 'gigaam-v3',
  encoder: 'e',
  decoder: 'd',
  joiner: 'j',
  tokens: 't',
  vad: 'v'
}

function tone(seconds: number): Float32Array[] {
  const out: Float32Array[] = []
  const total = Math.round(seconds * RATE)
  for (let at = 0; at < total; at += CHUNK) {
    const a = new Float32Array(CHUNK)
    for (let i = 0; i < CHUNK; i++) a[i] = 0.3 * Math.sin((2 * Math.PI * 440 * (at + i)) / RATE)
    out.push(a)
  }
  return out
}
function quiet(seconds: number): Float32Array[] {
  return Array.from({ length: Math.round((seconds * RATE) / CHUNK) }, () => new Float32Array(CHUNK))
}

function setup(script: string[], engine?: () => SpeechEngine): { core: WorkerCore; posts: FromWorker[] } {
  const posts: FromWorker[] = []
  const core = new WorkerCore({
    makeEngine: engine ?? (() => new FakeSpeechEngine(script, { loadMs: 3000 })),
    makeVad: () => new EnergyVad(),
    post: (m) => posts.push(m)
  })
  return { core, posts }
}

function say(core: WorkerCore, session: string, chunks: Float32Array[]): void {
  for (const pcm of chunks) core.handle({ type: 'audio', session, pcm })
}

/** Live pace: one chunk every 100 ms, as the window sends them. */
async function sayLive(core: WorkerCore, session: string, chunks: Float32Array[]): Promise<void> {
  for (const pcm of chunks) {
    core.handle({ type: 'audio', session, pcm })
    await vi.advanceTimersByTimeAsync(100)
  }
}

const finals = (posts: FromWorker[]): FromWorker[] => posts.filter((m) => m.type === 'final')

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('WorkerCore', () => {
  test('звук, сказанный во время загрузки, распознаётся после неё', async () => {
    const { core, posts } = setup(['Привет, мир.'])
    core.handle({ type: 'load', paths: PATHS, threads: 4, prompt: '' })
    core.handle({ type: 'start', session: 's1', replacements: [] })
    say(core, 's1', [...tone(1.5), ...quiet(1)])
    await vi.advanceTimersByTimeAsync(2900)
    expect(posts).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(posts[0]).toMatchObject({ type: 'loaded', model: 'gigaam-v3' })
    expect(finals(posts)).toEqual([
      { type: 'final', session: 's1', phrase: 0, text: 'Привет, мир.', joinsPrevious: false }
    ])
  })

  test('stop до загрузки: финалы накопленного, затем done', async () => {
    const { core, posts } = setup(['Скажи что-нибудь.'])
    core.handle({ type: 'load', paths: PATHS, threads: 4, prompt: '' })
    core.handle({ type: 'start', session: 's1', replacements: [] })
    say(core, 's1', tone(1))
    core.handle({ type: 'stop', session: 's1' })
    await vi.advanceTimersByTimeAsync(3100)
    const kinds = posts.map((m) => m.type)
    expect(kinds[0]).toBe('loaded')
    expect(kinds[kinds.length - 1]).toBe('done')
    expect(finals(posts)).toEqual([
      { type: 'final', session: 's1', phrase: 0, text: 'Скажи что-нибудь.', joinsPrevious: false }
    ])
    expect(posts[posts.length - 1]).toEqual({ type: 'done', session: 's1' })
  })

  test('словарь применяется к partial и final', async () => {
    const { core, posts } = setup(['Попроси клод сделать тесты.'])
    core.handle({ type: 'load', paths: PATHS, threads: 4, prompt: '' })
    await vi.advanceTimersByTimeAsync(3100)
    core.handle({ type: 'start', session: 's1', replacements: [{ from: 'клод', to: 'Claude' }] })
    await sayLive(core, 's1', [...tone(1.5), ...quiet(1)])
    await vi.advanceTimersByTimeAsync(10)
    const partials = posts.filter((m) => m.type === 'partial')
    expect(partials.length).toBeGreaterThan(0)
    for (const p of partials) {
      if (p.type !== 'partial') continue
      expect(p.text).not.toMatch(/клод/i)
    }
    expect(partials.some((p) => p.type === 'partial' && p.text.includes('Claude'))).toBe(true)
    expect(finals(posts)).toEqual([
      { type: 'final', session: 's1', phrase: 0, text: 'Попроси Claude сделать тесты.', joinsPrevious: false }
    ])
  })

  test('разрезанная фраза: точка снята, следующий final с joinsPrevious', async () => {
    const { core, posts } = setup(['Первая часть.', 'Вторая часть.'])
    core.handle({ type: 'load', paths: PATHS, threads: 4, prompt: '' })
    await vi.advanceTimersByTimeAsync(3100)
    core.handle({ type: 'start', session: 's1', replacements: [] })
    say(core, 's1', [...tone(12), ...quiet(1)])
    core.handle({ type: 'stop', session: 's1' })
    await vi.advanceTimersByTimeAsync(10)
    expect(finals(posts)).toEqual([
      { type: 'final', session: 's1', phrase: 0, text: 'Первая часть', joinsPrevious: false },
      { type: 'final', session: 's1', phrase: 1, text: 'Вторая часть.', joinsPrevious: true }
    ])
    expect(posts[posts.length - 1]).toEqual({ type: 'done', session: 's1' })
  })

  test('новая сессия после stop прежней: звук чужой сессии не смешивается', async () => {
    const { core, posts } = setup(['Раз.', 'Два.'])
    core.handle({ type: 'load', paths: PATHS, threads: 4, prompt: '' })
    core.handle({ type: 'start', session: 's1', replacements: [] })
    say(core, 's1', tone(1))
    core.handle({ type: 'stop', session: 's1' })
    core.handle({ type: 'start', session: 's2', replacements: [] })
    say(core, 's1', tone(1)) // опоздавший звук прежней сессии
    say(core, 's2', [...tone(1), ...quiet(1)])
    core.handle({ type: 'stop', session: 's2' })
    await vi.advanceTimersByTimeAsync(3100)
    const order = posts.filter((m) => m.type === 'final' || m.type === 'done')
    expect(order).toEqual([
      { type: 'final', session: 's1', phrase: 0, text: 'Раз.', joinsPrevious: false },
      { type: 'done', session: 's1' },
      // фразы считаются в сессии заново
      { type: 'final', session: 's2', phrase: 0, text: 'Раз.', joinsPrevious: false },
      { type: 'done', session: 's2' }
    ])
  })

  test('ошибка загрузки — failed с кодом движка', async () => {
    const failing = (): SpeechEngine => ({
      model: 'gigaam-v3',
      load: async () => {
        throw Object.assign(new Error('requested API version [23] is not available'), {
          code: 'ort-conflict'
        })
      },
      decode: async () => '',
      dispose: async () => {}
    })
    const { core, posts } = setup([], failing)
    core.handle({ type: 'load', paths: PATHS, threads: 4, prompt: '' })
    core.handle({ type: 'start', session: 's1', replacements: [] })
    await vi.advanceTimersByTimeAsync(10)
    expect(posts).toEqual([
      { type: 'failed', code: 'ort-conflict', message: 'requested API version [23] is not available' }
    ])
  })
})
