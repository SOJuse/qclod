import type { VoiceModelId, VoiceReplacement } from '../../shared/voice'
import type { SherpaPaths } from './sherpaEngine'

/** Everything the voice process needs to load a model. */
export type ModelPaths =
  | ({ kind: 'sherpa'; vad: string } & SherpaPaths)
  | { kind: 'whisper'; model: 'whisper-turbo-cuda'; exe: string; ggml: string; vad: string }

/** main → voice process. */
export type ToWorker =
  | { type: 'load'; paths: ModelPaths; threads: number; prompt: string }
  | { type: 'start'; session: string; replacements: VoiceReplacement[] }
  | { type: 'audio'; session: string; pcm: Float32Array }
  | { type: 'stop'; session: string }

/** voice process → main. */
export type FromWorker =
  | { type: 'loaded'; model: VoiceModelId; ms: number }
  | { type: 'partial'; session: string; phrase: number; text: string }
  | { type: 'final'; session: string; phrase: number; text: string; joinsPrevious: boolean }
  | { type: 'done'; session: string }
  | { type: 'failed'; code: 'ort-conflict' | 'load-failed' | 'gpu-failed'; message: string }
  | { type: 'pid'; pid: number }

/** Sound the voice process (and the host, for a restart) keeps while the model loads. */
export const LOAD_BUFFER_SAMPLES = 30 * 16_000
