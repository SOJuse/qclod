import type { PhraseEvent, SpeechEngine, VoiceActivity } from './engine'

const RATE = 16_000
const perMs = (ms: number): number => Math.round((ms * RATE) / 1000)

export const LIVE_DEFAULTS = {
  partialEveryMs: 700,
  slowFactor: 1.5,
  maxPhraseMs: 11_000,
  preRollMs: 400,
  minPhraseMs: 300
} as const

export interface LiveDecoderOptions extends Partial<Record<keyof typeof LIVE_DEFAULTS, number>> {
  engine: SpeechEngine
  vad: VoiceActivity
  emit(e: PhraseEvent): void
  now?: () => number
  /** A decode that failed; the phrase it belonged to simply gets no text. */
  onError?(err: unknown): void
}

interface Job {
  phrase: number
  /** null: nothing to decode, the event is `text: ''` (a blip that had a partial). */
  pcm: Float32Array | null
  final: boolean
  cut: boolean
}

function join(parts: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/**
 * Turns a stream of sound into partial and final phrase texts (06 §3). The
 * phrase is re-decoded whole every `partialEveryMs`, or every
 * `slowFactor × last decode time` when the engine is slow; the VAD closes a
 * phrase and the closing decode is its final. One decode at a time.
 */
export class LiveDecoder {
  private readonly o: Required<Omit<LiveDecoderOptions, 'engine' | 'vad' | 'emit' | 'now' | 'onError'>>
  private readonly engine: SpeechEngine
  private readonly vad: VoiceActivity
  private readonly emit: (e: PhraseEvent) => void
  private readonly now: () => number
  private readonly onError?: (err: unknown) => void

  private ring: Float32Array[] = []
  private ringLen = 0
  private parts: Float32Array[] = []
  private partsLen = 0
  private preLen = 0
  private inPhrase = false
  private phrase = 0
  private sinceLast = 0
  private hadPartial = false
  /** The highest phrase a final has been queued for: its partials are stale. */
  private closedPhrase = -1
  private lastDecodeMs = 0

  private busy = false
  private queue: Job[] = []
  private idleWaiters: Array<() => void> = []
  private cancelled = false
  private finishing = false

  constructor(opts: LiveDecoderOptions) {
    this.engine = opts.engine
    this.vad = opts.vad
    this.emit = opts.emit
    this.now = opts.now ?? ((): number => performance.now())
    this.onError = opts.onError
    this.o = {
      partialEveryMs: opts.partialEveryMs ?? LIVE_DEFAULTS.partialEveryMs,
      slowFactor: opts.slowFactor ?? LIVE_DEFAULTS.slowFactor,
      maxPhraseMs: opts.maxPhraseMs ?? LIVE_DEFAULTS.maxPhraseMs,
      preRollMs: opts.preRollMs ?? LIVE_DEFAULTS.preRollMs,
      minPhraseMs: opts.minPhraseMs ?? LIVE_DEFAULTS.minPhraseMs
    }
  }

  push(pcm: Float32Array): void {
    if (this.cancelled || this.finishing) return
    // The caller may reuse its buffer.
    const chunk = pcm.slice()
    this.vad.accept(chunk)

    if (!this.inPhrase) {
      this.vad.takeClosed()
      if (!this.vad.speaking) {
        this.addToRing(chunk)
        return
      }
      this.parts = [...this.ring, chunk]
      this.partsLen = this.ringLen + chunk.length
      this.preLen = this.ringLen
      this.ring = []
      this.ringLen = 0
      this.inPhrase = true
      this.sinceLast = 0
      this.hadPartial = false
    } else {
      this.parts.push(chunk)
      this.partsLen += chunk.length
    }
    this.sinceLast += chunk.length

    if (this.vad.takeClosed() > 0) {
      this.closePhrase()
      return
    }
    if (this.partsLen > perMs(this.o.maxPhraseMs)) {
      this.cutPhrase()
      return
    }
    this.maybePartial()
  }

  /** Flushes the VAD, decodes the tail as a final; resolves after the last final. */
  async finish(): Promise<void> {
    if (!this.cancelled && !this.finishing) {
      this.finishing = true
      this.vad.flush()
      this.vad.takeClosed()
      if (this.inPhrase) this.closePhrase()
    }
    await this.idle()
  }

  /** Nothing is emitted after this, and nothing waits for a decode in flight. */
  cancel(): void {
    this.cancelled = true
    this.queue = []
    this.parts = []
    this.ring = []
    this.wakeIdle()
  }

  private addToRing(chunk: Float32Array): void {
    this.ring.push(chunk)
    this.ringLen += chunk.length
    const keep = perMs(this.o.preRollMs)
    while (this.ringLen - this.ring[0].length >= keep && this.ring.length > 1) {
      this.ringLen -= this.ring.shift()!.length
    }
    if (this.ringLen > keep) {
      const first = this.ring[0]
      const drop = this.ringLen - keep
      this.ring[0] = first.subarray(drop)
      this.ringLen -= drop
    }
  }

  private maybePartial(): void {
    if (this.busy || this.queue.length > 0) return
    const needMs = Math.max(this.o.partialEveryMs, this.o.slowFactor * this.lastDecodeMs)
    if (this.sinceLast < perMs(needMs)) return
    this.sinceLast = 0
    this.hadPartial = true
    void this.run({
      phrase: this.phrase,
      pcm: join(this.parts, this.partsLen),
      final: false,
      cut: false
    })
  }

  /** The phrase ends here (silence or the end of the stream). */
  private closePhrase(): void {
    this.queueFinal(false)
    this.parts = []
    this.partsLen = 0
    this.preLen = 0
    this.inPhrase = false
  }

  /** The phrase is too long: its text so far is final, the next part goes on. */
  private cutPhrase(): void {
    this.queueFinal(true)
    this.parts = []
    this.partsLen = 0
    this.preLen = 0
    this.sinceLast = 0
  }

  private queueFinal(cut: boolean): void {
    const phrase = this.phrase
    this.closedPhrase = phrase
    const speechLen = this.partsLen - this.preLen
    if (!cut && speechLen < perMs(this.o.minPhraseMs)) {
      // A blip: no final, unless the screen has already shown a partial for it.
      if (this.hadPartial) this.enqueue({ phrase, pcm: null, final: true, cut: false })
    } else {
      this.enqueue({ phrase, pcm: join(this.parts, this.partsLen), final: true, cut })
    }
    if (cut || this.hadPartial || speechLen >= perMs(this.o.minPhraseMs)) this.phrase += 1
    this.hadPartial = false
  }

  private enqueue(job: Job): void {
    this.queue.push(job)
    if (!this.busy) void this.pump()
  }

  private async pump(): Promise<void> {
    const job = this.queue.shift()
    if (job === undefined) {
      this.wakeIdle()
      return
    }
    await this.run(job)
  }

  private async run(job: Job): Promise<void> {
    this.busy = true
    const startedAt = this.now()
    let text: string | null = null
    try {
      text = job.pcm === null ? '' : await this.engine.decode(job.pcm, { phrase: job.phrase, final: job.final })
    } catch (err) {
      if (!this.cancelled) this.onError?.(err)
    }
    if (!job.final) this.lastDecodeMs = this.now() - startedAt
    this.busy = false
    if (!this.cancelled && text !== null && (job.final || job.phrase > this.closedPhrase)) {
      const event: PhraseEvent = { kind: job.final ? 'final' : 'partial', phrase: job.phrase, text }
      if (job.cut) event.cut = true
      this.emit(event)
    }
    if (this.cancelled) return
    await this.pump()
  }

  private idle(): Promise<void> {
    if (this.cancelled || (!this.busy && this.queue.length === 0)) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private wakeIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const w of waiters) w()
  }
}
