/**
 * Keeps a runaway renderer from flooding the error log: per sender, at most
 * `limit` reports per `windowMs`, and an identical report seen within the
 * window is only counted. What was held back is announced once, with the next
 * report that gets through.
 */
export class ReportThrottle {
  private readonly limit: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly senders = new Map<
    number,
    { admitted: number[]; seen: Map<string, number>; dropped: number }
  >()

  constructor(opts: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = opts.limit ?? 20
    this.windowMs = opts.windowMs ?? 10_000
    this.now = opts.now ?? Date.now
  }

  /** `admit`: write this report; `dropped`: how many were held back since the last one written. */
  check(sender: number, fingerprint: string): { admit: boolean; dropped: number } {
    const t = this.now()
    let s = this.senders.get(sender)
    if (!s) {
      s = { admitted: [], seen: new Map(), dropped: 0 }
      this.senders.set(sender, s)
    }
    s.admitted = s.admitted.filter((at) => t - at < this.windowMs)
    for (const [fp, at] of s.seen) if (t - at >= this.windowMs) s.seen.delete(fp)

    if (s.seen.has(fingerprint) || s.admitted.length >= this.limit) {
      s.dropped++
      return { admit: false, dropped: 0 }
    }
    s.admitted.push(t)
    s.seen.set(fingerprint, t)
    const dropped = s.dropped
    s.dropped = 0
    return { admit: true, dropped }
  }
}
