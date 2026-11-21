/** Linear resampling; equal rates give a copy. */
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input.slice()
  const outLen = Math.floor((input.length * to) / from)
  const out = new Float32Array(outLen)
  const step = from / to
  for (let i = 0; i < outLen; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac
  }
  return out
}

export function rms(pcm: Float32Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!
  return Math.sqrt(sum / pcm.length)
}
