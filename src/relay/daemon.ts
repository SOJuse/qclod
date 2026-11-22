import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { DriverFactory } from '../main/agent/driver'
import {
  FrameTooLarge,
  LineDecoder,
  RELAY_DRIVER_OPS,
  RELAY_PROTO,
  encodeFrame,
  type AttachResult,
  type RelayFrame,
  type RelayMethod,
  type RelaySnapshot
} from '../shared/relayProtocol'
import { PERMISSION_MODES, type PermissionAnswer, type PermissionMode } from '../shared/types'
import { attachAutonomy, type RelayAutonomy, type RelayClock } from './autonomy'
import { RelayError, badRequest } from './errors'
import { runGit, type GitRunParams } from './git'
import { Journal, privateMode } from './journal'

import { SILENT_LOG, type RelayLog } from './log'
import { BINARY_NAME, type RelayPaths } from './paths'
import { RelaySession, type SessionFrame } from './session'
import {
  SESSION_ID,
  loadState,
  pruneClosed,
  pruneUploads,
  readRules,
  saveState,
  type RelaySessionRecord,
  type RelayState
} from './stateStore'

export const HELLO_TIMEOUT_MS = 10_000
/** The exit code of a restart asked for: the unit's RestartForceExitStatus=75 brings the daemon back. */
export const RESTART_EXIT_CODE = 75
/** A lock this young, with no socket yet, is a daemon starting (or stopping): it is waited for. */
export const LOCK_FRESH_MS = 15_000
/** How long a daemon waits for a lock held by one starting or stopping. */
export const LOCK_WAIT_MS = 20_000
const LOCK_POLL_MS = 250
/** Closed sessions past 30 days and uploads of no open session go once a day. */
export const HOUSEKEEP_MS = 24 * 60 * 60_000
/** A client that reads this far behind is cut: it comes back and reads on from `after`. */
export const CLIENT_BACKLOG_MAX = 32 * 1024 * 1024
/** What a client gets in place of a record too large for one line. */
export const TOO_LARGE_NOTICE = {
  kind: 'text',
  text: 'Здесь запись больше 16 МиБ — она есть только в журнале на сервере',
  tone: 'info'
} as const
const MAX_AUTO_ANSWER_MS = 24 * 60 * 60_000
const PERMISSION_MODES_SET: ReadonlySet<string> = new Set(PERMISSION_MODES)

/** What the methods of task 13 plug in (fs.*, history.list, auth.status, host.info). */
export type ExtraMethod = (p: Record<string, unknown>, ctx: { daemon: RelayDaemon }) => Promise<unknown>

export interface RelayDaemonOptions {
  paths: RelayPaths
  version: string
  createDriver: DriverFactory
  claudePath: () => string | null
  now?: () => number
  /** claude's environment: the relay's own with the login shell's PATH (read when a session starts). */
  env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv)
  /** The binary's own `version`, for welcome; the daemon's version by default. */
  binaryVersion?: () => Promise<string>
  /** Timers of the hello wait and the autonomy cores. */
  clock?: RelayClock
  log?: RelayLog
  /** How the daemon leaves on a restart: process.exit by default. */
  exit?: (code: number) => void
  /** Under tmux or plain: start the next daemon before this one leaves. */
  spawnSuccessor?: () => void
  /** Under systemd the unit restarts the daemon itself. */
  supervised?: boolean
  methods?: Partial<Record<RelayMethod, ExtraMethod>>
  /** The user's home, for `~`; the folder ~/.qclod is in by default. */
  home?: string
  /** How long to wait for a lock held by a daemon starting or stopping; LOCK_WAIT_MS by default. */
  lockWaitMs?: number
  /** Bytes a client may fall behind before it is cut; CLIENT_BACKLOG_MAX by default. */
  backlogMax?: number
}

interface Live {
  session: RelaySession
  autonomy: RelayAutonomy
}

interface Client {
  socket: Socket
  ready: boolean
  /** Session id → unsubscribe. */
  subscriptions: Map<string, () => void>
  /**
   * Bytes of journal catch-up written since the socket last drained: a replay
   * (up to a whole journal) is owed to the client, not a sign it stopped reading.
   */
  replayed: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function params(p: unknown): Record<string, unknown> {
  if (p === undefined || p === null) return {}
  if (!isObject(p)) throw badRequest('параметры — не объект')
  return p
}

function sessionIdOf(p: Record<string, unknown>): string {
  const s = p['s']
  if (typeof s !== 'string' || !SESSION_ID.test(s)) throw badRequest('нет id сессии')
  return s
}

/** ours — alive and ours to signal; foreign — someone else's (EPERM), so never a daemon of ours. */
function processState(pid: number): 'ours' | 'foreign' | 'gone' {
  try {
    process.kill(pid, 0)
    return 'ours'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'foreign' : 'gone'
  }
}

/**
 * Whether `pid` is a qclod-relay daemon, by /proc/<pid>/cmdline: the binary (or
 * the node bundle relay.cjs) with `daemon`. null — no /proc to tell by. The pid
 * in a lock a crash left behind is often somebody else's by now.
 */
export function looksLikeRelayDaemon(pid: number, read: (path: string) => Buffer = (p) => readFileSync(p)): boolean | null {
  let raw: Buffer
  try {
    raw = read(`/proc/${pid}/cmdline`)
  } catch {
    return null
  }
  const argv = raw
    .toString('utf8')
    .split('\0')
    .filter((a) => a !== '')
  const named = argv.some((a) => {
    const name = a.split('/').pop() ?? ''
    return name.startsWith(BINARY_NAME) || name === 'relay.cjs'
  })
  return named && argv.includes('daemon')
}

/** up — a daemon answers; down — nobody listens there (ECONNREFUSED, ENOENT); unknown — anything else. */
function socketState(path: string, ms = 1000): Promise<'up' | 'down' | 'unknown'> {
  return new Promise((resolve) => {
    const socket = connect(path)
    const done = (state: 'up' | 'down' | 'unknown'): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(state)
    }
    const timer = setTimeout(() => done('unknown'), ms)
    socket.once('connect', () => done('up'))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'down' : 'unknown')
    )
  })
}

function readLock(path: string): { text: string; mtimeMs: number } | null {
  try {
    return { text: readFileSync(path, 'utf8').trim(), mtimeMs: statSync(path).mtimeMs }
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The answer a client gives to a permission, field by field: nothing else passes. */
function readAnswer(raw: unknown): PermissionAnswer {
  if (!isObject(raw) || (raw['behavior'] !== 'allow' && raw['behavior'] !== 'deny')) {
    throw badRequest('ответ без behavior')
  }
  return {
    behavior: raw['behavior'],
    ...(typeof raw['message'] === 'string' ? { message: raw['message'] } : {}),
    ...(isObject(raw['updatedInput']) ? { updatedInput: raw['updatedInput'] } : {})
  }
}

function readExtraArgs(raw: unknown): Record<string, string | null> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isObject(raw)) throw badRequest('extraArgs')
  const out: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw badRequest(`флаг ${key}`)
    if (value !== null && typeof value !== 'string') throw badRequest(`значение флага ${key}`)
    out[key] = value
  }
  return out
}

/**
 * The relay's daemon: one per user on the server, on a unix socket in
 * ~/.qclod/run (0700, the socket 0600). It owns the sessions; clients — Qclod
 * on a PC, Qclod on a Mac, through `qclod-relay attach` — come and go. It never
 * leaves on its own: the owner's Mac may be closed for a week (decision 13).
 */
export class RelayDaemon {
  private server: Server | null = null
  private locked = false
  private started = false
  private state: RelayState = { sessions: [], rules: [], autoAnswerMs: 0 }
  private readonly live = new Map<string, Live>()
  private readonly sockets = new Set<Client>()
  private readonly now: () => number
  private readonly log: RelayLog
  private startedAt = 0
  private restartWanted = false
  private stopping = false
  private stopped: Promise<void> | null = null
  private housekeeper: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: RelayDaemonOptions) {
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? SILENT_LOG
  }

  get clients(): number {
    let n = 0
    for (const c of this.sockets) if (c.ready) n++
    return n
  }

  get paths(): RelayPaths {
    return this.opts.paths
  }

  get version(): string {
    return this.opts.version
  }

  /** The live sessions, for the methods of task 13. */
  sessions(): RelaySession[] {
    return [...this.live.values()].map((l) => l.session)
  }

  /** A session open here (not closed): what fs.upload may write for. */
  isOpen(s: string): boolean {
    const live = this.live.get(s)
    return live !== undefined && !live.session.isClosed
  }

  /**
   * The lock, before anything else (main takes it before the login shell's
   * PATH). false — another daemon holds it and answers on the socket, or is
   * still starting after LOCK_WAIT_MS: this one has nothing to do, the caller
   * exits 0. A lock nobody answers for is a dead daemon's, whatever its pid.
   */
  async acquire(): Promise<boolean> {
    if (this.locked) return true
    const { paths } = this.opts
    for (const dir of [paths.root, paths.run, paths.sessions, paths.uploads, paths.logs]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      privateMode(dir, 0o700)
    }
    const deadline = Date.now() + (this.opts.lockWaitMs ?? LOCK_WAIT_MS)
    for (let round = 0; round < 400; round++) {
      if (this.tryLock()) {
        this.locked = true
        LOCKS_HELD.add(resolve(paths.lock))
        return true
      }
      const seen = readLock(paths.lock)
      // Gone meanwhile: try again.
      if (!seen) continue
      const verdict = await this.lockVerdict(seen)
      if (verdict === 'busy') return false
      if (verdict === 'stale') {
        this.log.info('замок прошлого демона снят')
        this.dropStaleLock(seen.text)
        continue
      }
      if (Date.now() >= deadline) return false
      await sleep(LOCK_POLL_MS)
    }
    return false
  }

  /**
   * false — another daemon already holds the lock: this one has nothing to do
   * and the caller exits 0.
   */
  async start(): Promise<boolean> {
    const { paths } = this.opts
    if (!(await this.acquire())) {
      this.log.info('второй демон: уже работает другой')
      return false
    }
    this.started = true
    this.startedAt = this.now()
    this.state = loadState(paths.state)
    this.housekeep()
    this.save()

    try {
      await this.listen()
    } catch (error) {
      this.unlock()
      throw error
    }

    const open = this.state.sessions.filter((r) => r.closedAt === undefined)
    await Promise.allSettled(open.map((record) => this.restore(record)))
    this.housekeeper = setInterval(() => this.housekeep(), HOUSEKEEP_MS)
    this.housekeeper.unref?.()
    this.log.info(`демон запущен, сессий: ${open.length}`)
    return true
  }

  /** Once: a second call (a signal during a restart) waits for the first. */
  stop(): Promise<void> {
    this.stopped ??= this.halt()
    return this.stopped
  }

  /**
   * Closed sessions past 30 days go with their journals and uploads; a folder
   * of uploads no open session owns goes too. At start and once a day.
   */
  housekeep(): void {
    const { paths } = this.opts
    const before = this.state.sessions.length
    try {
      this.state = pruneClosed(this.state, paths.sessions, this.now(), paths.uploads)
      pruneUploads(paths.uploads, new Set(this.state.sessions.filter((r) => r.closedAt === undefined).map((r) => r.s)))
    } catch (error) {
      this.log.error('уборка', error)
    }
    if (this.started && this.state.sessions.length !== before) this.save()
  }

  private async halt(): Promise<void> {
    this.stopping = true
    if (this.housekeeper) clearInterval(this.housekeeper)
    this.housekeeper = null
    // Before the first await, all at once (systemd's stop: the agents may be
    // signalled too). Working now carries on after the next start; a limit
    // waited out is already marked by the core; the autonomy cores stop
    // deciding; a stream that ends from here on is the stop's, not a death.
    for (const { session, autonomy } of this.live.values()) {
      if (session.busy) session.markRunning(true)
      autonomy.dispose()
      session.markLeaving()
    }
    // Still mine, still going: a daemon started meanwhile waits rather than takes over.
    if (this.locked) {
      try {
        const t = new Date()
        utimesSync(this.opts.paths.lock, t, t)
      } catch {
        // Gone: nothing to hold off.
      }
    }
    // Ended, not cut: what was written last (a result, a notice) still reaches the client.
    for (const client of this.sockets) {
      client.socket.end()
      setTimeout(() => client.socket.destroy(), 500).unref()
    }
    this.sockets.clear()
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()))
    this.server = null
    await Promise.allSettled([...this.live.values()].map(({ session }) => session.suspend()))
    for (const { session } of this.live.values()) session.journal.close()
    this.live.clear()
    if (this.started) this.save()
    this.unlock()
    if (this.started) this.log.info('демон остановлен')
  }

  // ------------------------------------------------------------ lifecycle

  /** The lock made whole at once: the pid written aside, then linked into place. */
  private tryLock(): boolean {
    const { lock } = this.opts.paths
    const tmp = `${lock}.${process.pid}-${randomUUID().slice(0, 8)}`
    writeFileSync(tmp, String(process.pid), { mode: 0o600 })
    try {
      linkSync(tmp, lock)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error
      // No hard links on this file system: created exclusively, then written.
      try {
        const fd = openSync(lock, 'wx', 0o600)
        writeSync(fd, String(process.pid))
        closeSync(fd)
        return true
      } catch (again) {
        if ((again as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw again
      }
    } finally {
      rmSync(tmp, { force: true })
    }
  }

  /**
   * busy — a daemon answers on the socket (or this very process holds the
   * lock); starting — the lock is young and its pid could be a daemon on its
   * way up or down; stale — nobody answers and the pid is gone, someone else's,
   * not a relay, or a relay that kept its lock past the wait with no socket.
   */
  private async lockVerdict(seen: { text: string; mtimeMs: number }): Promise<'busy' | 'starting' | 'stale'> {
    if ((await socketState(this.opts.paths.socket)) !== 'down') return 'busy'
    const fresh = Date.now() - seen.mtimeMs < LOCK_FRESH_MS
    const pid = /^\d+$/.test(seen.text) ? Number(seen.text) : NaN
    // Empty: made, not yet written (a relay of before tmp+link).
    if (!Number.isSafeInteger(pid) || pid <= 0) return fresh ? 'starting' : 'stale'
    // The same pid as ours after a reboot is no daemon — unless a daemon object here holds it (tests).
    if (pid === process.pid) return this.heldHere() ? 'busy' : 'stale'
    if (processState(pid) !== 'ours') return 'stale'
    const relay = looksLikeRelayDaemon(pid)
    if (relay === false) return 'stale'
    if (fresh) return 'starting'
    if (relay === true) return (await this.retire(pid)) ? 'stale' : 'busy'
    return 'stale'
  }

  /** A relay daemon of ours with no socket and an old lock: asked to go, and waited for. */
  private async retire(pid: number): Promise<boolean> {
    this.log.info('демон без сокета: остановлен')
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return true
    }
    for (let i = 0; i < 50; i++) {
      if (processState(pid) === 'gone') return true
      await sleep(100)
    }
    return false
  }

  /**
   * Out of the way, then checked: if what was moved is not the lock judged
   * stale (another daemon took it meanwhile), it is put back.
   */
  private dropStaleLock(judged: string): void {
    const { lock } = this.opts.paths
    const aside = `${lock}.stale-${process.pid}-${randomUUID().slice(0, 8)}`
    try {
      renameSync(lock, aside)
    } catch {
      return
    }
    try {
      if (readFileSync(aside, 'utf8').trim() !== judged) {
        try {
          linkSync(aside, lock)
        } catch {
          // Another lock is there already: that one stands.
        }
      }
    } finally {
      rmSync(aside, { force: true })
    }
  }

  /** In this process, a lock file is held by a daemon object that has not stopped. */
  private heldHere(): boolean {
    return existsSync(this.opts.paths.lock) && LOCKS_HELD.has(resolve(this.opts.paths.lock))
  }

  private unlock(): void {
    if (!this.locked) return
    this.locked = false
    LOCKS_HELD.delete(resolve(this.opts.paths.lock))
    try {
      // Only a lock that is still this process's.
      if (readFileSync(this.opts.paths.lock, 'utf8').trim() === String(process.pid)) rmSync(this.opts.paths.lock)
    } catch {
      // Gone already.
    }
  }

  private async listen(): Promise<void> {
    const { socket } = this.opts.paths
    // With the lock held, a socket file left over is a dead daemon's.
    if (process.platform !== 'win32' && existsSync(socket)) unlinkSync(socket)
    const server = createServer((s) => this.accept(s))
    await new Promise<void>((done, fail) => {
      server.once('error', fail)
      server.listen(socket, () => {
        server.off('error', fail)
        done()
      })
    })
    if (process.platform !== 'win32') privateMode(socket, 0o600)
    server.on('error', (error) => this.log.error('сокет', error))
    this.server = server
  }

  private async restore(record: RelaySessionRecord): Promise<void> {
    const claude = this.opts.claudePath()
    const live = this.makeSession(record, claude ?? 'claude')
    if (!claude) {
      live.session.notice({ kind: 'text', text: 'Claude Code на сервере не найден', tone: 'error' })
      return
    }
    try {
      await live.session.start()
    } catch (error) {
      this.log.error('сессия не запустилась после старта демона', error)
    }
  }

  private makeSession(record: RelaySessionRecord, claudePath: string): Live {
    const { paths } = this.opts
    const journal = Journal.open(join(paths.sessions, record.s), {
      now: this.now,
      // A full disk: the stream goes on live, the journal catches up when it can.
      onError: (error) => this.log.error('журнал не записан', error)
    })
    const env = this.opts.env
    const session = new RelaySession({
      id: record.s,
      record,
      claudePath,
      env: typeof env === 'function' ? env() : (env ?? process.env),
      createDriver: this.opts.createDriver,
      journal,
      rules: () => this.state.rules,
      now: this.now,
      onRecord: (r) => this.recordChanged(r)
    })
    const autonomy = attachAutonomy(session, {
      autoAnswerMs: () => this.state.autoAnswerMs,
      ...(this.opts.clock ? { clock: this.opts.clock } : {})
    })
    session.onEvent((e) => {
      if (e.type === 'status' || e.type === 'resolved') this.maybeRestart()
    })
    const live: Live = { session, autonomy }
    this.live.set(record.s, live)
    return live
  }

  private recordChanged(record: RelaySessionRecord): void {
    const at = this.state.sessions.findIndex((r) => r.s === record.s)
    if (at >= 0) this.state.sessions[at] = record
    else this.state.sessions.push(record)
    this.save()
  }

  private save(): void {
    try {
      saveState(this.opts.paths.state, this.state)
    } catch (error) {
      this.log.error('state.json не записан', error)
    }
  }

  // -------------------------------------------------------------- restart

  private busyCount(): number {
    let n = 0
    for (const { session } of this.live.values()) if (session.busy || session.pendingCount > 0) n++
    return n
  }

  private maybeRestart(): void {
    if (this.restartWanted && !this.stopping && this.busyCount() === 0) void this.restartNow()
  }

  private async restartNow(): Promise<void> {
    if (this.stopping) return
    this.log.info('перезапуск демона')
    // Working sessions carry on after the restart with «продолжай» (stop marks them).
    await this.stop()
    if (!this.opts.supervised) this.opts.spawnSuccessor?.()
    ;(this.opts.exit ?? ((code: number) => process.exit(code)))(RESTART_EXIT_CODE)
  }

  // -------------------------------------------------------------- clients

  private accept(socket: Socket): void {
    const client: Client = { socket, ready: false, subscriptions: new Map(), replayed: 0 }
    this.sockets.add(client)
    socket.on('drain', () => {
      client.replayed = 0
    })
    const clock = this.opts.clock
    const onTimeout = (): void => {
      if (client.ready) return
      this.send(client, { t: 'res', id: 0, ok: false, e: { code: 'proto', message: 'нет hello' } })
      socket.end()
    }
    const helloTimer = clock ? clock.setTimeout(onTimeout, HELLO_TIMEOUT_MS) : setTimeout(onTimeout, HELLO_TIMEOUT_MS)
    const clearHello = (): void => {
      if (clock) clock.clearTimeout(helloTimer)
      else clearTimeout(helloTimer as ReturnType<typeof setTimeout>)
    }
    const decoder = new LineDecoder((line) => this.unreadable(client, line))
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (!client.ready) {
          clearHello()
          this.hello(client, frame)
          continue
        }
        void this.frame(client, frame)
      }
    })
    const gone = (): void => {
      clearHello()
      for (const unsubscribe of client.subscriptions.values()) unsubscribe()
      client.subscriptions.clear()
      if (this.sockets.delete(client) && client.ready) this.log.info(`клиент ушёл, клиентов: ${this.clients}`)
    }
    socket.on('close', gone)
    socket.on('error', () => socket.destroy())
  }

  private hello(client: Client, frame: RelayFrame): void {
    if (frame.t !== 'hello' || frame.proto !== RELAY_PROTO) {
      this.send(client, {
        t: 'res',
        id: 0,
        ok: false,
        e: { code: 'proto', message: `посредник говорит на протоколе ${RELAY_PROTO}` }
      })
      client.socket.end()
      return
    }
    client.ready = true
    void (this.opts.binaryVersion?.() ?? Promise.resolve(this.opts.version))
      .catch(() => this.opts.version)
      .then((binary) => {
        this.send(client, {
          t: 'welcome',
          proto: RELAY_PROTO,
          relay: this.opts.version,
          binary,
          startedAt: this.startedAt
        })
        this.log.info(`клиент пришёл, клиентов: ${this.clients}`)
      })
  }

  /** A line that is no frame: a request with an id still gets its answer. */
  private unreadable(client: Client, line: string): void {
    if (!client.ready) return
    try {
      const raw = JSON.parse(line) as Record<string, unknown>
      const id = raw['id']
      if (raw['t'] === 'req' && typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) {
        this.send(client, { t: 'res', id, ok: false, e: { code: 'bad_request', message: 'неизвестный метод или форма' } })
      }
    } catch {
      // Not even JSON: nothing to answer.
    }
  }

  private async frame(client: Client, frame: RelayFrame): Promise<void> {
    switch (frame.t) {
      case 'ping':
        this.send(client, { t: 'pong' })
        return
      case 'req':
        break
      default:
        return
    }
    try {
      const result = await this.method(client, frame.m, frame.p, frame.id)
      if (result === ANSWERED) return
      this.send(client, { t: 'res', id: frame.id, ok: true, r: result ?? null })
    } catch (error) {
      const code = error instanceof RelayError ? error.code : error instanceof FrameTooLarge ? 'too_large' : 'internal'
      if (code === 'internal') this.log.error(`метод ${frame.m}`, error)
      const message = error instanceof Error ? error.message : String(error)
      this.send(client, { t: 'res', id: frame.id, ok: false, e: { code, message } })
    }
  }

  private send(client: Client, frame: RelayFrame, replay = false): void {
    if (client.socket.destroyed) return
    let line: string
    try {
      line = encodeFrame(frame)
    } catch (error) {
      this.log.error('кадр больше 16 МиБ не отправлен', error)
      if (frame.t === 'res') {
        line = encodeFrame({ t: 'res', id: frame.id, ok: false, e: { code: 'too_large', message: 'ответ больше 16 МиБ' } })
      } else if (frame.t === 'ev') {
        // Its number still comes, as a line the ribbon shows: the client sees the hole, nothing is silently lost.
        line = encodeFrame({ t: 'ev', s: frame.s, q: frame.q, k: 'notice', at: frame.at, d: TOO_LARGE_NOTICE })
      } else return
    }
    client.socket.write(line)
    if (replay) client.replayed += Buffer.byteLength(line)
    if (client.socket.writableLength > (this.opts.backlogMax ?? CLIENT_BACKLOG_MAX) + client.replayed) {
      // It does not read: cut, rather than kept in memory without end. It comes back with `after`.
      this.log.info('клиент не успевает читать: отключён')
      client.socket.destroy()
    }
  }

  private liveSession(s: string): Live {
    const live = this.live.get(s)
    if (!live || live.session.isClosed) throw new RelayError('not_found', 'нет такой сессии')
    return live
  }

  private async method(client: Client, m: RelayMethod, raw: unknown, id: number): Promise<unknown> {
    const p = params(raw)
    switch (m) {
      case 'session.list':
        return [...this.live.values()].filter((l) => !l.session.isClosed).map((l) => l.session.snapshot())
      case 'session.open':
        return this.open(client, p, id)
      case 'session.attach': {
        const s = sessionIdOf(p)
        const after = p['after'] ?? 0
        if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw badRequest('after')
        this.attach(client, this.liveSession(s).session, after, id)
        return ANSWERED
      }
      case 'session.detach': {
        const s = sessionIdOf(p)
        client.subscriptions.get(s)?.()
        client.subscriptions.delete(s)
        return null
      }
      case 'session.close': {
        const live = this.liveSession(sessionIdOf(p))
        live.autonomy.dispose()
        await live.session.close()
        this.live.delete(live.session.id)
        for (const c of this.sockets) c.subscriptions.delete(live.session.id)
        // Its uploads go with the chat; the journal stays its 30 days.
        rmSync(join(this.opts.paths.uploads, live.session.id), { recursive: true, force: true })
        this.maybeRestart()
        return null
      }
      case 'session.restart': {
        const live = this.liveSession(sessionIdOf(p))
        await live.session.restart(p['resume'] !== false)
        return null
      }
      case 'drv': {
        const live = this.liveSession(sessionIdOf(p))
        const op = p['op']
        if (typeof op !== 'string' || !(RELAY_DRIVER_OPS as readonly string[]).includes(op)) throw badRequest('op')
        if (!Array.isArray(p['args'])) throw badRequest('args')
        return await live.session.call(op as (typeof RELAY_DRIVER_OPS)[number], p['args'])
      }
      case 'perm.answer': {
        const live = this.liveSession(sessionIdOf(p))
        if (typeof p['requestId'] !== 'string') throw badRequest('requestId')
        return { accepted: live.session.answer(p['requestId'], readAnswer(p['answer'])) }
      }
      case 'autonomy.act': {
        const live = this.liveSession(sessionIdOf(p))
        if (typeof p['cardId'] !== 'string') throw badRequest('cardId')
        if (p['action'] !== 'hold' && p['action'] !== 'answerNow') throw badRequest('action')
        live.autonomy.act(p['cardId'], p['action'])
        return null
      }
      case 'autonomy.settings': {
        const ms = p['autoAnswerMs']
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0 || ms > MAX_AUTO_ANSWER_MS) {
          throw badRequest('autoAnswerMs')
        }
        this.state.autoAnswerMs = ms
        this.save()
        return null
      }
      case 'rules.sync': {
        if (!Array.isArray(p['rules'])) throw badRequest('rules')
        this.state.rules = readRules(p['rules'])
        this.save()
        return null
      }
      case 'relay.restart': {
        const when = p['when']
        if (when !== 'idle' && when !== 'now') throw badRequest('when')
        const busy = this.busyCount()
        this.restartWanted = true
        // Answered first, then the daemon goes.
        setImmediate(() => (when === 'now' ? void this.restartNow() : this.maybeRestart()))
        return { scheduled: true, busy }
      }
      case 'git.run':
        // Stage 7 (task 15): git in a server project's folder, `~` as everywhere else.
        return await runGit({ ...p, cwd: typeof p['cwd'] === 'string' ? this.expand(p['cwd']) : p['cwd'] } as unknown as GitRunParams)

      default: {
        const extra = this.opts.methods?.[m]
        if (!extra) throw new RelayError('unsupported', `метод ${m} не поддерживается этим посредником`)
        return await extra(p, { daemon: this })
      }
    }
  }

  private async open(client: Client, p: Record<string, unknown>, id: number): Promise<symbol> {
    const cwdRaw = p['cwd']
    if (typeof cwdRaw !== 'string' || cwdRaw === '') throw badRequest('cwd')
    const cwd = this.expand(cwdRaw)
    let isDir = false
    try {
      isDir = statSync(cwd).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) throw new RelayError('not_found', 'папки нет на сервере')
    const mode = p['mode']
    if (typeof mode !== 'string' || !PERMISSION_MODES_SET.has(mode)) throw badRequest('mode')
    for (const key of ['resume', 'model', 'title'] as const) {
      if (p[key] !== undefined && typeof p[key] !== 'string') throw badRequest(key)
    }
    const extraArgs = readExtraArgs(p['extraArgs'])
    const claude = this.opts.claudePath()
    if (!claude) throw new RelayError('not_found', 'Claude Code на сервере не найден')

    const record: RelaySessionRecord = {
      s: randomUUID(),
      cwd,
      title: typeof p['title'] === 'string' && p['title'] !== '' ? p['title'] : basename(cwd) || cwd,
      sdkSessionId: typeof p['resume'] === 'string' && p['resume'] !== '' ? p['resume'] : null,
      mode: mode as PermissionMode,
      ...(typeof p['model'] === 'string' && p['model'] !== '' ? { model: p['model'] } : {}),
      ...(extraArgs ? { extraArgs } : {}),
      remoteControl: false,
      wasRunning: false,
      createdAt: this.now()
    }
    this.recordChanged(record)
    const live = this.makeSession(record, claude)
    this.attach(client, live.session, 0, id)
    // The start's own frames (status, init on the first message) reach the client after its answer.
    live.session.start().catch((error: unknown) => this.log.error('сессия не запустилась', error))
    return ANSWERED
  }

  /** The answer, then every ev after `after` in order, then the live stream. */
  private attach(client: Client, session: RelaySession, after: number, id: number): void {
    // A client that has seen more than this journal has (it was lost or cut
    // short) starts over from where the journal is: a gap, and every new record.
    const lastSeq = session.journal.lastSeq
    const from = Math.min(after, lastSeq)
    const { records, gap } = session.journal.readAfter(from)
    const snapshot: RelaySnapshot = session.snapshot()
    const result: AttachResult = { snapshot, gap: gap || after > lastSeq }
    this.send(client, { t: 'res', id, ok: true, r: result })
    let last = from
    for (const r of records) {
      this.send(client, { t: 'ev', s: session.id, q: r.q, k: r.k, at: r.at, d: r.d }, true)
      last = r.q
    }
    client.subscriptions.get(session.id)?.()
    const unsubscribe = session.subscribe((frame: SessionFrame) => {
      // An ev already sent from the journal is not sent twice.
      if (frame.t === 'ev') {
        if (frame.q <= last) return
        last = frame.q
      }
      this.send(client, frame)
    })
    client.subscriptions.set(session.id, unsubscribe)
  }

  private expand(path: string): string {
    const home = this.home()
    if (path === '~') return home
    if (path.startsWith('~/')) return join(home, path.slice(2))
    return isAbsolute(path) ? path : join(home, path)
  }

  /** The user's home: the folder ~/.qclod lives in. */
  home(): string {
    return this.opts.home ?? resolve(this.opts.paths.root, '..')
  }
}

/** A method that wrote its own answer (attach: the answer comes before the journal). */
const ANSWERED = Symbol('answered')

/** Lock files held by daemon objects of this process. */
const LOCKS_HELD = new Set<string>()
