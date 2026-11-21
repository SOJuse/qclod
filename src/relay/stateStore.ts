import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PermissionRule } from '../main/agent/permissionStore'
import { PERMISSION_MODES, type PermissionMode } from '../shared/types'
import { privateMode } from './journal'

export interface RelaySessionRecord {
  s: string
  cwd: string
  title: string
  sdkSessionId: string | null
  /** Qclod's own mode, autoAllow included; the SDK is told sdkPermissionMode(mode). */
  mode: PermissionMode
  model?: string
  remoteControl: boolean
  /** It was working when the daemon went down: it gets «продолжай» on the next start. */
  wasRunning: boolean
  /** «Закрыть чат»: the agent is stopped, the journal kept for 30 days. */
  closedAt?: number
  createdAt: number
}

/** ~/.qclod/state.json */
export interface RelayState {
  sessions: RelaySessionRecord[]
  rules: PermissionRule[]
  autoAnswerMs: number
}

export const CLOSED_KEEP_MS = 30 * 24 * 60 * 60 * 1000
/** Qclod's default, 5 minutes, until a client says otherwise (autonomy.settings). */
export const DEFAULT_AUTO_ANSWER_MS = 5 * 60_000

/** A session id is a folder name: nothing that could step outside sessions/. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

export function emptyState(): RelayState {
  return { sessions: [], rules: [], autoAnswerMs: DEFAULT_AUTO_ANSWER_MS }
}

function str(value: unknown): value is string {
  return typeof value === 'string'
}

function readSession(raw: unknown): RelaySessionRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!str(r['s']) || !SESSION_ID.test(r['s']) || !str(r['cwd']) || !str(r['title'])) return null
  if (!(PERMISSION_MODES as readonly unknown[]).includes(r['mode'])) return null
  if (typeof r['createdAt'] !== 'number') return null
  return {
    s: r['s'],
    cwd: r['cwd'],
    title: r['title'],
    sdkSessionId: str(r['sdkSessionId']) ? r['sdkSessionId'] : null,
    mode: r['mode'] as PermissionMode,
    ...(str(r['model']) ? { model: r['model'] } : {}),
    remoteControl: r['remoteControl'] === true,
    wasRunning: r['wasRunning'] === true,
    ...(typeof r['closedAt'] === 'number' ? { closedAt: r['closedAt'] } : {}),
    createdAt: r['createdAt']
  }
}

export function readRules(raw: unknown): PermissionRule[] {
  if (!Array.isArray(raw)) return []
  const rules: PermissionRule[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const r = entry as Record<string, unknown>
    if (!str(r['id']) || !str(r['toolName']) || r['toolName'] === '') continue
    if (r['behavior'] !== 'allow' && r['behavior'] !== 'deny') continue
    rules.push({
      id: r['id'],
      toolName: r['toolName'],
      ...(str(r['target']) ? { target: r['target'] } : {}),
      behavior: r['behavior']
    })
  }
  return rules
}

/** A damaged file gives an empty state; the file is kept beside it as .bad. */
export function loadState(path: string): RelayState {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return emptyState()
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    try {
      copyFileSync(path, path + '.bad')
    } catch {
      // Nothing more to keep.
    }
    return emptyState()
  }
  if (typeof raw !== 'object' || raw === null) return emptyState()
  const r = raw as Record<string, unknown>
  const sessions = Array.isArray(r['sessions'])
    ? r['sessions'].map(readSession).filter((s): s is RelaySessionRecord => s !== null)
    : []
  const ms = r['autoAnswerMs']
  return {
    sessions,
    rules: readRules(r['rules']),
    autoAnswerMs: typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_AUTO_ANSWER_MS
  }
}

/** Written aside and renamed into place: a crash mid-write leaves the old file whole. */
export function saveState(path: string, state: RelayState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  privateMode(tmp, 0o600)
  renameSync(tmp, path)
}

/** Sessions closed more than 30 days ago go, with their folders. */
export function pruneClosed(state: RelayState, sessionsDir: string, now: number): RelayState {
  const keep: RelaySessionRecord[] = []
  for (const session of state.sessions) {
    if (session.closedAt !== undefined && now - session.closedAt > CLOSED_KEEP_MS) {
      rmSync(join(sessionsDir, session.s), { recursive: true, force: true })
    } else {
      keep.push(session)
    }
  }
  return { ...state, sessions: keep }
}
