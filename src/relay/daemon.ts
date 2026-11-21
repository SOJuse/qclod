import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
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
import { Journal, privateMode } from './journal'
import { SILENT_LOG, type RelayLog } from './log'
import type { RelayPaths } from './paths'
import { RelaySession, type SessionFrame } from './session'
import {
  SESSION_ID,
  loadState,
  pruneClosed,
  readRules,
  saveState,
  type RelaySessionRecord,
  type RelayState
} from './stateStore'

export const HELLO_TIMEOUT_MS = 10_000
/** The exit code of a restart asked for: systemd's Restart=always brings the daemon back. */
export const RESTART_EXIT_CODE = 75
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
  /** claude's environment: the relay's own with the login shell's PATH. */
  env?: NodeJS.ProcessEnv
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

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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
  private lockFd: number | null = null
  private state: RelayState = { sessions: [], rules: [], autoAnswerMs: 0 }
  private readonly live = new Map<string, Live>()
  private readonly sockets = new Set<Client>()
  private readonly now: () => number
  private readonly log: RelayLog
  private startedAt = 0
  private restartWanted = false
  private stopping = false

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

  /**
   * false — another daemon already holds the lock: this one has nothing to do
   * and the caller exits 0.
   */
  async start(): Promise<boolean> {
    const { paths } = this.opts
    for (const dir of [paths.root, paths.run, paths.sessions, paths.uploads, paths.logs]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      privateMode(dir, 0o700)
    }
    if (!this.lock()) {
      this.log.info('второй демон: уже работает другой')
      return false
    }
    this.startedAt = this.now()
    this.state = pruneClosed(loadState(paths.state), paths.sessions, this.now())
    this.save()

    try {
      await this.listen()
    } catch (error) {
      this.unlock()
      throw error
    }

    const open = this.state.sessions.filter((r) => r.closedAt === undefined)
    await Promise.allSettled(open.map((record) => this.restore(record)))
    this.log.info(`демон запущен, сессий: ${open.length}`)
    return true
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    // Ended, not cut: what was written last (a result, a notice) still reaches the client.
    for (const client of this.sockets) {
      client.socket.end()
      setTimeout(() => client.socket.destroy(), 500).unref()
    }
    this.sockets.clear()
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()))
    this.server = null
    for (const { session, autonomy } of this.live.values()) {
      autonomy.dispose()
      // Working now carries on after the next start; a limit waited out is already marked by the core.
      if (session.busy) session.markRunning(true)
    }
    await Promise.allSettled([...this.live.values()].map(({ session }) => session.suspend()))
    for (const { session } of this.live.values()) session.journal.close()
    this.live.clear()
    this.save()
    this.unlock()
    this.log.info('демон остановлен')
  }

  // ------------------------------------------------------------ lifecycle

  private lock(): boolean {
    const { lock } = this.opts.paths
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, 'wx', 0o600)
        writeSync(fd, String(process.pid))
        this.lockFd = fd
        LOCKS_HELD.add(resolve(lock))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let pid = NaN
        try {
          pid = Number(readFileSync(lock, 'utf8').trim())
        } catch {
          // Gone meanwhile: try again.
        }
        // A daemon of this very process holds it too (tests run two in one).
        if (processAlive(pid) && (pid !== process.pid || this.heldHere())) return false
        rmSync(lock, { force: true })
      }
    }
    return false
  }

  /** In this process, a lock file is held by a daemon object that has not stopped. */
  private heldHere(): boolean {
    return existsSync(this.opts.paths.lock) && LOCKS_HELD.has(resolve(this.opts.paths.lock))
  }

  private unlock(): void {
    if (this.lockFd === null) return
    try {
      closeSync(this.lockFd)
    } catch {
      // Already closed.
    }
    this.lockFd = null
    LOCKS_HELD.delete(resolve(this.opts.paths.lock))
    rmSync(this.opts.paths.lock, { force: true })
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
    const journal = Journal.open(join(paths.sessions, record.s), { now: this.now })
    const session = new RelaySession({
      id: record.s,
      record,
      claudePath,
      env: this.opts.env ?? process.env,
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
    const client: Client = { socket, ready: false, subscriptions: new Map() }
    this.sockets.add(client)
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

  private send(client: Client, frame: RelayFrame): void {
    if (client.socket.destroyed) return
    let line: string
    try {
      line = encodeFrame(frame)
    } catch (error) {
      this.log.error('кадр больше 16 МиБ не отправлен', error)
      if (frame.t === 'res') {
        line = encodeFrame({ t: 'res', id: frame.id, ok: false, e: { code: 'too_large', message: 'ответ больше 16 МиБ' } })
      } else return
    }
    client.socket.write(line)
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
        // Сверка F11: stage 7 writes the handler.
        throw new RelayError('unsupported', 'git.run появится в этапе 7')
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
    const { records, gap } = session.journal.readAfter(after)
    const snapshot: RelaySnapshot = session.snapshot()
    const result: AttachResult = { snapshot, gap }
    this.send(client, { t: 'res', id, ok: true, r: result })
    let last = after
    for (const r of records) {
      this.send(client, { t: 'ev', s: session.id, q: r.q, k: r.k, at: r.at, d: r.d })
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
