import type { AgentDriver, DriverFactory, DriverOptions, SendOptions } from '../main/agent/driver'
import type { PermissionRule } from '../main/agent/permissionStore'
import {
  NO_RELAY_AUTONOMY,
  RELAY_DRIVER_OPS,
  type JournalRecord,
  type LiveKind,
  type PermResolved,
  type RelayAutonomyView,
  type RelayDriverOp,
  type RelayFrame,
  type RelayNotice,
  type RelayPending,
  type RelaySnapshot
} from '../shared/relayProtocol'
import {
  PERMISSION_MODES,
  sdkPermissionMode,
  type Attachment,
  type PermissionAnswer,
  type PermissionMode,
  type SessionStatus,
  type UserInput
} from '../shared/types'
import { RelayError, badRequest } from './errors'
import { RelayGate } from './gate'
import type { Journal } from './journal'
import type { RelaySessionRecord } from './stateStore'

export type SessionFrame = Extract<RelayFrame, { t: 'ev' | 'live' }>

/** Who sent a message: a person through a client, or the autonomy core. */
export type SentBy = 'client' | 'autonomy'

/** What the session tells the autonomy core and the daemon (task 11, 12). */
export type SessionEvent =
  | { type: 'sdk'; message: unknown }
  | { type: 'status'; status: SessionStatus }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'asked'; pending: RelayPending }
  | { type: 'resolved'; resolved: PermResolved }
  | { type: 'sent'; by: SentBy }
  /** A client's own Remote Control switch. */
  | { type: 'remoteWanted'; wanted: boolean }
  /** A client pressed «Стоп». */
  | { type: 'interrupted' }
  /** A process is up and reading. */
  | { type: 'up' }
  /** The process ended by itself: not a close, suspend or restart. */
  | { type: 'died'; error: string }

export interface RelaySessionOptions {
  id: string
  record: RelaySessionRecord
  claudePath: string
  env: NodeJS.ProcessEnv
  createDriver: DriverFactory
  journal: Journal
  rules: () => PermissionRule[]
  now?: () => number
  /** The record changed (sdkSessionId, mode, model, Remote Control, closedAt): write the state. */
  onRecord?: (record: RelaySessionRecord) => void
}

const SEND_PRIORITIES = new Set(['now', 'next', 'later'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One attachment of a client's message, checked field by field. */
function readAttachment(raw: unknown): Attachment {
  if (!isObject(raw)) throw badRequest('вложение — не объект')
  if (raw['kind'] === 'file') {
    if (typeof raw['path'] !== 'string' || raw['path'] === '') throw badRequest('у файла нет пути')
    return { kind: 'file', path: raw['path'] }
  }
  if (raw['kind'] === 'image') {
    if (typeof raw['mediaType'] !== 'string' || typeof raw['dataBase64'] !== 'string') {
      throw badRequest('картинка без типа или данных')
    }
    return {
      kind: 'image',
      mediaType: raw['mediaType'],
      dataBase64: raw['dataBase64'],
      ...(typeof raw['path'] === 'string' ? { path: raw['path'] } : {}),
      ...(typeof raw['thumbnail'] === 'string' ? { thumbnail: raw['thumbnail'] } : {}),
      ...(typeof raw['width'] === 'number' ? { width: raw['width'] } : {}),
      ...(typeof raw['height'] === 'number' ? { height: raw['height'] } : {})
    }
  }
  throw badRequest('неизвестное вложение')
}

export function readUserInput(raw: unknown): UserInput {
  if (!isObject(raw) || typeof raw['text'] !== 'string' || !Array.isArray(raw['attachments'])) {
    throw badRequest('сообщение без текста или вложений')
  }
  return { text: raw['text'], attachments: raw['attachments'].map(readAttachment) }
}

function readSendOptions(raw: unknown): SendOptions | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isObject(raw)) throw badRequest('параметры отправки — не объект')
  const out: SendOptions = {}
  if (raw['uuid'] !== undefined) {
    if (typeof raw['uuid'] !== 'string' || raw['uuid'].length > 100) throw badRequest('uuid')
    out.uuid = raw['uuid']
  }
  if (raw['priority'] !== undefined) {
    if (typeof raw['priority'] !== 'string' || !SEND_PRIORITIES.has(raw['priority'])) throw badRequest('priority')
    out.priority = raw['priority'] as SendOptions['priority'] & string
  }
  return out
}

/** The journal keeps the picture's thumbnail, not its bytes: the agent already has them. */
function withoutImageBytes(input: UserInput): UserInput {
  return {
    text: input.text,
    attachments: input.attachments.map((a) => (a.kind === 'image' ? { ...a, dataBase64: '' } : a))
  }
}

/** An SDK echo of a message with pictures, without their base64: the journal is no image store. */
function stripEchoImages(message: unknown): unknown {
  if (!isObject(message) || message['type'] !== 'user') return message
  const inner = message['message']
  if (!isObject(inner) || !Array.isArray(inner['content'])) return message
  let changed = false
  const content = inner['content'].map((block: unknown) => {
    if (!isObject(block) || block['type'] !== 'image' || !isObject(block['source'])) return block
    const source = block['source']
    if (source['type'] !== 'base64' || typeof source['data'] !== 'string' || source['data'] === '') return block
    changed = true
    return { ...block, source: { ...source, data: '' } }
  })
  return changed ? { ...message, message: { ...inner, content } } : message
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

/**
 * One chat on the server, with no window behind it: the driver, the journal
 * of everything it said, and the permission gate every client shares.
 *
 * Each SDK message is written to the journal and sent to the subscribers as
 * `ev`; only `stream_event` goes live and unrecorded. The session outlives
 * every client: they come and go as subscribers, it carries on.
 */
export class RelaySession {
  readonly id: string
  private current: RelaySessionRecord
  private driver: AgentDriver | null = null
  private starting: Promise<void> | null = null
  private state: SessionStatus = 'stopped'
  /** A turn is under way, from a send (or a phone turn) to the result that ends the queue. */
  private turn = false
  private closed = false
  private updated: number
  private readonly gate: RelayGate
  private readonly subscribers = new Set<(f: SessionFrame) => void>()
  private readonly listeners: Array<(e: SessionEvent) => void> = []
  private readonly now: () => number
  private autonomyView: () => RelayAutonomyView = () => NO_RELAY_AUTONOMY

  constructor(private readonly opts: RelaySessionOptions) {
    this.id = opts.id
    this.current = { ...opts.record }
    this.now = opts.now ?? Date.now
    this.updated = opts.record.createdAt
    this.gate = new RelayGate({ rules: opts.rules, mode: () => this.current.mode, now: this.now })
    this.gate.onAsked((pending) => {
      this.live('perm', pending)
      this.event({ type: 'asked', pending })
      this.refreshStatus()
    })
    this.gate.onResolved((resolved) => {
      this.live('permResolved', resolved)
      this.event({ type: 'resolved', resolved })
      this.refreshStatus()
    })
  }

  get record(): RelaySessionRecord {
    return { ...this.current }
  }

  get status(): SessionStatus {
    return this.state
  }

  /** Working: a turn under way or a question waiting for an answer. */
  get busy(): boolean {
    return this.state === 'busy' || this.state === 'waiting'
  }

  get pendingCount(): number {
    return this.gate.pending().length
  }

  get isClosed(): boolean {
    return this.closed
  }

  get journal(): Journal {
    return this.opts.journal
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new RelayError('not_found', 'сессия закрыта'))
    if (this.driver) return Promise.resolve()
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  snapshot(): RelaySnapshot {
    const r = this.current
    return {
      s: this.id,
      cwd: r.cwd,
      title: r.title,
      sdkSessionId: r.sdkSessionId,
      status: this.state,
      mode: r.mode,
      firstSeq: this.opts.journal.firstSeq,
      lastSeq: this.opts.journal.lastSeq,
      pending: this.gate.pending(),
      autonomy: this.autonomyView(),
      remoteControl: r.remoteControl,
      createdAt: r.createdAt,
      updatedAt: this.updated
    }
  }

  async call(op: RelayDriverOp, args: unknown[]): Promise<unknown> {
    if (!(RELAY_DRIVER_OPS as readonly string[]).includes(op)) throw badRequest(`неизвестная операция ${String(op)}`)
    if (!Array.isArray(args)) throw badRequest('args — не массив')
    switch (op) {
      case 'send':
        this.send(readUserInput(args[0]), readSendOptions(args[1]), 'client')
        return undefined
      case 'setPermissionMode': {
        const mode = args[0]
        if (!(PERMISSION_MODES as readonly unknown[]).includes(mode)) throw badRequest('неизвестный режим')
        const driver = await this.ready()
        await driver.setPermissionMode(sdkPermissionMode(mode as string))
        this.setMode(mode as PermissionMode)
        return undefined
      }
      case 'setModel': {
        if (typeof args[0] !== 'string' || args[0] === '') throw badRequest('модель')
        const driver = await this.ready()
        await driver.setModel(args[0])
        this.patch({ model: args[0] })
        return undefined
      }
      case 'setRemoteControl': {
        if (typeof args[0] !== 'boolean') throw badRequest('enabled')
        const name = typeof args[1] === 'string' ? args[1] : undefined
        this.event({ type: 'remoteWanted', wanted: args[0] })
        return await this.setRemote(args[0], name)
      }
      case 'interrupt': {
        const driver = await this.ready()
        this.event({ type: 'interrupted' })
        return await driver.interrupt(...(args as [{ cancelQueued?: boolean }?]))
      }
      default: {
        const driver = await this.ready()
        const method = driver[op] as (...a: unknown[]) => unknown
        return await method.apply(driver, args)
      }
    }
  }

  /** A message into the session: recorded as `sent`, then given to the agent. */
  send(input: UserInput, opts: SendOptions | undefined, by: SentBy): void {
    const driver = this.driver
    if (!driver || this.closed) throw new RelayError('busy', 'Claude Code на сервере не запущен')
    this.append('sent', { input: withoutImageBytes(input), ...(opts ? { opts } : {}), by })
    this.turn = true
    this.event({ type: 'sent', by })
    this.refreshStatus()
    driver.send(input, opts)
  }

  /** Remote Control on or off; the record keeps the wish for the next process. */
  async setRemote(enabled: boolean, name?: string): Promise<unknown> {
    this.patch({ remoteControl: enabled })
    const driver = await this.ready()
    return await driver.setRemoteControl(enabled, name)
  }

  answer(requestId: string, answer: PermissionAnswer): boolean {
    return this.gate.answer(requestId, answer, 'client')
  }

  /** The autonomy core's answer, or anyone else's but a client's. */
  resolve(requestId: string, answer: PermissionAnswer, by: PermResolved['by']): boolean {
    return this.gate.answer(requestId, answer, by)
  }

  pending(): RelayPending[] {
    return this.gate.pending()
  }

  subscribe(listener: (f: SessionFrame) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  /** For the autonomy core and the daemon: what the session goes through. */
  onEvent(cb: (e: SessionEvent) => void): () => void {
    this.listeners.push(cb)
    return () => {
      const at = this.listeners.indexOf(cb)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }

  /** Where `snapshot().autonomy` comes from (task 11). */
  setAutonomySource(view: () => RelayAutonomyView): void {
    this.autonomyView = view
  }

  /** A live frame to every subscriber; nothing recorded. */
  live(k: LiveKind, d: unknown): void {
    this.broadcast({ t: 'live', s: this.id, k, d })
  }

  /** A journal record, sent to every subscriber as `ev`. */
  append(k: JournalRecord['k'], d: unknown): JournalRecord {
    const rec = this.opts.journal.append(k, d)
    this.updated = rec.at
    this.broadcast({ t: 'ev', s: this.id, q: rec.q, k: rec.k, at: rec.at, d: rec.d })
    return rec
  }

  notice(notice: RelayNotice): void {
    this.append('notice', notice)
  }

  async restart(resume: boolean): Promise<void> {
    if (this.closed) throw new RelayError('not_found', 'сессия закрыта')
    await this.stopDriver()
    if (!resume) this.patch({ sdkSessionId: null })
    await this.start()
  }

  /** Before the daemon restarts: the driver goes, the record stays. */
  async suspend(): Promise<void> {
    await this.stopDriver()
  }

  /** «Закрыть чат»: claude is stopped and the session is marked closed. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.stopDriver()
    this.patch({ closedAt: this.now(), wasRunning: false })
    this.live('closed', null)
    this.subscribers.clear()
    this.opts.journal.close()
  }

  /** Marks whether the session was working when the daemon went down. */
  markRunning(wasRunning: boolean): void {
    if (this.current.wasRunning !== wasRunning) this.patch({ wasRunning })
  }

  // ------------------------------------------------------------- inside

  private async launch(): Promise<void> {
    this.setStatus('starting')
    const r = this.current
    const options: DriverOptions = {
      cwd: r.cwd,
      executablePath: this.opts.claudePath,
      ...(r.model ? { model: r.model } : {}),
      permissionMode: sdkPermissionMode(r.mode),
      ...(r.sdkSessionId ? { resume: r.sdkSessionId } : {}),
      env: this.opts.env,
      canUseTool: (toolName, input, ctx) => this.gate.request(toolName, input, ctx)
    }
    let driver: AgentDriver
    try {
      driver = await this.opts.createDriver(options)
    } catch (error) {
      this.setStatus('error')
      this.notice({ kind: 'text', text: `Claude Code на сервере не запустился: ${errorText(error)}`, tone: 'error' })
      throw new RelayError('internal', errorText(error))
    }
    if (this.closed) {
      await driver.dispose().catch(() => undefined)
      return
    }
    this.driver = driver
    this.turn = false
    this.setStatus('idle')
    void this.pump(driver)
    this.event({ type: 'up' })
  }

  private async ready(): Promise<AgentDriver> {
    if (this.starting) await this.starting
    if (!this.driver || this.closed) throw new RelayError('busy', 'Claude Code на сервере не запущен')
    return this.driver
  }

  private async pump(driver: AgentDriver): Promise<void> {
    let error: unknown = null
    try {
      for await (const message of driver.messages) {
        if (this.driver !== driver) return
        this.onMessage(message)
      }
    } catch (e) {
      error = e
    }
    if (this.driver !== driver) return
    // Ended by itself: not a close, a suspend or a restart.
    this.driver = null
    this.turn = false
    this.gate.cancelAll()
    this.setStatus('error')
    const why = errorText(error)
    this.notice({
      kind: 'text',
      text: why ? `Claude Code на сервере завершился: ${why}` : 'Claude Code на сервере завершился',
      tone: 'error'
    })
    this.event({ type: 'died', error: why })
    void driver.dispose().catch(() => undefined)
  }

  private onMessage(message: unknown): void {
    if (isObject(message) && message['type'] === 'stream_event') {
      this.live('stream', message)
      return
    }
    this.append('sdk', stripEchoImages(message))
    if (isObject(message)) {
      if (message['type'] === 'system' && message['subtype'] === 'init' && typeof message['session_id'] === 'string') {
        if (message['session_id'] !== this.current.sdkSessionId) this.patch({ sdkSessionId: message['session_id'] })
      } else if (message['type'] === 'result') {
        const queued = message['queued_turn_count']
        this.turn = typeof queued === 'number' && queued > 0
      } else if (message['type'] === 'assistant') {
        // A turn typed on the phone has no send here.
        this.turn = true
      }
    }
    this.event({ type: 'sdk', message })
    this.refreshStatus()
  }

  private async stopDriver(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined)
    const driver = this.driver
    this.driver = null
    this.turn = false
    this.gate.cancelAll()
    if (driver) await driver.dispose().catch(() => undefined)
    this.setStatus('stopped')
  }

  private setMode(mode: PermissionMode): void {
    if (this.current.mode === mode) return
    this.patch({ mode })
    this.event({ type: 'mode', mode })
  }

  private refreshStatus(): void {
    if (!this.driver) return
    this.setStatus(this.gate.pending().length > 0 ? 'waiting' : this.turn ? 'busy' : 'idle')
  }

  private setStatus(status: SessionStatus): void {
    if (this.state === status) return
    this.state = status
    this.live('status', { status })
    this.event({ type: 'status', status })
  }

  private patch(patch: Partial<RelaySessionRecord>): void {
    const next: RelaySessionRecord = { ...this.current, ...patch }
    if (patch.sdkSessionId === null) next.sdkSessionId = null
    this.current = next
    this.opts.onRecord?.(this.record)
  }

  private broadcast(frame: SessionFrame): void {
    for (const listener of [...this.subscribers]) {
      try {
        listener(frame)
      } catch {
        // One client's broken pipe is not the session's problem.
      }
    }
  }

  private event(e: SessionEvent): void {
    for (const cb of [...this.listeners]) cb(e)
  }
}
