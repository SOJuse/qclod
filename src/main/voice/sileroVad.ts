import type { VoiceActivity } from './engine'
import { loadSherpa, sherpaLoadError, type SherpaModule, type SherpaVad } from './sherpaEngine'

const WINDOW = 512
const BUFFER_SECONDS = 30

export function vadConfig(model: string): Record<string, unknown> {
  return {
    sileroVad: {
      model,
      threshold: 0.5,
      minSilenceDuration: 0.65,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 20,
      windowSize: WINDOW
    },
    sampleRate: 16_000,
    numThreads: 1,
    debug: false
  }
}

/**
 * Silero VAD through sherpa-onnx. sherpa is fed exactly one window (512
 * samples) at a time; a segment silence has closed is one closed phrase. The
 * segments' sound is not used — LiveDecoder keeps its own.
 */
export class SileroVad implements VoiceActivity {
  speaking = false
  private readonly vad: SherpaVad
  private readonly window = new Float32Array(WINDOW)
  private filled = 0
  private closed = 0

  constructor(model: string, sherpa?: SherpaModule) {
    try {
      const mod = sherpa ?? loadSherpa()
      this.vad = new mod.Vad(vadConfig(model), BUFFER_SECONDS)
    } catch (err) {
      throw sherpaLoadError(err)
    }
  }

  accept(pcm: Float32Array): void {
    let at = 0
    while (at < pcm.length) {
      const take = Math.min(WINDOW - this.filled, pcm.length - at)
      this.window.set(pcm.subarray(at, at + take), this.filled)
      this.filled += take
      at += take
      if (this.filled === WINDOW) {
        this.filled = 0
        // A copy: `window` is reused for the next one.
        this.vad.acceptWaveform(this.window.slice())
        this.closed += this.drain()
        this.speaking = this.vad.isDetected()
      }
    }
  }

  takeClosed(): number {
    const n = this.closed
    this.closed = 0
    return n
  }

  flush(): void {
    const wasSpeaking = this.speaking
    this.vad.flush()
    const n = this.drain()
    this.closed += n > 0 ? n : wasSpeaking ? 1 : 0
    this.vad.reset()
    this.speaking = false
    this.filled = 0
  }

  reset(): void {
    this.vad.reset()
    this.speaking = false
    this.filled = 0
    this.closed = 0
  }

  private drain(): number {
    let n = 0
    while (!this.vad.isEmpty()) {
      this.vad.front(false)
      this.vad.pop()
      n += 1
    }
    return n
  }
}
