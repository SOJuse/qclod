/** 16-bit PCM mono WAV of float samples (clipped to −1…1). */
export function encodeWav16(pcm: Float32Array, sampleRate = 16_000): Buffer {
  const data = pcm.length * 2
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(36 + data, 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(data, 40)
  for (let i = 0; i < pcm.length; i++) {
    const x = Number.isFinite(pcm[i]) ? Math.max(-1, Math.min(1, pcm[i])) : 0
    b.writeInt16LE(Math.round(x * 32767), 44 + i * 2)
  }
  return b
}
