/**
 * Qclod's end of one server's relay (stage 6): one channel, numbered requests,
 * the sessions it follows. The channel may break at any time — a laptop asleep,
 * a network gone; the agents on the server do not care (they live in the
 * relay). The client then tries again by RECONNECT_BACKOFF_MS without asking
 * anybody, attaches every session again after the last record it has seen and
 * reads on: nothing lost, nothing twice.
 *
 * Everything off the wire goes through parseFrame (LineDecoder).
 */
import {
  LineDecoder,
  RELAY_PROTO,
  encodeFrame,
  type AttachResult,
  type OpenParams,
  type RelayErrorCode,
  type RelayFrame,
  type RelayMethod
} from '../../shared/relayProtocol'
import { classifySshFailure } from './sshRun'
import type { RelayTransport, TransportFactory } from './transport'

export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000, 60000]
export const CALL_TIMEOUT_MS = 30000
export const PING_EVERY_MS = 15000
export const PONG_DEADLINE_MS = 45000
/** A message sent while the server is away waits this long for it to come back. */
export const SEND_WAIT_MS = 60000
const WELCOME_TIMEOUT_MS = 60000
/** A channel up this long counts as held: the reconnect ladder starts over. */
export const STABLE_LINK_MS = 30000

type EvFrame = Extract<RelayFrame, { t: 'ev' }>
type LiveFrame = Extract<RelayFrame, { t: 'live' }>
type WelcomeFrame = Extract<RelayFrame, { t: 'welcome' }>

export interface SessionSink {
  onEvent(f: EvFrame): void
  onLive(f: LiveFrame): void
  onReattached(r: AttachResult): void
}

export class RelayCallError extends Error {
  constructor(
    readonly code: RelayErrorCode | 'offline' | 'timeout',
    message: string
  ) {
    super(message)
    this.name = 'RelayCallError'
  }
}

export type RelayClientState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'needsAuth' | 'hostKeyChanged'

/** A server's «in how long», in this machine's clock (Review Focus 2). */
export function localDeadline(remainingMs: number, now: number): number {
  return now + remainingMs
}

interface Pending {
  resolve(r: unknown): void
  reject(e: Error): void
  /** Runs at once when the answer comes, before the frames after it. */
  onResult?(r: unknown): void
}

interface Subscription {
  lastSeq: number
  sink: SessionSink
}

interface Link {
  transport: RelayTransport
  decoder: LineDecoder
  alive: boolean
  lastPong: number
}

const OFFLINE_TEXT = 'Сервер не на связи'

export class RelayClient {
  private current: RelayClientState = 'idle'
  private problem: string | undefined
  private link: Link | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly subs = new Map<string, Subscription>()
  private readonly listeners = new Set<(s: RelayClientState, problem?: string) => void>()
  private readonly onlineWaiters = new Set<() => void>()
  private attempt = 0
  /** Each connect, reconnect plan and ping loop belongs to one generation; an older one does nothing. */
  private generation = 0
  private closed = false
  private everOnline = false
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown

  constructor(
    private readonly o: {
      hostId: string
      appVersion: string
      clientName: string
      transport: TransportFactory
      now?: () => number
      setTimer?: (fn: () => void, ms: number) => unknown
    }
  ) {
    this.now = o.now ?? Date.now
    this.setTimer =
      o.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      })
  }

  get state(): RelayClientState {
    return this.current
  }

  get lastProblem(): string | undefined {
    return this.problem
  }

  onState(cb: (s: RelayClientState, problem?: string) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private setState(s: RelayClientState, problem?: string): void {
    const changed = s !== this.current || problem !== this.problem
    this.current = s
    this.problem = problem
    if (s === 'online') for (const w of [...this.onlineWaiters]) w()
    if (changed) for (const cb of [...this.listeners]) cb(s, problem)
  }

  /**
   * Opens the channel and says hello. `interactive`: a person is at the window,
   * ssh may ask them (a password, a new host key).
   */
  connect(interactive: boolean): Promise<WelcomeFrame> {
    this.closed = false
    const gen = ++this.generation
    this.dropLink()
    this.setState(this.everOnline && !interactive ? 'reconnecting' : 'connecting')
    return this.openLink(gen, interactive)
  }

  private openLink(gen: number, interactive: boolean): Promise<WelcomeFrame> {
    return new Promise<WelcomeFrame>((resolve, reject) => {
      let transport: RelayTransport
      try {
        transport = this.o.transport({ interactive })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        this.linkFailed(gen, null, String(err))
        return
      }
      const link: Link = { transport, decoder: new LineDecoder(), alive: true, lastPong: this.now() }
      this.link = link
      let welcomed = false
      const fail = (err: Error): void => {
        if (welcomed) return
        welcomed = true
        reject(err)
      }
      // While ssh's question waits for the person, the time is theirs, not the relay's (R4).
      const welcomeWatch = (): void => {
        if (welcomed || this.link !== link) return
        if (transport.asking?.()) {
          this.setTimer(welcomeWatch, WELCOME_TIMEOUT_MS)
          return
        }
        fail(new RelayCallError('timeout', 'Посредник не ответил'))
        transport.kill()
      }
      this.setTimer(welcomeWatch, WELCOME_TIMEOUT_MS)

      transport.stdout.on('data', (chunk: Buffer | string) => {
        if (!link.alive) return
        for (const frame of link.decoder.push(chunk)) {
          if (!welcomed) {
            if (frame.t === 'welcome') {
              welcomed = true
              this.online(gen, link)
              resolve(frame)
            } else if (frame.t === 'res' && !frame.ok) {
              // Refused at hello (another protocol): trying again changes nothing.
              if (gen === this.generation) {
                this.generation++
                this.setState('offline', frame.e.message)
              }
              fail(new RelayCallError(frame.e.code, frame.e.message))
              transport.kill()
              return
            }
            continue
          }
          // A sink that throws on one frame must not cost the frames after it in the chunk.
          try {
            this.onFrame(link, frame)
          } catch (err) {
            console.warn('[relay] кадр', err instanceof Error ? err.message : String(err))
          }
        }
      })
      transport.stdout.on('error', () => undefined)
      transport.onExit((code, stderr) => {
        if (!link.alive) return
        link.alive = false
        if (this.link === link) this.link = null
        this.failPending(new RelayCallError('offline', OFFLINE_TEXT))
        const reason = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? 'связь прервалась'
        fail(new RelayCallError('offline', reason))
        this.linkFailed(gen, code, stderr)
      })
      this.write(link, { t: 'hello', proto: RELAY_PROTO, app: this.o.appVersion, client: this.o.clientName })
    })
  }

  private online(gen: number, link: Link): void {
    if (gen !== this.generation) return
    const again = this.everOnline
    this.everOnline = true
    // The ladder starts over only for a channel that held: one that drops at
    // once after every hello keeps climbing to 60 s instead of hammering at 1 s.
    this.setTimer(() => {
      if (gen === this.generation && link.alive && this.link === link) this.attempt = 0
    }, STABLE_LINK_MS)
    link.lastPong = this.now()
    this.setState('online')
    this.pingLoop(gen, link)
    if (!again) return
    // Read on from where every session stopped.
    // onReattached runs as the answer is read, before the records sent right
    // behind it in the same chunk: the sink learns of a gap before them.
    for (const [s, sub] of this.subs) {
      this.attach(s, sub.lastSeq, sub.sink, (r) => {
        if (this.subs.get(s)?.sink === sub.sink) sub.sink.onReattached(r)
      }).catch(() => {
        // The next reconnect tries again.
      })
    }
  }

  private pingLoop(gen: number, link: Link): void {
    this.setTimer(() => {
      if (gen !== this.generation || !link.alive || this.link !== link) return
      if (this.now() - link.lastPong >= PONG_DEADLINE_MS) {
        // No pong for 45 s: the channel is as good as gone.
        link.transport.kill()
        this.lostLink(link)
        return
      }
      this.write(link, { t: 'ping' })
      this.pingLoop(gen, link)
    }, PING_EVERY_MS)
  }

  /** The link is dead without its process saying so yet: count it lost now. */
  private lostLink(link: Link): void {
    if (!link.alive) return
    link.alive = false
    if (this.link === link) this.link = null
    this.failPending(new RelayCallError('offline', OFFLINE_TEXT))
    this.linkFailed(this.generation, null, '')
  }

  private linkFailed(gen: number, code: number | null, stderr: string): void {
    if (gen !== this.generation || this.closed) return
    const failure = stderr ? classifySshFailure(stderr, code) : 'other'
    if (failure === 'authFailed') return this.setState('needsAuth', 'Сервер не принял вход')
    if (failure === 'hostKeyChanged') return this.setState('hostKeyChanged', 'Ключ сервера изменился')
    if (!this.everOnline) return this.setState('offline', stderr.trim().split(/\r?\n/).at(-1) || undefined)
    this.scheduleReconnect(gen)
  }

  private scheduleReconnect(gen: number): void {
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)]!
    // After the whole ladder the server counts as away; tries go on every 60 s.
    this.setState(this.attempt >= RECONNECT_BACKOFF_MS.length - 1 ? 'offline' : 'reconnecting')
    this.attempt++
    this.setTimer(() => {
      if (gen !== this.generation || this.closed) return
      const next = ++this.generation
      this.openLink(next, false).catch(() => {
        // linkFailed has planned the next try (or stopped for a password).
      })
    }, delay)
  }

  private onFrame(link: Link, frame: RelayFrame): void {
    switch (frame.t) {
      case 'res': {
        const p = this.pending.get(frame.id)
        if (!p) return
        this.pending.delete(frame.id)
        if (frame.ok) {
          p.onResult?.(frame.r)
          p.resolve(frame.r)
        } else p.reject(new RelayCallError(frame.e.code, frame.e.message))
        return
      }
      case 'ev': {
        const sub = this.subs.get(frame.s)
        if (!sub || frame.q <= sub.lastSeq) return
        sub.lastSeq = frame.q
        sub.sink.onEvent(frame)
        return
      }
      case 'live':
        this.subs.get(frame.s)?.sink.onLive(frame)
        return
      case 'pong':
        link.lastPong = this.now()
        return
      case 'ping':
        this.write(link, { t: 'pong' })
        return
      default:
        return
    }
  }

  private write(link: Link, frame: RelayFrame): void {
    if (!link.alive) return
    try {
      link.transport.stdin.write(encodeFrame(frame))
    } catch {
      // A frame too large or a closed pipe: the call times out or the exit says why.
    }
  }

  private failPending(err: Error): void {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) p.reject(err)
  }

  private dropLink(): void {
    const link = this.link
    this.link = null
    if (!link) return
    link.alive = false
    link.transport.kill()
    this.failPending(new RelayCallError('offline', OFFLINE_TEXT))
  }

  /** Waits for the channel up to `ms`; false when it did not come. */
  private waitOnline(ms: number): Promise<boolean> {
    if (this.current === 'online') return Promise.resolve(true)
    return new Promise((resolve) => {
      let done = false
      const ready = (): void => {
        if (done) return
        done = true
        this.onlineWaiters.delete(ready)
        resolve(true)
      }
      this.onlineWaiters.add(ready)
      this.setTimer(() => {
        if (done) return
        done = true
        this.onlineWaiters.delete(ready)
        resolve(false)
      }, ms)
    })
  }

  call<T>(m: RelayMethod, p: unknown, o?: { timeoutMs?: number }): Promise<T> {
    return this.request<T>(m, p, o?.timeoutMs)
  }

  private async request<T>(m: RelayMethod, p: unknown, timeoutMs?: number, onResult?: (r: unknown) => void): Promise<T> {
    if (this.current !== 'online' || !this.link) {
      // A message waits for the server (the strip says so); anything else fails at once.
      const isSend = m === 'drv' && (p as { op?: unknown } | null)?.op === 'send'
      if (!isSend || this.closed || !(await this.waitOnline(SEND_WAIT_MS)) || !this.link) {
        throw new RelayCallError('offline', OFFLINE_TEXT)
      }
    }
    const link = this.link
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (r: unknown) => void,
        reject,
        ...(onResult ? { onResult } : {})
      })
      this.setTimer(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new RelayCallError('timeout', 'Сервер не ответил вовремя'))
      }, timeoutMs ?? CALL_TIMEOUT_MS)
      this.write(link, { t: 'req', id, m, p })
    })
  }

  /** A new session on the server; its records and live events go to `sink`. */
  open(p: OpenParams, sink: SessionSink): Promise<AttachResult> {
    return this.request<AttachResult>('session.open', p, undefined, (r) => {
      const s = (r as AttachResult | null)?.snapshot?.s
      if (typeof s === 'string') this.subs.set(s, { lastSeq: 0, sink })
    })
  }

  /** Follows a session from after `after`; the records after it come next, then live events. */
  attach(s: string, after: number, sink: SessionSink, onAttached?: (r: AttachResult) => void): Promise<AttachResult> {
    return this.request<AttachResult>('session.attach', { s, after }, undefined, (r) => {
      const known = this.subs.get(s)
      let lastSeq = known && known.sink === sink ? Math.max(known.lastSeq, after) : after
      // The relay's journal is behind what was seen here (lost on its side): a gap, and its numbers from there on.
      const res = r as AttachResult | null
      const theirs = res?.snapshot?.lastSeq
      if (res?.gap && typeof theirs === 'number' && theirs < lastSeq) lastSeq = theirs
      this.subs.set(s, { lastSeq, sink })
      if (res) onAttached?.(res)
    })

  }

  /** Stops following a session; it keeps running on the server. */
  detach(s: string): void {
    if (!this.subs.delete(s)) return
    if (this.current === 'online') this.call('session.detach', { s }).catch(() => undefined)
  }

  /** The last record of `s` seen here. */
  lastSeq(s: string): number {
    return this.subs.get(s)?.lastSeq ?? 0
  }

  close(): void {
    this.closed = true
    this.generation++
    this.dropLink()
    this.subs.clear()
    this.setState('idle')
  }
}
