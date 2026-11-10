import type { RemoteBlock, RemoteInfo, RemoteState } from './types'

export type RemoteAvailability = { available: true } | { available: false; reason: RemoteBlock }

export const REMOTE_OFF: RemoteInfo = { state: 'off' }

export const REMOTE_STATE_LABEL: Record<RemoteState, string> = {
  off: 'выключен',
  connecting: 'подключается…',
  on: 'на связи',
  reconnecting: 'переподключается…',
  failed: 'нет связи'
}

export const REMOTE_BLOCK_TEXT: Record<RemoteBlock, string> = {
  sdk: 'Эта версия Qclod не умеет включать Remote Control. Обновите Qclod.',
  cli: 'Ваш Claude Code не предлагает Remote Control. Обновите его командой claude update; если не поможет — возможно, Remote Control отключён в вашей организации.',
  api_key:
    'Remote Control работает только при входе через подписку claude.ai (Pro, Max, Team или Enterprise). Сейчас Claude Code вошёл по API-ключу. Войдите через claude.ai командой /login и перезапустите вкладку.',
  provider:
    'Remote Control работает только с подпиской claude.ai, а этот Claude Code подключён через Bedrock, Vertex или другой сервис.'
}

const POLICY_TEXT = 'Remote Control отключён политикой вашей организации.'

export function isRemoteLive(info: RemoteInfo | undefined): boolean {
  return !!info && info.state !== 'off' && info.state !== 'failed'
}

export function safeRemoteUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function availabilityFrom(hasMethod: boolean, init: unknown): RemoteAvailability {
  if (!hasMethod) return { available: false, reason: 'sdk' }
  const rec = asRecord(init)
  if (!rec) return { available: true }
  if (rec.remote_control_available === false) return { available: false, reason: 'cli' }
  const account = asRecord(rec.account)
  if (account) {
    if (account.apiProvider && account.apiProvider !== 'firstParty') {
      return { available: false, reason: 'provider' }
    }
    if (account.apiKeySource && !account.subscriptionType) {
      return { available: false, reason: 'api_key' }
    }
  }
  return { available: true }
}

function sameInfo(a: RemoteInfo, b: RemoteInfo): boolean {
  return a.state === b.state && a.url === b.url && a.problem === b.problem && a.blocked === b.blocked
}

export function remoteFromMessage(message: unknown, current: RemoteInfo): RemoteInfo | null {
  const msg = asRecord(message)
  if (!msg || msg.type !== 'system') return null
  let next: RemoteInfo
  if (msg.subtype === 'worker_shutting_down') {
    if (msg.reason !== 'remote_control_disabled') return null
    next = { state: 'off' }
  } else if (msg.subtype === 'bridge_state') {
    if (current.state === 'off') return null
    const { problem: _problem, ...rest } = current
    switch (msg.state) {
      case 'ready':
      case 'connected':
        next = { ...rest, state: 'on' }
        break
      case 'reconnecting':
        next = { ...rest, state: 'reconnecting' }
        break
      case 'failed': {
        const detail = typeof msg.detail === 'string' && msg.detail ? ` ${msg.detail}` : ''
        next = { ...rest, state: 'failed', problem: `Связь с claude.ai потеряна.${detail}` }
        break
      }
      case 'policy_disabled':
        next = { ...rest, state: 'failed', problem: POLICY_TEXT }
        break
      default:
        return null
    }
  } else {
    return null
  }
  return sameInfo(next, current) ? null : next
}

export function explainRemoteError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/api.?key|subscription|claude\.ai account|log ?in|oauth|not logged/i.test(message)) {
    return REMOTE_BLOCK_TEXT.api_key
  }
  return `Не удалось включить Remote Control: ${message}`
}
