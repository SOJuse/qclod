// Interim declaration: task 5 (stage5/engine) puts ModelPaths in ./protocol.
// When the branches are merged, replace the body of this file with
//   export type { ModelPaths } from './protocol'
// The shape is exactly the one from the brief of task 5.
import type { SherpaPaths } from './sherpaEngine'

export type ModelPaths =
  | ({ kind: 'sherpa'; vad: string } & SherpaPaths)
  | { kind: 'whisper'; model: 'whisper-turbo-cuda'; exe: string; ggml: string; vad: string }
