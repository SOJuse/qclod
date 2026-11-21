// Runs in the AudioWorklet scope: takes the first channel, brings it to 16 kHz
// and posts chunks of 1600 samples. Loaded through `?worker&url`, so it is an
// asset of the same origin (CSP stays `default-src 'self'`).
import { ChunkCollector } from './chunkCollector'
import { resampleLinear } from './resample'

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: unknown) => AudioWorkletProcessor
): void

class PcmTap extends AudioWorkletProcessor {
  private readonly collector = new ChunkCollector(1600)
  private readonly from = sampleRate

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    const block = this.from === 16000 ? ch : resampleLinear(ch, this.from, 16000)
    for (const chunk of this.collector.push(block)) this.port.postMessage(chunk, [chunk.buffer])
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)
