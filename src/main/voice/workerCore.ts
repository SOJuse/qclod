import { applyReplacements } from '../../shared/voiceReplacements'
import type { VoiceReplacement } from '../../shared/voice'
import type { PhraseEvent, SpeechEngine, VoiceActivity } from './engine'
import { LiveDecoder } from './liveDecoder'
import { LOAD_BUFFER_SAMPLES, type FromWorker, type ModelPaths, type ToWorker } from './protocol'

export interface WorkerDeps {
  makeEngine(p: ModelPaths, threads: number, prompt: string): SpeechEngine
  makeVad(p: ModelPaths): VoiceActivity
  post(m: FromWorker): void
  /** Loads the native engine and makes a VAD from this model; throws if it cannot. */
  selftest?(vad: string): void
}

type SessionMessage = Exclude<ToWorker, { type: 'load' | 'selftest' }>
type FailCode = Extract<FromWorker, { type: 'failed' }>['code']

interface Session {
  id: string
  replacements: VoiceReplacement[]
  decoder: LiveDecoder
  /** The last final was cut at the phrase limit: the next one continues it. */
  lastCut: boolean
}

function failCode(err: unknown): FailCode {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ort-conflict' || code === 'engine-missing' || code === 'gpu-failed' ? code : 'load-failed'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * What the voice process does, without the process: one model, one session at
 * a time. Messages are handled strictly in order; sound that arrives while the
 * model loads waits (up to 30 s) and is decoded after it, and a `stop` waits
 * for the session's last final before the next message is looked at.
 */
export class WorkerCore {
  private engine: SpeechEngine | null = null
  private vad: VoiceActivity | null = null
  private loaded = false
  private dead = false
  private queue: SessionMessage[] = []
  /** Sound in the queue: it waits for the model, or for a stop's last final. */
  private queuedSamples = 0
  private pumping = false
  private session: Session | null = null

  constructor(private readonly deps: WorkerDeps) {}

  /** Samples of sound waiting in the queue (at most 30 s). */
  backlogSamples(): number {
    return this.queuedSamples
  }

  handle(m: ToWorker): void {
    if (this.dead) return
    if (m.type === 'load') {
      void this.load(m.paths, m.threads, m.prompt)
      return
    }
    if (m.type === 'selftest') {
      try {
        if (this.deps.selftest === undefined) throw new Error('no selftest in this process')
        this.deps.selftest(m.vad)
        this.deps.post({ type: 'selftest', ok: true })
      } catch (err) {
        this.deps.post({ type: 'selftest', ok: false, error: message(err) })
      }
      return
    }
    // While the model loads, or while a stop waits for a decode that may never
    // come back (a hung driver: main closes the process, voiceHost.ts), the
    // queue keeps at most 30 s of sound.
    if (m.type === 'audio') {
      if (this.queuedSamples + m.pcm.length > LOAD_BUFFER_SAMPLES) return
      this.queuedSamples += m.pcm.length
    }
    this.queue.push(m)
    void this.pump()
  }

  private async load(paths: ModelPaths, threads: number, prompt: string): Promise<void> {
    if (this.engine !== null) return
    const startedAt = Date.now()
    try {
      this.engine = this.deps.makeEngine(paths, threads, prompt)
      this.vad = this.deps.makeVad(paths)
      await this.engine.load()
    } catch (err) {
      this.dead = true
      this.queue = []
      this.queuedSamples = 0
      this.deps.post({ type: 'failed', code: failCode(err), message: message(err) })
      return
    }
    this.loaded = true
    this.deps.post({ type: 'loaded', model: this.engine.model, ms: Date.now() - startedAt })
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.loaded) return
    this.pumping = true
    try {
      while (this.queue.length > 0 && !this.dead) {
        const m = this.queue.shift()!
        if (m.type === 'audio') this.queuedSamples -= m.pcm.length
        if (m.type === 'start') this.begin(m.session, m.replacements)
        else if (m.type === 'audio') {
          if (this.session?.id === m.session) this.session.decoder.push(m.pcm)
        } else if (this.session?.id === m.session) {
          const s = this.session
          await s.decoder.finish()
          this.session = null
          this.deps.post({ type: 'done', session: s.id })
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private begin(id: string, replacements: VoiceReplacement[]): void {
    // A start without the previous stop: the old one is dropped, not finished.
    this.session?.decoder.cancel()
    const vad = this.vad!
    vad.reset()
    const session: Session = {
      id,
      replacements,
      lastCut: false,
      decoder: new LiveDecoder({
        engine: this.engine!,
        vad,
        emit: (e) => this.emit(session, e),
        onError: (err) => console.error('[voice] decode failed:', message(err))
      })
    }
    this.session = session
  }

  private emit(s: Session, e: PhraseEvent): void {
    let text = applyReplacements(e.text, s.replacements)
    if (e.kind === 'partial') {
      this.deps.post({ type: 'partial', session: s.id, phrase: e.phrase, text })
      return
    }
    const cut = e.cut === true
    // A cut phrase goes on in the next final: its closing period is the model's guess.
    if (cut) text = text.replace(/(?<!\.)\.\s*$/, '')
    this.deps.post({ type: 'final', session: s.id, phrase: e.phrase, text, joinsPrevious: s.lastCut })
    s.lastCut = cut
  }
}
