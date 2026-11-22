import { describe, expect, test, vi } from 'vitest'
import {
  ChunkCollector,
  micErrorFrom,
  MIC_CONSTRAINTS,
  resampleLinear,
  rms,
  startMic,
  type MicDeps
} from '../../src/renderer/voice/micCapture'

describe('ChunkCollector', () => {
  test('13 blocks of 128 give one chunk of 1600 and a remainder of 64', () => {
    const c = new ChunkCollector(1600)
    const out: Float32Array[] = []
    for (let i = 0; i < 13; i++) out.push(...c.push(new Float32Array(128).fill(i)))
    expect(out).toHaveLength(1)
    expect(out[0]!.length).toBe(1600)
    expect(out[0]![0]).toBe(0)
    expect(out[0]![1599]).toBe(12)
    // 64 are left: 1536 more samples complete the next chunk, 1535 do not
    expect(new ChunkCollector(1600).push(new Float32Array(1599))).toHaveLength(0)
    expect(c.push(new Float32Array(1535))).toHaveLength(0)
    expect(c.push(new Float32Array(1))).toHaveLength(1)
  })
  test('one big block gives several chunks', () => {
    expect(new ChunkCollector(100).push(new Float32Array(350))).toHaveLength(3)
  })
})

describe('resampleLinear / rms', () => {
  test('48k to 16k divides the length by 3', () => {
    expect(resampleLinear(new Float32Array(4800), 48000, 16000).length).toBe(1600)
  })
  test('equal rates give a copy', () => {
    const a = Float32Array.from([1, 2, 3])
    const b = resampleLinear(a, 16000, 16000)
    expect([...b]).toEqual([1, 2, 3])
    expect(b).not.toBe(a)
  })
  test('a ramp stays a ramp', () => {
    const a = Float32Array.from({ length: 30 }, (_, i) => i)
    const b = resampleLinear(a, 48000, 16000)
    expect(b[1]).toBeCloseTo(3)
  })
  test('rms', () => {
    expect(rms(new Float32Array(0))).toBe(0)
    expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5)
  })
})

describe('micErrorFrom', () => {
  test.each([
    ['NotAllowedError', 'mic-denied'],
    ['SecurityError', 'mic-denied'],
    ['NotFoundError', 'mic-missing'],
    ['OverconstrainedError', 'mic-missing'],
    ['NotReadableError', 'mic-busy'],
    ['AbortError', 'mic-busy']
  ])('%s -> %s', (name, code) => {
    expect(micErrorFrom({ name })).toBe(code)
  })
  test('garbage is busy', () => {
    expect(micErrorFrom(null)).toBe('mic-busy')
    expect(micErrorFrom('x')).toBe('mic-busy')
  })
})

function fakes() {
  const track = { stop: vi.fn(), onended: null as null | (() => void) }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] }
  const port: { onmessage: null | ((e: { data: Float32Array }) => void) } = { onmessage: null }
  const node = { port }
  const ctx = {
    sampleRate: 16000,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() }))
  }
  const getUserMedia = vi.fn().mockResolvedValue(stream)
  const deps: MicDeps = {
    getUserMedia,
    createContext: () => ctx as never,
    workletUrl: 'worklet.js',
    createNode: () => node as never
  }
  return { track, port, ctx, getUserMedia, deps }
}

const noop = () => ({ onChunk: vi.fn(), onLevel: vi.fn(), onEnded: vi.fn() })

describe('startMic', () => {
  test('asks for mono, AGC off, and loads the worklet', async () => {
    const f = fakes()
    await startMic(noop(), f.deps)
    expect(f.getUserMedia).toHaveBeenCalledWith(MIC_CONSTRAINTS)
    expect(MIC_CONSTRAINTS).toEqual({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false }
    })
    expect(f.ctx.resume).toHaveBeenCalled()
    expect(f.ctx.audioWorklet.addModule).toHaveBeenCalledWith('worklet.js')
  })
  test('chunks and levels reach the handlers', async () => {
    const f = fakes()
    const h = noop()
    await startMic(h, f.deps)
    const pcm = new Float32Array(1600).fill(0.5)
    f.port.onmessage!({ data: pcm })
    expect(h.onChunk).toHaveBeenCalledWith(pcm)
    expect(h.onLevel.mock.calls[0]![0]).toBeCloseTo(0.5)
  })
  test('the track ending calls onEnded once', async () => {
    const f = fakes()
    const h = noop()
    await startMic(h, f.deps)
    f.track.onended!()
    f.track.onended!()
    expect(h.onEnded).toHaveBeenCalledTimes(1)
  })
  test('stop twice does not throw; the track stops and the context closes once', async () => {
    const f = fakes()
    const h = noop()
    const m = await startMic(h, f.deps)
    m.stop()
    expect(() => m.stop()).not.toThrow()
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.ctx.close).toHaveBeenCalledTimes(1)
    f.port.onmessage!({ data: new Float32Array(1600) })
    expect(h.onChunk).not.toHaveBeenCalled()
  })
  test('a failed worklet load releases the microphone and rethrows', async () => {
    const f = fakes()
    f.ctx.audioWorklet.addModule.mockRejectedValue(new Error('boom'))
    await expect(startMic(noop(), f.deps)).rejects.toThrow('boom')
    expect(f.track.stop).toHaveBeenCalled()
  })
  test('a getUserMedia rejection reaches micErrorFrom', async () => {
    const f = fakes()
    f.getUserMedia.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    const err = await startMic(noop(), f.deps).catch((e) => e)
    expect(micErrorFrom(err)).toBe('mic-denied')
  })
})
