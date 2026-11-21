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
  /** The end of what the process wrote to stderr (index.ts keeps it): a native crash says why only there. */
  stderrTail?(): string
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
  stopTimeoutMs?: number // 30_000
  releaseTimeoutMs?: number // 5_000
}

const IDLE_MS = 600_000
const CRASH_WINDOW_MS = 600_000
const GIVE_UP_AFTER = 3
/** A stopped session's `done` comes within this, or the process is hung (I1). */
const STOP_TIMEOUT_MS = 30_000
/** How long a deletion waits for the process to exit before it kills the server itself. */
const RELEASE_TIMEOUT_MS = 5_000
/**
 * onnxruntime's words when a different onnxruntime.dll (System32's) was
 * loaded before ours; the process then segfaults, so this is only in its
 * stderr, never in a JS error (I2).
 */
const ORT_CONFLICT = /requested API version/i
const TAIL_CHARS = 600

type FailCode = Extract<FromWorker, { type: 'failed' }>['code']

/** A retry cannot fix these: voice stays off until Qclod restarts. */
function isFinal(code: FailCode): code is 'ort-conflict' | 'engine-missing' {
  return code === 'ort-conflict' || code === 'engine-missing'
}

/** The last lines of a stderr tail, for the log. */
function lastLines(tail: string): string {
  const t = tail.trim()
  return t.length > TAIL_CHARS ? `…${t.slice(-TAIL_CHARS)}` : t
}
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
 * A stopped session that gets no `done` in 30 s is a hung process: it is
 * closed like a crash (I1).
 */
export class VoiceHost {
  private readonly now: () => number
  private readonly idleMs: number
  private readonly stopTimeoutMs: number
  private readonly releaseTimeoutMs: number

  private worker: WorkerLike | null = null
  /** The model the current process was told to load. */
  private workerModel: VoiceModelId | null = null
  private ready = false
  /** What the process was sent since `load`: a restart on GigaAM gets it again. */
  private replay: ToWorker[] = []
  private replaySamples = 0
  private readonly pids = new Map<WorkerLike, number>()
  private readonly letGo = new WeakSet<WorkerLike>()
  /** Every process not yet exited, with its model: a deletion waits for its files to be let go. */
  private readonly exits = new Map<WorkerLike, { model: VoiceModelId; done: Promise<void>; resolve: () => void }>()

  private current: { id: string; owner: number } | null = null
  /** Every session whose texts may still come: the current one and the stopped ones before their `done`. */
  private readonly owners = new Map<string, number>()
  /** Stopped sessions waiting for their `done`: what the watchdog looks at. */
  private readonly stopping = new Set<string>()
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  /** release() waiting for the sessions to end. */
  private drainWaiters: Array<() => void> = []

  private crashes: number[] = []
  /** Set: voice is off until Qclod restarts, and begin answers with this code. */
  private gaveUp: VoiceErrorCode | null = null
  private modelChangePending = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: VoiceHostDeps) {
    this.now = deps.now ?? Date.now
    this.idleMs = deps.idleMs ?? IDLE_MS
    this.stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS
    this.releaseTimeoutMs = deps.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS
  }

  async begin(owner: number, _tabId: TabId): Promise<{ session: string } | { error: VoiceErrorCode }> {
    const settings = this.deps.settings()
    const paths = this.deps.pathsFor(settings.model)
    if (paths === null) return { error: 'no-model' }
    if (this.deps.micAccess() === 'denied') return { error: 'mic-denied' }
    if (this.gaveUp !== null) return { error: this.gaveUp }

    this.clearIdle()
    if (this.current !== null) {
      // Its finals still come, to its owner, before the process looks at the new session.
      this.stopSession(this.current.id)
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
    this.stopSession(session)
    this.current = null
  }

  /** The window reloaded or its page crashed (M8): its recording stops; what it said is decoded and dropped. */
  endOwner(owner: number): void {
    if (this.current === null || this.current.owner !== owner) return
    this.stopSession(this.current.id)
    this.current = null
  }

  modelChanged(): void {
    if (this.worker === null) return
    if (this.owners.size === 0) this.stopWorker()
    else this.modelChangePending = true
  }

  /**
   * Before a model's files are deleted (I3): if the process has that model
   * loaded, a recording ends (its last phrase still reaches the field), the
   * process is closed, and this resolves once it has exited and the Whisper
   * server is killed — Windows keeps a running program's files locked. A
   * process that does not exit in 5 s has its server killed anyway. Another
   * model's process is left alone.
   */
  async release(id: VoiceModelId): Promise<void> {
    while (this.worker !== null && this.workerModel === id) {
      if (this.current !== null) {
        this.stopSession(this.current.id)
        this.current = null
      }
      if (this.owners.size > 0) {
        // Bounded: the watchdog closes a process whose `done` does not come.
        await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
        continue
      }
      this.stopWorker()
    }
    const exiting = [...this.exits].filter(([, e]) => e.model === id)
    await Promise.all(exiting.map(([w, e]) => this.exitedOrKilled(w, e.done)))
  }

  dispose(): void {
    this.clearIdle()
    this.clearStopWatch()
    this.owners.clear()
    this.stopping.clear()
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
    this.workerModel = paths.model
    this.ready = false
    this.replay = []
    this.replaySamples = 0
    let resolve!: () => void
    const done = new Promise<void>((r) => (resolve = r))
    this.exits.set(w, { model: paths.model, done, resolve })
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

  /** The session gets no more sound; its `done` is awaited for at most 30 s once the model is loaded. */
  private stopSession(session: string): void {
    this.send({ type: 'stop', session })
    this.stopping.add(session)
    this.armStopWatch()
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
        // Sound said during the load is decoded now: the wait for a stop counts from here.
        this.armStopWatch()
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
        // A final is progress: a stopped session with a long tail gets another 30 s.
        if (this.stopping.has(m.session)) this.armStopWatch()
        return
      case 'done':
        this.toOwner(m.session, { session: m.session, kind: 'done' })
        this.owners.delete(m.session)
        this.stopping.delete(m.session)
        if (this.stopping.size > 0) this.armStopWatch()
        else this.clearStopWatch()
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

  private armStopWatch(): void {
    if (!this.ready || this.stopping.size === 0 || this.worker === null) return
    this.clearStopWatch()
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      this.onHung()
    }, this.stopTimeoutMs)
  }

  private clearStopWatch(): void {
    if (this.stopTimer !== null) clearTimeout(this.stopTimer)
    this.stopTimer = null
  }

  /**
   * A stop got no `done` in 30 s: a decode is stuck (a hung driver, I1). The
   * process and its Whisper server (with the video memory) are closed, and
   * it counts as a crash.
   */
  private onHung(): void {
    const w = this.worker
    if (w === null) return
    this.letGo.add(w)
    w.kill()
    const pid = this.pids.get(w)
    this.pids.delete(w)
    if (pid !== undefined) this.deps.killPid(pid)
    this.crashed(`voice process did not finish a session in ${Math.round(this.stopTimeoutMs / 1000)} s; closed it`)
  }

  private onFailed(code: FailCode, message: string): void {
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
    if (isFinal(code)) this.gaveUp = code
    this.toAll(code)
    this.forgetSessions()
    this.stopWorker()
  }

  private onExit(w: WorkerLike, code: number): void {
    const pid = this.pids.get(w)
    this.pids.delete(w)
    if (pid !== undefined) this.deps.killPid(pid)
    this.exits.get(w)?.resolve()
    this.exits.delete(w)
    if (this.letGo.has(w) || w !== this.worker) return

    const tail = w.stderrTail?.() ?? ''
    // A different onnxruntime.dll kills the process while the model loads; restarting cannot help.
    const ortConflict = !this.ready && ORT_CONFLICT.test(tail)
    const said = lastLines(tail)
    this.crashed(`voice process exited with code ${code}${said ? `: ${said}` : ''}`, ortConflict)
  }

  /** The process is gone (exited, or closed as hung): the window is told, and it counts towards giving up. */
  private crashed(message: string, ortConflict = false): void {
    this.worker = null
    this.workerModel = null
    this.ready = false
    this.replay = []
    this.replaySamples = 0
    this.clearIdle()
    this.clearStopWatch()
    const at = this.now()
    let code: VoiceErrorCode
    if (ortConflict) {
      this.gaveUp = 'ort-conflict'
      code = 'ort-conflict'
    } else {
      this.crashes = [...this.crashes.filter((t) => at - t < CRASH_WINDOW_MS), at]
      if (this.crashes.length >= GIVE_UP_AFTER) this.gaveUp = 'engine-gave-up'
      code = this.gaveUp ?? 'engine-crashed'
    }
    this.deps.log({ source: 'main', scope: 'voice', message, at })
    this.toAll(code)
    this.forgetSessions()
  }

  /** A process a deletion waits for: its exit, or 5 s and its Whisper server killed by pid. */
  private async exitedOrKilled(w: WorkerLike, exited: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, this.releaseTimeoutMs)))
    await Promise.race([exited, late])
    clearTimeout(timer)
    const pid = this.pids.get(w)
    this.pids.delete(w)
    if (pid !== undefined) this.deps.killPid(pid)
    this.exits.delete(w)
  }

  private toAll(code: VoiceErrorCode): void {
    for (const [session, owner] of this.owners) this.deps.emit(owner, { session, kind: 'error', code })
  }

  private forgetSessions(): void {
    this.owners.clear()
    this.stopping.clear()
    this.clearStopWatch()
    this.current = null
    this.modelChangePending = false
    this.wakeDrained()
  }

  private afterSessionEnd(): void {
    if (this.owners.size > 0) return
    if (this.modelChangePending) {
      this.modelChangePending = false
      this.stopWorker()
    } else {
      this.armIdle()
    }
    this.wakeDrained()
  }

  private wakeDrained(): void {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const w of waiters) w()
  }

  private stopWorker(): void {
    this.clearIdle()
    this.clearStopWatch()
    const w = this.worker
    this.worker = null
    this.workerModel = null
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
