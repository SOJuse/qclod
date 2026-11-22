/** Gathers audio blocks (128 samples) into chunks of `size` samples (1600 = 100 ms at 16 kHz). */
export class ChunkCollector {
  private buf: Float32Array
  private fill = 0

  constructor(private readonly size = 1600) {
    this.buf = new Float32Array(size)
  }

  push(block: Float32Array): Float32Array[] {
    const out: Float32Array[] = []
    let i = 0
    while (i < block.length) {
      const n = Math.min(this.size - this.fill, block.length - i)
      this.buf.set(block.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill === this.size) {
        out.push(this.buf)
        this.buf = new Float32Array(this.size)
        this.fill = 0
      }
    }
    return out
  }
}
