import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'
import type { TabId } from '../../shared/types'
import type {
  VoiceErrorCode,
  VoiceEvent,
  VoiceModelId,
  VoiceReplacement,
  VoiceSettings
} from '../../shared/voice'
import { DEFAULT_REPLACEMENTS } from '../../shared/voiceReplacements'
import type { ErrorEntry } from '../system/errorLog'
import { LOAD_BUFFER_SAMPLES, type FromWorker, type ModelPaths, type ToWorker } from './protocol'
import { voiceThreads } from './sherpaEngine'

export interface WorkerLike {
  postMessage(m: ToWorker): void
  on(e: 'message', f: (m: FromWorker) => void): void
  on(e: 'exit', f: (code: number) => void): void
  kill(): boolean
}

export interface VoiceHostDeps {
  fork(): WorkerLike
  pathsFor(id: VoiceModelId): ModelPaths | null // null — модель не готова
  settings(): VoiceSettings
  micAccess(): 'granted' | 'denied' | 'unknown'
  emit(owner: number, e: VoiceEvent): void
  log(e: ErrorEntry): void
  killPid(pid: number): void
  now?: () => number
  idleMs?: number // 600_000
}

const IDLE_MS = 600_000
const CRASH_WINDOW_MS = 600_000
const GIVE_UP_AFTER = 3
const PROMPT_BASE = 'Диктовка задачи для программиста.'
const PROMPT_TERMS = 20

/** Whisper's prompt: the task, then up to 20 distinct terms of the dictionary in use. */
export function whisperPrompt(replacements: readonly VoiceReplacement[]): string {
  const terms: string[] = []
  for (const r of replacements) {
    const to = typeof r?.to === 'string' ? r.to.trim() : ''
    if (to.length > 0 && !terms.includes(to)) terms.push(to)
    if (terms.length === PROMPT_TERMS) break
  }
  return terms.length > 0 ? `${PROMPT_BASE} ${terms.join(', ')}` : PROMPT_BASE
}

/**
 * The voice process's owner in main. It starts the process on the first
 * press, loads the chosen model, routes each session's texts to the window
 * that began it, and lets the process go: after 10 idle minutes, on a model
 * change, or when it has crashed three times in ten minutes (decisions 7, 8).
 */
export class VoiceHost {
  private readonly now: () => number
  private readonly idleMs: number

  private worker: WorkerLike | null = null
  private ready = false
  /** What the process was sent since `load`: a restart on GigaAM gets it again. */
  private replay: ToWorker[] = []
  private replaySamples = 0
  private readonly pids = new Map<WorkerLike, number>()
  private readonly letGo = new WeakSet<WorkerLike>()

  private current: { id: string; owner: number } | null = null
  /** Every session whose texts may still come: the current one and the stopped ones before their `done`. */
  private readonly owners = new Map<string, number>()

  private crashes: number[] = []
  private gaveUp = false
  private modelChangePending = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: VoiceHostDeps) {
    this.now = deps.now ?? Date.now
    this.idleMs = deps.idleMs ?? IDLE_MS
  }

  async begin(owner: number, _tabId: TabId): Promise<{ session: string } | { error: VoiceErrorCode }> {
    const settings = this.deps.settings()
    const paths = this.deps.pathsFor(settings.model)
    if (paths === null) return { error: 'no-model' }
    if (this.deps.micAccess() === 'denied') return { error: 'mic-denied' }
    if (this.gaveUp) return { error: 'engine-gave-up' }

    this.clearIdle()
    if (this.current !== null) {
      // Its finals still come, to its owner, before the process looks at the new session.
      this.send({ type: 'stop', session: this.current.id })
      this.current = null
    }
    const replacements = settings.replacements ?? [...DEFAULT_REPLACEMENTS]
    if (this.worker === null) this.spawn(paths, replacements)
    const session = randomUUID()
    this.current = { id: session, owner }
    this.owners.set(session, owner)
    this.deps.emit(owner, { session, kind: this.ready ? 'ready' : 'loading' })
    this.send({ type: 'start', session, replacements })
    return { session }
  }

  audio(owner: number, session: string, pcm: Float32Array): void {
    if (!this.isCurrent(owner, session)) return
    this.send({ type: 'audio', session, pcm })
  }

  end(owner: number, session: string): void {
    if (!this.isCurrent(owner, session)) return
    this.send({ type: 'stop', session })
    this.current = null
  }

  modelChanged(): void {
    if (this.worker === null) return
    if (this.owners.size === 0) this.stopWorker()
    else this.modelChangePending = true
  }

  dispose(): void {
    this.clearIdle()
    this.owners.clear()
    this.current = null
    const w = this.worker
    if (w !== null) {
      const pid = this.pids.get(w)
      this.pids.delete(w)
      if (pid !== undefined) this.deps.killPid(pid)
    }
    this.stopWorker()
  }

  private isCurrent(owner: number, session: string): boolean {
    return this.current !== null && this.current.id === session && this.current.owner === owner
  }

  private spawn(paths: ModelPaths, replacements: readonly VoiceReplacement[]): void {
    const w = this.deps.fork()
    this.worker = w
    this.ready = false
    this.replay = []
    this.replaySamples = 0
    w.on('message', (m) => this.onMessage(w, m))
    w.on('exit', (code) => this.onExit(w, code))
    w.postMessage({
      type: 'load',
      paths,
      threads: voiceThreads(availableParallelism()),
      prompt: whisperPrompt(replacements)
    })
  }

  private send(m: ToWorker): void {
    const w = this.worker
    if (w === null) return
    if (!this.ready) {
      const samples = m.type === 'audio' ? m.pcm.length : 0
      if (this.replaySamples + samples <= LOAD_BUFFER_SAMPLES) {
        this.replay.push(m)
        this.replaySamples += samples
      }
    }
    w.postMessage(m)
  }

  private onMessage(w: WorkerLike, m: FromWorker): void {
    if (m.type === 'pid') {
      this.pids.set(w, m.pid)
      return
    }
    if (w !== this.worker) return
    switch (m.type) {
      case 'loaded':
        this.ready = true
        this.replay = []
        this.replaySamples = 0
        for (const [session, owner] of this.owners) this.deps.emit(owner, { session, kind: 'ready' })
        return
      case 'partial':
        this.toOwner(m.session, { session: m.session, kind: 'partial', phrase: m.phrase, text: m.text })
        return
      case 'final':
        this.toOwner(m.session, {
          session: m.session,
          kind: 'final',
          phrase: m.phrase,
          text: m.text,
          joinsPrevious: m.joinsPrevious
        })
        return
      case 'done':
        this.toOwner(m.session, { session: m.session, kind: 'done' })
        this.owners.delete(m.session)
        this.afterSessionEnd()
        return
      case 'failed':
        this.onFailed(m.code, m.message)
        return
    }
  }

  private toOwner(session: string, e: VoiceEvent): void {
    const owner = this.owners.get(session)
    if (owner !== undefined) this.deps.emit(owner, e)
  }

  private onFailed(code: 'ort-conflict' | 'load-failed' | 'gpu-failed', message: string): void {
    this.deps.log({
      source: 'main',
      scope: 'voice',
      message: `voice model did not load (${code}): ${message}`,
      at: this.now()
    })
    if (code === 'gpu-failed') {
      const giga = this.deps.pathsFor('gigaam-v3')
      if (giga !== null) {
        // Decision 9: GigaAM for as long as this process lives; the setting stays.
        const replay = this.replay
        this.stopWorker()
        this.spawn(giga, this.replacements())
        for (const m of replay) this.send(m)
        this.toAll('gpu-fallback')
        return
      }
    }
    this.toAll(code)
    this.forgetSessions()
    this.stopWorker()
  }

  private onExit(w: WorkerLike, code: number): void {
    const pid = this.pids.get(w)
    this.pids.delete(w)
    if (pid !== undefined) this.deps.killPid(pid)
    if (this.letGo.has(w) || w !== this.worker) return

    this.worker = null
    this.ready = false
    this.replay = []
    this.replaySamples = 0
    this.clearIdle()
    const at = this.now()
    this.crashes = [...this.crashes.filter((t) => at - t < CRASH_WINDOW_MS), at]
    if (this.crashes.length >= GIVE_UP_AFTER) this.gaveUp = true
    this.deps.log({ source: 'main', scope: 'voice', message: `voice process exited with code ${code}`, at })
    this.toAll(this.gaveUp ? 'engine-gave-up' : 'engine-crashed')
    this.forgetSessions()
  }

  private toAll(code: VoiceErrorCode): void {
    for (const [session, owner] of this.owners) this.deps.emit(owner, { session, kind: 'error', code })
  }

  private forgetSessions(): void {
    this.owners.clear()
    this.current = null
    this.modelChangePending = false
  }

  private afterSessionEnd(): void {
    if (this.owners.size > 0) return
    if (this.modelChangePending) {
      this.modelChangePending = false
      this.stopWorker()
      return
    }
    this.armIdle()
  }

  private stopWorker(): void {
    this.clearIdle()
    const w = this.worker
    this.worker = null
    this.ready = false
    this.replay = []
    this.replaySamples = 0
    if (w === null) return
    this.letGo.add(w)
    w.kill()
  }

  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.owners.size === 0) this.stopWorker()
    }, this.idleMs)
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private replacements(): VoiceReplacement[] {
    return this.deps.settings().replacements ?? [...DEFAULT_REPLACEMENTS]
  }
}
