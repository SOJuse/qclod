import { ChunkCollector } from './chunkCollector'
import { resampleLinear, rms } from './resample'

export { ChunkCollector, resampleLinear, rms }

export function micErrorFrom(err: unknown): 'mic-denied' | 'mic-missing' | 'mic-busy' {
  const name = (err as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic-denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'mic-missing'
  return 'mic-busy'
}

export interface MicCapture {
  stop(): void
}

export interface MicDeps {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>
  createContext(): AudioContext
  workletUrl: string
  /** Seam for tests: AudioWorkletNode does not exist outside a browser. */
  createNode?(ctx: AudioContext): AudioWorkletNode
}

// AGC is off on purpose (03 §7.4).
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false }
}

async function defaultDeps(): Promise<MicDeps> {
  const { default: workletUrl } = await import('./pcmTap.worklet?worker&url')
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createContext: () => new AudioContext({ sampleRate: 16000 }),
    workletUrl
  }
}

/**
 * Starts the microphone. Chunks are always 16 kHz mono, 1600 samples: the
 * worklet resamples when the context could not give 16 kHz.
 */
export async function startMic(
  h: { onChunk(pcm: Float32Array): void; onLevel(rms: number): void; onEnded(): void },
  deps?: MicDeps
): Promise<MicCapture> {
  const d = deps ?? (await defaultDeps())
  const stream = await d.getUserMedia(MIC_CONSTRAINTS)
  let ctx: AudioContext | null = null
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    stream.getTracks().forEach((t) => t.stop())
    void ctx?.close().catch(() => {})
  }
  try {
    ctx = d.createContext()
    await ctx.resume()
    await ctx.audioWorklet.addModule(d.workletUrl)
    const source = ctx.createMediaStreamSource(stream)
    const node = d.createNode
      ? d.createNode(ctx)
      : new AudioWorkletNode(ctx, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0 })
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (stopped) return
      h.onChunk(e.data)
      h.onLevel(rms(e.data))
    }
    source.connect(node)
  } catch (err) {
    stop()
    throw err
  }
  let ended = false
  for (const track of stream.getAudioTracks()) {
    track.onended = () => {
      if (ended || stopped) return
      ended = true
      h.onEnded()
    }
  }
  return { stop }
}
