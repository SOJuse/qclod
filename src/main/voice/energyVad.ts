import type { VoiceActivity } from './engine'

const WINDOW = 512
const RMS_SPEECH = 0.02
/** Speech starts after this much voiced sound (0.25 s at 16 kHz). */
const SPEECH_SAMPLES = 4000
/** Voiced sound is forgotten after this long a gap before speech has started (0.2 s). */
const ONSET_GAP_SAMPLES = 3200
/** A phrase closes after this much silence (0.65 s). */
const CLOSE_SAMPLES = 10_400

/**
 * The simplest phrase detector: window RMS against a threshold. Windows sit on
 * the stream's own grid, so the chunk size does not change the answer.
 */
export class EnergyVad implements VoiceActivity {
  speaking = false
  private closed = 0
  private window = new Float32Array(WINDOW)
  private filled = 0
  private voiced = 0
  private gap = 0
  private silence = 0

  accept(pcm: Float32Array): void {
    let at = 0
    while (at < pcm.length) {
      const take = Math.min(WINDOW - this.filled, pcm.length - at)
      this.window.set(pcm.subarray(at, at + take), this.filled)
      this.filled += take
      at += take
      if (this.filled === WINDOW) {
        this.filled = 0
        this.onWindow(rms(this.window))
      }
    }
  }

  takeClosed(): number {
    const n = this.closed
    this.closed = 0
    return n
  }

  flush(): void {
    if (this.speaking) this.closed += 1
    this.clearState()
  }

  reset(): void {
    this.closed = 0
    this.clearState()
  }

  private clearState(): void {
    this.speaking = false
    this.filled = 0
    this.voiced = 0
    this.gap = 0
    this.silence = 0
  }

  private onWindow(level: number): void {
    const loud = level > RMS_SPEECH
    if (this.speaking) {
      this.silence = loud ? 0 : this.silence + WINDOW
      if (this.silence >= CLOSE_SAMPLES) {
        this.closed += 1
        this.clearState()
      }
      return
    }
    if (loud) {
      this.voiced += WINDOW
      this.gap = 0
      if (this.voiced >= SPEECH_SAMPLES) {
        this.speaking = true
        this.silence = 0
      }
    } else if (this.voiced > 0) {
      this.gap += WINDOW
      if (this.gap >= ONSET_GAP_SAMPLES) {
        this.voiced = 0
        this.gap = 0
      }
    }
  }
}

function rms(w: Float32Array): number {
  let sum = 0
  for (let i = 0; i < w.length; i++) sum += w[i] * w[i]
  return Math.sqrt(sum / w.length)
}
