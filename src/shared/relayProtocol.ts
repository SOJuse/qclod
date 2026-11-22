/**
 * The wire between Qclod and its relay on a server (stage 6): one JSON object
 * per line, over `qclod-relay attach`'s stdio on the Qclod side and a unix
 * socket on the server. No Electron here — both sides import it.
 *
 * Everything read off the wire goes through `parseFrame`: a frame of the wrong
 * shape is no frame. A line longer than MAX_FRAME_BYTES is dropped whole.
 */
import type { AgentDriver } from '../main/agent/driver'
import type { PermissionRule } from '../main/agent/permissionStore'
import type { AutonomyNotice } from '../core/autonomy/types'
import type { PermissionAnswer, PermissionMode, SessionStatus } from './types'

export const RELAY_PROTO = 1
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export const RELAY_METHODS = [
  'host.info',
  'auth.status',
  'relay.restart',
  'session.list',
  'session.open',
  'session.attach',
  'session.detach',
  'session.close',
  'session.restart',
  'drv',
  'perm.answer',
  'autonomy.act',
  'autonomy.settings',
  'rules.sync',
  'fs.list',
  'fs.stat',
  'fs.read',
  'fs.index',
  'fs.upload',
  'history.list',
  // Сверка F11: the handler is stage 7's (its task 15); until then the daemon answers `unsupported`.
  'git.run'
] as const
export type RelayMethod = (typeof RELAY_METHODS)[number]

export const RELAY_ERROR_CODES = [
  'bad_request',
  'not_found',
  'too_large',
  'busy',
  'unsupported',
  'proto',
  'internal'
] as const
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number]

export const JOURNAL_KINDS = ['sdk', 'sent', 'notice'] as const
export type JournalKind = (typeof JOURNAL_KINDS)[number]

export const LIVE_KINDS = ['stream', 'perm', 'permResolved', 'autonomy', 'status', 'closed'] as const
export type LiveKind = (typeof LIVE_KINDS)[number]

export type RelayFrame =
  | { t: 'hello'; proto: number; app: string; client: string }
  | { t: 'welcome'; proto: number; relay: string; binary: string; startedAt: number }
  | { t: 'req'; id: number; m: RelayMethod; p: unknown }
  | { t: 'res'; id: number; ok: true; r: unknown }
  | { t: 'res'; id: number; ok: false; e: { code: RelayErrorCode; message: string } }
  /** In the journal: q ≥ 1, growing per session. */
  | { t: 'ev'; s: string; q: number; k: JournalKind; at: number; d: unknown }
  /** Not in the journal. */
  | { t: 'live'; s: string; k: LiveKind; d: unknown }
  | { t: 'ping' }
  | { t: 'pong' }

export class FrameTooLarge extends Error {
  constructor(bytes: number) {
    super(`кадр ${bytes} байт больше ${MAX_FRAME_BYTES}`)
    this.name = 'FrameTooLarge'
  }
}

/** One line of journal.jsonl; the same shape as an `ev` frame's tail. */
export interface JournalRecord {
  q: number
  at: number
  k: JournalKind
  d: unknown
}

/** JSON and '\n'. Throws FrameTooLarge for a line over MAX_FRAME_BYTES. */
export function encodeFrame(frame: RelayFrame): string {
  const json = JSON.stringify(frame)
  // A UTF-8 character is at most 3 bytes per UTF-16 unit: short lines skip the count.
  if (json.length * 3 > MAX_FRAME_BYTES) {
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > MAX_FRAME_BYTES) throw new FrameTooLarge(bytes)
  }
  return json + '\n'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 200
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

/** Checks the shape and keeps only the frame's own fields; anything else is null. */
export function parseFrame(line: string): RelayFrame | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObject(raw)) return null
  switch (raw['t']) {
    case 'hello':
      if (!isTime(raw['proto']) || !isText(raw['app']) || !isText(raw['client'])) return null
      return { t: 'hello', proto: raw['proto'], app: raw['app'], client: raw['client'] }
    case 'welcome':
      if (!isTime(raw['proto']) || !isText(raw['relay']) || !isText(raw['binary']) || !isTime(raw['startedAt'])) {
        return null
      }
      return { t: 'welcome', proto: raw['proto'], relay: raw['relay'], binary: raw['binary'], startedAt: raw['startedAt'] }
    case 'req':
      if (!isId(raw['id']) || !oneOf(RELAY_METHODS, raw['m'])) return null
      return { t: 'req', id: raw['id'], m: raw['m'], p: raw['p'] }
    case 'res': {
      if (!isId(raw['id'])) return null
      if (raw['ok'] === true) return { t: 'res', id: raw['id'], ok: true, r: raw['r'] }
      const e = raw['e']
      if (raw['ok'] !== false || !isObject(e) || !oneOf(RELAY_ERROR_CODES, e['code']) || !isText(e['message'])) {
        return null
      }
      return { t: 'res', id: raw['id'], ok: false, e: { code: e['code'], message: e['message'] } }
    }
    case 'ev': {
      const q = raw['q']
      if (!isName(raw['s']) || !isId(q) || q < 1 || !oneOf(JOURNAL_KINDS, raw['k']) || !isTime(raw['at'])) {
        return null
      }
      return { t: 'ev', s: raw['s'], q, k: raw['k'], at: raw['at'], d: raw['d'] }
    }
    case 'live':
      if (!isName(raw['s']) || !oneOf(LIVE_KINDS, raw['k'])) return null
      return { t: 'live', s: raw['s'], k: raw['k'], d: raw['d'] }
    case 'ping':
      return { t: 'ping' }
    case 'pong':
      return { t: 'pong' }
    default:
      return null
  }
}

const NEWLINE = 0x0a

/**
 * Bytes in, frames out. Bytes are kept until a newline, so a character cut in
 * two between chunks is read whole. A line over MAX_FRAME_BYTES is dropped
 * whole, up to its newline, without being kept in memory.
 */
export class LineDecoder {
  private parts: Buffer[] = []
  private size = 0
  /** In the middle of an oversized line: everything up to the next newline goes. */
  private skipping = false
  private droppedLines = 0
  private invalidLines = 0

  /** `onInvalid` hears each line that was no frame — the daemon answers a request it cannot read. */
  constructor(private readonly onInvalid?: (line: string) => void) {}

  /** Lines over MAX_FRAME_BYTES. */
  get dropped(): number {
    return this.droppedLines
  }

  /** Lines that were no frame. */
  get invalid(): number {
    return this.invalidLines
  }

  push(chunk: Buffer | string): RelayFrame[] {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const out: RelayFrame[] = []
    let start = 0
    for (;;) {
      const end = bytes.indexOf(NEWLINE, start)
      if (end < 0) break
      const piece = bytes.subarray(start, end)
      start = end + 1
      if (this.skipping) {
        this.skipping = false
        continue
      }
      if (this.size + piece.length > MAX_FRAME_BYTES) {
        this.parts = []
        this.size = 0
        this.droppedLines++
        continue
      }
      const line = this.size === 0 ? piece : Buffer.concat([...this.parts, piece])
      this.parts = []
      this.size = 0
      if (line.length === 0) continue
      const text = line.toString('utf8')
      const frame = parseFrame(text)
      if (frame) out.push(frame)
      else {
        this.invalidLines++
        this.onInvalid?.(text)
      }
    }
    if (start < bytes.length && !this.skipping) {
      const rest = bytes.subarray(start)
      if (this.size + rest.length > MAX_FRAME_BYTES) {
        this.parts = []
        this.size = 0
        this.skipping = true
        this.droppedLines++
      } else {
        // A copy: the caller may reuse its buffer.
        this.parts.push(Buffer.from(rest))
        this.size += rest.length
      }
    }
    return out
  }
}

/** Every AgentDriver method the relay forwards as `drv {s, op, args}`. */
export const RELAY_DRIVER_OPS = [
  'send',
  'cancelQueued',
  'interrupt',
  'setPermissionMode',
  'supportedCommands',
  'mcpServerStatus',
  'getContextUsage',
  'supportedModels',
  'setModel',
  'setEffort',
  'planLimits',
  'taskOutput',
  'stopTask',
  'backgroundTask',
  'remoteAvailability',
  'setRemoteControl'
] as const satisfies ReadonlyArray<Exclude<keyof AgentDriver, 'messages' | 'dispose' | 'hostsAutonomy'>>
export type RelayDriverOp = (typeof RELAY_DRIVER_OPS)[number]
type AllOps = Exclude<keyof AgentDriver, 'messages' | 'dispose' | 'hostsAutonomy'> extends RelayDriverOp
  ? true
  : never
/** typecheck fails here when a driver method is not forwarded. */
export const _allDriverOpsForwarded: AllOps = true

export interface RelaySnapshot {
  s: string
  cwd: string
  title: string
  sdkSessionId: string | null
  status: SessionStatus
  mode: PermissionMode
  firstSeq: number
  lastSeq: number
  pending: RelayPending[]
  autonomy: RelayAutonomyView
  remoteControl: boolean
  createdAt: number
  updatedAt: number
}

export interface RelayPending {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId?: string
  askedAt: number
}

/**
 * Сверка F5: stage 3's AutonomyView, with «in how long» instead of the
 * server's time (the clocks may differ).
 * cardId — stage 3's card id: the question's toolUseId and the ExitPlanMode
 * call's toolUseId (locally the plan card's requestId).
 */
export interface RelayAutonomyView {
  timers: Array<{ cardId: string; kind: 'question' | 'plan'; remainingMs: number; label: string }>
  limitWait: { resetsInMs: number | null; continueInMs: number; weekly: boolean } | null
  gaveUp: 'crashes' | 'limits' | null
}

export const NO_RELAY_AUTONOMY: RelayAutonomyView = { timers: [], limitWait: null, gaveUp: null }

/**
 * A journal record of k:'notice'. Сверка F5: autonomy notices go as a
 * structure, the client builds the text (`noticeText`, its own time zone).
 */
export type RelayNotice =
  | { kind: 'autonomy'; notice: AutonomyNotice; alert: boolean }
  /** The relay's own events, e.g. a driver that died. */
  | { kind: 'text'; text: string; tone: 'info' | 'error' }

export interface PermResolved {
  requestId: string
  by: 'client' | 'autonomy' | 'elsewhere'
  answer?: PermissionAnswer
}

export interface OpenParams {
  cwd: string
  resume?: string
  mode: PermissionMode
  model?: string
  extraArgs?: Record<string, string | null>
  title?: string
}

/** After the answer come the ev with q > after, then live. */
export interface AttachResult {
  snapshot: RelaySnapshot
  gap: boolean
}

export interface FsEntry {
  name: string
  kind: 'dir' | 'file' | 'link'
  size: number
  mtime: number
}

export interface HostInfo {
  hostname: string
  user: string
  home: string
  arch: 'x64' | 'arm64'
  relay: string
  supervisor: 'systemd' | 'tmux' | 'plain'
  linger: 'yes' | 'no' | 'unknown'
}

export interface ServerAuth {
  loggedIn: boolean | null
  email?: string
  plan?: string
  claudePath: string | null
  claudeVersion: string | null
}

// The parameters of each method (the answer after →):
//   session.open: OpenParams → AttachResult
//   session.attach: {s, after} → AttachResult
//   session.list: {} → RelaySnapshot[]
//   session.detach / close / restart: {s}
//   drv: {s, op: RelayDriverOp, args: unknown[]} → unknown
//   perm.answer: {s, requestId, answer: PermissionAnswer} → {accepted: boolean}
//   autonomy.act: {s, cardId, action: 'hold' | 'answerNow'}
//   live k:'autonomy': d: RelayAutonomyView — the whole view on every change
//   autonomy.settings: {autoAnswerMs: number}
//   rules.sync: {rules: PermissionRule[]}
//   fs.list: {path} → {path, entries: FsEntry[], truncated} (≤ 2000, folders first, `~` is home)
//   fs.stat: {cwd, paths: string[]} → Array<{abs, kind} | null> (≤ 200)
//   fs.read: {path, offset, length} → {dataBase64, size, eof} (length ≤ 256 KiB)
//   fs.index: {root, limit} → {files: string[], truncated}
//   fs.upload: {s, name, offset, dataBase64, final, path?} → {path} (an open session only;
//     every chunk after the first carries the path the first one answered)
//   history.list: {cwd} → SessionSummary[]
//   auth.status: {} → ServerAuth
//   host.info: {} → HostInfo
//   relay.restart: {when: 'idle' | 'now'} → {scheduled: boolean; busy: number}
//   git.run: {cwd, args, input?, timeoutMs, maxBytes, readOnly?} → {code, stdout, stderr, truncated}
//     (сверка F11; src/relay/git.ts since stage 7 — an older relay answers `unsupported`)


export interface DrvParams {
  s: string
  op: RelayDriverOp
  args: unknown[]
}
export interface PermAnswerParams {
  s: string
  requestId: string
  answer: PermissionAnswer
}
export interface AutonomyActParams {
  s: string
  cardId: string
  action: 'hold' | 'answerNow'
}
export interface RulesSyncParams {
  rules: PermissionRule[]
}
export interface GitRunParams {
  cwd: string
  args: string[]
  input?: string
  timeoutMs: number
  maxBytes: number
  readOnly?: boolean
}
export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
  truncated: boolean
}
export interface RestartResult {
  scheduled: boolean
  busy: number
}
