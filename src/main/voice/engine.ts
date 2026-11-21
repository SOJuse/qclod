import type { VoiceModelId } from '../../shared/voice'

/** What the fake engine needs to know about the call; real engines ignore it. */
export interface DecodeHint {
  phrase: number
  final: boolean
}

export interface SpeechEngine {
  readonly model: VoiceModelId
  /** Loads the model and decodes 0.5 s of silence (warm-up). */
  load(): Promise<void>
  /** The whole phrase so far, 16 kHz mono. The text is as the model gave it. */
  decode(pcm: Float32Array, hint?: DecodeHint): Promise<string>
  dispose(): Promise<void>
}

/** Finds phrase boundaries in a stream of 16 kHz mono sound. */
export interface VoiceActivity {
  /** Any length. */
  accept(pcm: Float32Array): void
  readonly speaking: boolean
  /** How many phrases silence has closed since the last call. */
  takeClosed(): number
  flush(): void
  reset(): void
}

export interface PhraseEvent {
  kind: 'partial' | 'final'
  phrase: number
  text: string
  /** The phrase was cut at its maximum length and goes on in the next one. */
  cut?: boolean
}
