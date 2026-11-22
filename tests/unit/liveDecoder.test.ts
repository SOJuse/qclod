import { describe, expect, test } from 'vitest'
import { LiveDecoder, type LiveDecoderOptions } from '@main/voice/liveDecoder'
import type { DecodeHint, PhraseEvent, SpeechEngine, VoiceActivity } from '@main/voice/engine'

const CHUNK = 1600 // 100 ms at 16 kHz

/** Chunk marker: first sample 1 = speech, 0 = silence. */
function speech(): Float32Array {
  const a = new Float32Array(CHUNK)
  a[0] = 1
  return a
}
function quiet(): Float32Array {
  return new Float32Array(CHUNK)
}

/** A VAD driven by the chunk marker: closes after `closeSilenceMs` of silence. */
class ScriptVad implements VoiceActivity {
  speaking = false
  private closed = 0
  private silent = 0
  constructor(private readonly closeSilenceMs = 600) {}
  accept(pcm: Float32Array): void {
    if (pcm[0] > 0.5) {
      this.speaking = true
      this.silent = 0
    } else if (this.speaking) {
      this.silent += (pcm.length / 16) | 0
      if (this.silent >= this.closeSilenceMs) {
        this.speaking = false
        this.silent = 0
        this.closed++
      }
    }
  }
  takeClosed(): number {
    const n = this.closed
    this.closed = 0
    return n
  }
  flush(): void {
    if (this.speaking) {
      this.speaking = false
      this.closed++
    }
  }
  reset(): void {
    this.speaking = false
    this.closed = 0
    this.silent = 0
  }
}

interface Call {
  len: number
  hint?: DecodeHint
  startedAt: number
}

class Harness {
  clock = 0
  events: Array<PhraseEvent & { at: number }> = []
  calls: Call[] = []
  inFlight = 0
  maxInFlight = 0
  private waiting: Array<{ due: number; done: () => void }> = []
  readonly engine: SpeechEngine
  readonly decoder: LiveDecoder

  constructor(
    private readonly decodeMs: number,
    vad: VoiceActivity,
    opts: Partial<LiveDecoderOptions> = {}
  ) {
    this.engine = {
      model: 'gigaam-v3',
      load: async () => {},
      dispose: async () => {},
      decode: (pcm, hint) => {
        this.calls.push({ len: pcm.length, hint, startedAt: this.clock })
        this.inFlight++
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
        return new Promise<string>((resolve) => {
          const done = (): void => {
            this.inFlight--
            resolve('len=' + pcm.length)
          }
          if (this.decodeMs === 0) done()
          else this.waiting.push({ due: this.clock + this.decodeMs, done })
        })
      }
    }
    this.decoder = new LiveDecoder({
      engine: this.engine,
      vad,
      emit: (e) => this.events.push({ ...e, at: this.clock }),
      now: () => this.clock,
      ...opts
    })
  }

  async settle(): Promise<void> {
    for (let i = 0; i < 40; i++) await Promise.resolve()
  }

  /** One 100 ms chunk: time moves, due decodes finish, then the sound arrives. */
  async chunk(pcm: Float32Array): Promise<void> {
    this.clock += 100
    const due = this.waiting.filter((w) => w.due <= this.clock)
    this.waiting = this.waiting.filter((w) => w.due > this.clock)
    for (const w of due) w.done()
    await this.settle()
    this.decoder.push(pcm)
    await this.settle()
  }

  async chunks(n: number, make: () => Float32Array): Promise<void> {
    for (let i = 0; i < n; i++) await this.chunk(make())
  }

  /** Time passes with no new sound until every waiting decode is done. */
  async drain(): Promise<void> {
    for (let i = 0; i < 200 && (this.waiting.length > 0 || this.inFlight > 0); i++) {
      this.clock += 100
      const due = this.waiting.filter((w) => w.due <= this.clock)
      this.waiting = this.waiting.filter((w) => w.due > this.clock)
      for (const w of due) w.done()
      await this.settle()
    }
  }

  kinds(): string[] {
    return this.events.map((e) => `${e.kind}#${e.phrase}`)
  }
}

describe('LiveDecoder', () => {
  test('partial каждые 0,7 с речи, пока декод быстрый', async () => {
    const h = new Harness(0, new ScriptVad())
    await h.chunks(30, speech)
    const partials = h.events.filter((e) => e.kind === 'partial')
    expect(partials).toHaveLength(4)
    expect(partials.every((e) => e.phrase === 0)).toBe(true)
  })

  test('медленный декод растягивает интервал до 1,5 × времени декода', async () => {
    const h = new Harness(1000, new ScriptVad())
    await h.chunks(60, speech)
    await h.drain()
    const starts = h.calls.map((c) => c.startedAt)
    expect(starts.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1], `между запусками ${i}`).toBeGreaterThanOrEqual(1500)
    }
    const ends = h.events.filter((e) => e.kind === 'partial').map((e) => e.at)
    for (let i = 1; i < ends.length; i++) expect(ends[i] - ends[i - 1]).toBeGreaterThanOrEqual(1500)
    expect(h.maxInFlight).toBe(1)
  })

  test('тишина закрывает фразу: final заменяет partial, следующая фраза с новым номером', async () => {
    const h = new Harness(0, new ScriptVad())
    await h.chunks(10, speech)
    await h.chunks(7, quiet)
    await h.chunks(10, speech)
    await h.chunks(7, quiet)
    const kinds = h.kinds()
    expect(kinds).toContain('partial#0')
    expect(kinds).toContain('final#0')
    expect(kinds).toContain('partial#1')
    expect(kinds).toContain('final#1')
    expect(kinds.indexOf('final#0')).toBeGreaterThan(kinds.indexOf('partial#0'))
    expect(kinds.indexOf('partial#1')).toBeGreaterThan(kinds.indexOf('final#0'))
    expect(h.events.filter((e) => e.kind === 'final' && e.cut)).toHaveLength(0)
  })

  test('фраза длиннее 11 с режется: final с cut, вторая часть продолжается', async () => {
    const h = new Harness(0, new ScriptVad())
    await h.chunks(125, speech)
    const cuts = h.events.filter((e) => e.kind === 'final' && e.cut)
    expect(cuts).toHaveLength(1)
    expect(cuts[0].phrase).toBe(0)
    expect(h.events.some((e) => e.kind === 'partial' && e.phrase === 1)).toBe(true)
    // The second part starts without a pre-roll: its first decode is short.
    const second = h.calls.find((c) => c.hint?.phrase === 1 || false)
    expect(second === undefined || second.len < 11_000 * 16).toBe(true)
    await h.chunks(7, quiet)
    expect(h.events.some((e) => e.kind === 'final' && e.phrase === 1 && !e.cut)).toBe(true)
  })

  test('partial после final своей фразы выбрасывается', async () => {
    const h = new Harness(500, new ScriptVad(300))
    await h.chunks(8, speech) // a partial starts at 0.7 s and is still in flight
    expect(h.inFlight).toBe(1)
    await h.chunks(4, quiet) // the phrase closes while it flies
    await h.drain()
    const phrase0 = h.events.filter((e) => e.phrase === 0)
    expect(phrase0.map((e) => e.kind)).toEqual(['final'])
  })

  test('один декод в полёте; final обгоняет ждущий partial', async () => {
    const h = new Harness(400, new ScriptVad(300))
    await h.chunks(30, speech)
    await h.chunks(4, quiet)
    await h.chunks(30, speech)
    await h.chunks(4, quiet)
    await h.drain()
    expect(h.maxInFlight).toBe(1)
    const finals = h.events.filter((e) => e.kind === 'final')
    expect(finals.map((e) => e.phrase)).toEqual([0, 1])
    // Nothing of a phrase arrives after its final.
    for (const f of finals) {
      const fi = h.events.indexOf(f)
      expect(h.events.slice(fi + 1).some((e) => e.phrase === f.phrase)).toBe(false)
    }
  })

  test('короткий шум < 300 мс без partial не даёт final', async () => {
    const h = new Harness(0, new ScriptVad(0))
    await h.chunk(speech())
    await h.chunk(quiet())
    await h.drain()
    expect(h.events).toEqual([])
  })

  test('короткий шум < 300 мс с partial даёт пустой final', async () => {
    const h = new Harness(0, new ScriptVad(0), { partialEveryMs: 50 })
    await h.chunk(speech())
    expect(h.events.filter((e) => e.kind === 'partial')).toHaveLength(1)
    await h.chunk(quiet())
    await h.drain()
    const last = h.events[h.events.length - 1]
    expect(last).toMatchObject({ kind: 'final', phrase: 0, text: '' })
  })

  test('finish: flush, final хвоста, затем резолв', async () => {
    const h = new Harness(200, new ScriptVad())
    await h.chunks(10, speech)
    let done = false
    const p = h.decoder.finish().then(() => {
      done = true
    })
    await h.settle()
    expect(done).toBe(false)
    await h.drain()
    await p
    expect(done).toBe(true)
    const finals = h.events.filter((e) => e.kind === 'final')
    expect(finals).toHaveLength(1)
    expect(h.events[h.events.length - 1].kind).toBe('final')
  })

  test('cancel: ни одного события после', async () => {
    const h = new Harness(300, new ScriptVad())
    await h.chunks(10, speech)
    const before = h.events.length
    h.decoder.cancel()
    await h.drain()
    h.decoder.push(speech())
    await h.chunks(10, quiet)
    expect(h.events.length).toBe(before)
    await expect(h.decoder.finish()).resolves.toBeUndefined()
    expect(h.events.length).toBe(before)
  })

  test('пре-ролл 400 мс входит в буфер фразы', async () => {
    const h = new Harness(0, new ScriptVad(), { partialEveryMs: 100 })
    await h.chunks(10, quiet) // 1 s of silence before the speech
    await h.chunk(speech())
    expect(h.calls.length).toBeGreaterThan(0)
    // 400 ms of the silence (6400) plus the chunk that started the speech.
    expect(h.calls[0].len).toBeGreaterThanOrEqual(6400)
    expect(h.calls[0].len).toBe(6400 + CHUNK)
  })
})

describe('FakeSpeechEngine', () => {
  test('final — строка сценария по номеру фразы, partial — растущий префикс без пунктуации', async () => {
    const { FakeSpeechEngine, FAKE_SPEECH_MARK } = await import('@main/voice/fakeEngine')
    const e = new FakeSpeechEngine(['Раз два три четыре.', 'Пять.'])
    expect(FAKE_SPEECH_MARK).toBe('e2e: fake speech')
    expect(await e.decode(new Float32Array(16_000), { phrase: 0, final: true })).toBe('Раз два три четыре.')
    expect(await e.decode(new Float32Array(16_000), { phrase: 1, final: true })).toBe('Пять.')
    expect(await e.decode(new Float32Array(16_000), { phrase: 2, final: true })).toBe('Раз два три четыре.')
    expect(await e.decode(new Float32Array(4_000), { phrase: 0, final: false })).toBe('Раз')
    expect(await e.decode(new Float32Array(8_000), { phrase: 0, final: false })).toBe('Раз два')
    expect(await e.decode(new Float32Array(32_000), { phrase: 0, final: false })).toBe('Раз два три четыре')
    await expect(e.load()).resolves.toBeUndefined()
  })
})
