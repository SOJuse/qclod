import type { SpeechEngine } from './engine'

/** Files of a sherpa transducer model (GigaAM v3 or Parakeet v3). */
export type SherpaPaths = {
  model: 'gigaam-v3' | 'parakeet-v3'
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

export interface SherpaStream {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void
}

export interface SherpaRecognizer {
  createStream(): SherpaStream
  decode(s: SherpaStream): void
  getResult(s: SherpaStream): { text: string }
}

export interface SherpaSegment {
  start: number
  samples: Float32Array
}

export interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  isDetected(): boolean
  front(enableExternalBuffer?: boolean): SherpaSegment
  pop(): void
  flush(): void
  reset(): void
}

/** The part of `sherpa-onnx-node` Qclod uses (the package has no types). */
export interface SherpaModule {
  OfflineRecognizer: new (config: Record<string, unknown>) => SherpaRecognizer
  Vad: new (config: Record<string, unknown>, bufferSizeInSeconds: number) => SherpaVad
}

export type SherpaLoadCode = 'ort-conflict' | 'engine-missing' | 'load-failed'
export type SherpaLoadError = Error & { code: SherpaLoadCode }

const RATE = 16_000

/**
 * Loads the native module on first use: requiring it loads its DLLs, which
 * neither tests with a stub nor a window that never dictates should pay for.
 */
export function loadSherpa(): SherpaModule {
  return require('sherpa-onnx-node') as SherpaModule
}

/**
 * An error from loading the engine, with the code the window shows. An
 * «API version» error is a different onnxruntime.dll loaded before ours
 * (Решение 16) — though usually that one kills the process first, and main
 * finds the words in its stderr (voiceHost.ts). «Could not find
 * sherpa-onnx-node» is the package's addon.js: it swallows why the .node did
 * not load (a missing or blocked DLL of the install), so it is the install,
 * not the model, that is broken.
 */
export function sherpaLoadError(err: unknown): SherpaLoadError {
  const message = err instanceof Error ? err.message : String(err)
  const out = new Error(message) as SherpaLoadError
  out.code = /API version/i.test(message)
    ? 'ort-conflict'
    : /Could not find sherpa-onnx-node/i.test(message)
      ? 'engine-missing'
      : 'load-failed'
  return out
}

/** Threads for decoding: leave two cores to the rest of the machine, at most 4. */
export function voiceThreads(cores: number): number {
  return Math.max(1, Math.min(4, cores - 2))
}

export function sherpaConfig(p: SherpaPaths, threads: number): Record<string, unknown> {
  return {
    featConfig: { sampleRate: RATE, featureDim: p.model === 'parakeet-v3' ? 128 : 64 },
    modelConfig: {
      transducer: { encoder: p.encoder, decoder: p.decoder, joiner: p.joiner },
      tokens: p.tokens,
      numThreads: threads,
      provider: 'cpu',
      modelType: 'nemo_transducer',
      debug: 0
    },
    decodingMethod: 'greedy_search'
  }
}

/** GigaAM v3 or Parakeet v3 through sherpa-onnx's offline recognizer, on the CPU. */
export class SherpaEngine implements SpeechEngine {
  readonly model: SherpaPaths['model']
  private recognizer: SherpaRecognizer | null = null

  constructor(
    private readonly paths: SherpaPaths,
    private readonly threads: number,
    private readonly sherpa?: SherpaModule
  ) {
    this.model = paths.model
  }

  async load(): Promise<void> {
    try {
      const mod = this.sherpa ?? loadSherpa()
      this.recognizer = new mod.OfflineRecognizer(sherpaConfig(this.paths, this.threads))
      // Warm-up: the first decode is the expensive one (06 §1).
      this.run(new Float32Array(RATE / 2))
    } catch (err) {
      this.recognizer = null
      throw sherpaLoadError(err)
    }
  }

  async decode(pcm: Float32Array): Promise<string> {
    return this.run(pcm)
  }

  async dispose(): Promise<void> {
    this.recognizer = null
  }

  private run(pcm: Float32Array): string {
    const r = this.recognizer
    if (r === null) throw new Error('voice engine is not loaded')
    const s = r.createStream()
    // A copy: the native side may keep a view on what it is given (03 §5.1).
    s.acceptWaveform({ sampleRate: RATE, samples: pcm.slice() })
    r.decode(s)
    return r.getResult(s).text.trim()
  }
}
