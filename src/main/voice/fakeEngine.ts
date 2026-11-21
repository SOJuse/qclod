import type { VoiceModelId } from '../../shared/voice'
import type { DecodeHint, SpeechEngine } from './engine'

/** Marker for `check:seams`: a release build must not carry the fake engine. */
export const FAKE_SPEECH_MARK = 'e2e: fake speech'

const RATE = 16_000
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

/**
 * A scripted engine for tests: the final of phrase N is `script[N % length]`,
 * a partial is the first words of the same line, growing with the length of
 * the sound (all of it at a second).
 */
export class FakeSpeechEngine implements SpeechEngine {
  readonly model: VoiceModelId = 'gigaam-v3'
  readonly mark = FAKE_SPEECH_MARK
  private readonly loadMs: number
  private readonly decodeMs: number

  constructor(
    private readonly script: string[],
    opts: { loadMs?: number; decodeMs?: number } = {}
  ) {
    this.loadMs = opts.loadMs ?? 0
    this.decodeMs = opts.decodeMs ?? 0
  }

  async load(): Promise<void> {
    await sleep(this.loadMs)
  }

  async decode(pcm: Float32Array, hint?: DecodeHint): Promise<string> {
    await sleep(this.decodeMs)
    if (this.script.length === 0) return ''
    const line = this.script[(hint?.phrase ?? 0) % this.script.length]
    if (hint?.final === true) return line
    const words = line.split(/\s+/).filter((w) => w.length > 0)
    const seconds = pcm.length / RATE
    const count = Math.ceil(words.length * Math.min(1, seconds / 1.0))
    return words.slice(0, count).join(' ').replace(/[.,!?…:;]+$/, '')
  }

  async dispose(): Promise<void> {}
}
