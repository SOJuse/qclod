/**
 * What the file viewer gets for a local file (этап 7, H2). Declared here, not in
 * types.ts: the stage-7 contract is closed. Stage 6 brings its own reader
 * (`readForViewer`); the viewer's one read function is the place to swap.
 */
export type ViewerFile =
  | { kind: 'text'; text: string; size: number; truncated: boolean }
  | { kind: 'binary'; size: number }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
