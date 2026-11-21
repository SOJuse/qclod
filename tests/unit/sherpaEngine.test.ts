import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  SherpaEngine,
  sherpaConfig,
  voiceThreads,
  type SherpaModule,
  type SherpaPaths
} from '@main/voice/sherpaEngine'
import { SileroVad, vadConfig } from '@main/voice/sileroVad'

const TMP = mkdtempSync(join(tmpdir(), 'qclod-vad-'))
const SILERO = join(TMP, 'silero_vad.onnx')
writeFileSync(SILERO, '')
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const GIGA: SherpaPaths = {
  model: 'gigaam-v3',
  encoder: 'C:\\m\\g\\encoder.int8.onnx',
  decoder: 'C:\\m\\g\\decoder.onnx',
  joiner: 'C:\\m\\g\\joiner.onnx',
  tokens: 'C:\\m\\g\\tokens.txt'
}
const PARA: SherpaPaths = {
  model: 'parakeet-v3',
  encoder: 'C:\\m\\p\\encoder.int8.onnx',
  decoder: 'C:\\m\\p\\decoder.int8.onnx',
  joiner: 'C:\\m\\p\\joiner.int8.onnx',
  tokens: 'C:\\m\\p\\tokens.txt'
}

interface Stub {
  module: SherpaModule
  configs: Array<Record<string, unknown>>
  decoded: Float32Array[]
  vadChunks: number[]
  frontArgs: unknown[]
  vadBuffer: number[]
  /** Set by a test: the VAD reports these many closed segments after the next chunk. */
  segmentsNext: { n: number; detected: boolean }
}

function stub(opts: { failWith?: string; text?: string } = {}): Stub {
  const s: Stub = {
    configs: [],
    decoded: [],
    vadChunks: [],
    frontArgs: [],
    vadBuffer: [],
    segmentsNext: { n: 0, detected: false },
    module: undefined as unknown as SherpaModule
  }
  let pending = 0
  let detected = false
  class Stream {
    samples: Float32Array | null = null
    acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void {
      expect(w.sampleRate).toBe(16000)
      this.samples = w.samples
    }
  }
  class OfflineRecognizer {
    constructor(config: Record<string, unknown>) {
      if (opts.failWith !== undefined) throw new Error(opts.failWith)
      s.configs.push(config)
    }
    createStream(): Stream {
      return new Stream()
    }
    decode(st: Stream): void {
      s.decoded.push(st.samples!)
    }
    getResult(): { text: string } {
      return { text: opts.text ?? '  привет  ' }
    }
  }
  class Vad {
    constructor(config: Record<string, unknown>, seconds: number) {
      s.configs.push(config)
      s.vadBuffer.push(seconds)
    }
    acceptWaveform(samples: Float32Array): void {
      s.vadChunks.push(samples.length)
      pending += s.segmentsNext.n
      detected = s.segmentsNext.detected
      s.segmentsNext = { n: 0, detected }
    }
    isEmpty(): boolean {
      return pending === 0
    }
    isDetected(): boolean {
      return detected
    }
    front(ext?: boolean): { start: number; samples: Float32Array } {
      s.frontArgs.push(ext)
      return { start: 0, samples: new Float32Array(10) }
    }
    pop(): void {
      pending -= 1
    }
    flush(): void {}
    reset(): void {
      pending = 0
      detected = false
    }
    clear(): void {
      pending = 0
    }
  }
  s.module = { OfflineRecognizer, Vad } as unknown as SherpaModule
  return s
}

describe('sherpaConfig', () => {
  test('GigaAM: 64 признака, nemo_transducer, CPU, жадный поиск', () => {
    expect(sherpaConfig(GIGA, 4)).toEqual({
      featConfig: { sampleRate: 16000, featureDim: 64 },
      modelConfig: {
        transducer: { encoder: GIGA.encoder, decoder: GIGA.decoder, joiner: GIGA.joiner },
        tokens: GIGA.tokens,
        numThreads: 4,
        provider: 'cpu',
        modelType: 'nemo_transducer',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    })
  })

  test('Parakeet: 128 признаков, остальное то же', () => {
    const c = sherpaConfig(PARA, 2) as {
      featConfig: { featureDim: number; sampleRate: number }
      modelConfig: Record<string, unknown>
    }
    expect(c.featConfig).toEqual({ sampleRate: 16000, featureDim: 128 })
    expect(c.modelConfig['transducer']).toEqual({
      encoder: PARA.encoder,
      decoder: PARA.decoder,
      joiner: PARA.joiner
    })
    expect(c.modelConfig['numThreads']).toBe(2)
    expect(c.modelConfig['modelType']).toBe('nemo_transducer')
  })
})

test('voiceThreads: ядра минус два, от 1 до 4', () => {
  expect(voiceThreads(12)).toBe(4)
  expect(voiceThreads(2)).toBe(1)
  expect(voiceThreads(1)).toBe(1)
  expect(voiceThreads(5)).toBe(3)
})

describe('SherpaEngine', () => {
  test('load() создаёт распознаватель и прогревает его 8000 нулями', async () => {
    const s = stub()
    const e = new SherpaEngine(GIGA, 4, s.module)
    expect(e.model).toBe('gigaam-v3')
    await e.load()
    expect(s.configs).toEqual([sherpaConfig(GIGA, 4)])
    expect(s.decoded).toHaveLength(1)
    expect(s.decoded[0].length).toBe(8000)
    expect(s.decoded[0].every((x) => x === 0)).toBe(true)
  })

  test('decode отдаёт копию звука и текст без пробелов по краям', async () => {
    const s = stub()
    const e = new SherpaEngine(PARA, 4, s.module)
    await e.load()
    const pcm = new Float32Array([0.1, 0.2, 0.3])
    expect(await e.decode(pcm)).toBe('привет')
    const sent = s.decoded[1]
    expect(sent).not.toBe(pcm)
    expect(Array.from(sent)).toEqual(Array.from(pcm))
  })

  test('ошибка с «API version» — ort-conflict', async () => {
    const s = stub({ failWith: 'requested API version [23] is not available' })
    const e = new SherpaEngine(GIGA, 4, s.module)
    await expect(e.load()).rejects.toMatchObject({ code: 'ort-conflict' })
  })

  test('любая другая ошибка загрузки — load-failed', async () => {
    const s = stub({ failWith: 'No such file: encoder.int8.onnx' })
    const e = new SherpaEngine(GIGA, 4, s.module)
    await expect(e.load()).rejects.toMatchObject({ code: 'load-failed' })
  })

  test('decode до load — ошибка, а не падение процесса', async () => {
    const e = new SherpaEngine(GIGA, 4, stub().module)
    await expect(e.decode(new Float32Array(10))).rejects.toThrow()
  })
})

describe('SileroVad', () => {
  test('vadConfig — значения плана', () => {
    expect(vadConfig('C:\\m\\silero_vad.onnx')).toEqual({
      sileroVad: {
        model: 'C:\\m\\silero_vad.onnx',
        threshold: 0.5,
        minSilenceDuration: 0.65,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: 512
      },
      sampleRate: 16000,
      numThreads: 1,
      debug: false
    })
  })

  test('буфер 30 с; куски 100 и 700 сэмплов — sherpa получает ровно по 512', () => {
    const s = stub()
    const v = new SileroVad(SILERO, s.module)
    expect(s.vadBuffer).toEqual([30])
    v.accept(new Float32Array(100))
    expect(s.vadChunks).toEqual([])
    v.accept(new Float32Array(700))
    expect(s.vadChunks).toEqual([512])
    v.accept(new Float32Array(300))
    // 100 + 700 + 300 = 1100 → две полных окна, 76 в остатке
    expect(s.vadChunks).toEqual([512, 512])
  })

  test('закрытые сегменты снимаются через front(false) и pop; speaking — isDetected', () => {
    const s = stub()
    const v = new SileroVad(SILERO, s.module)
    s.segmentsNext = { n: 0, detected: true }
    v.accept(new Float32Array(512))
    expect(v.speaking).toBe(true)
    expect(v.takeClosed()).toBe(0)
    s.segmentsNext = { n: 2, detected: false }
    v.accept(new Float32Array(512))
    expect(v.speaking).toBe(false)
    expect(v.takeClosed()).toBe(2)
    expect(v.takeClosed()).toBe(0)
    expect(s.frontArgs).toEqual([false, false])
  })

  test('окно для sherpa — копия, а не вид на чужой буфер', () => {
    const s = stub()
    const seen: Float32Array[] = []
    const mod = s.module as unknown as { Vad: { prototype: { acceptWaveform(x: Float32Array): void } } }
    const orig = mod.Vad.prototype.acceptWaveform
    mod.Vad.prototype.acceptWaveform = function (x: Float32Array): void {
      seen.push(x)
      orig.call(this, x)
    }
    const v = new SileroVad(SILERO, s.module)
    const big = new Float32Array(2048)
    v.accept(big)
    expect(seen).toHaveLength(4)
    for (const w of seen) expect(w.buffer).not.toBe(big.buffer)
  })

  test('нет файла модели — load-failed, sherpa не спрашивается', () => {
    const s = stub()
    expect(() => new SileroVad(join(TMP, 'nope.onnx'), s.module)).toThrow(
      expect.objectContaining({ code: 'load-failed' })
    )
    expect(s.vadBuffer).toEqual([])
  })

  test('flush закрывает идущую фразу; reset всё сбрасывает', () => {
    const s = stub()
    const v = new SileroVad(SILERO, s.module)
    s.segmentsNext = { n: 0, detected: true }
    v.accept(new Float32Array(512))
    v.flush()
    expect(v.speaking).toBe(false)
    expect(v.takeClosed()).toBe(1)
    s.segmentsNext = { n: 1, detected: true }
    v.accept(new Float32Array(600))
    v.reset()
    expect(v.speaking).toBe(false)
    expect(v.takeClosed()).toBe(0)
    v.accept(new Float32Array(500))
    // остаток после reset забыт: 500 < 512
    expect(s.vadChunks).toEqual([512, 512])
  })
})
