import type { HookEvent, SessionStatus } from '../../shared/types'

/** How long a tab may sit in `busy` without a hook before we stop trusting it. */
export const BUSY_TIMEOUT_MS = 90_000

export interface StatusState {
  status: SessionStatus
  /**
   * The status was guessed from output silence because hooks went quiet.
   * Shown differently and never used to raise a notification.
   */
  degraded: boolean
}

export type StatusInput =
  | { kind: 'sent' }
  | { kind: 'hook'; event: HookEvent }
  | { kind: 'timeout' }
  | { kind: 'exit' }

const WAITING_MATCHERS = new Set(['permission_prompt', 'agent_needs_input'])

/**
 * Per-tab status, driven by Claude Code's own hooks (spec 6.9) rather than by
 * reading the terminal — the tab indicator and notifications are required
 * behaviour and must not rest on screen-scraping.
 */
export function reduceStatus(current: StatusState, input: StatusInput): StatusState {
  switch (input.kind) {
    case 'sent':
      return { status: 'busy', degraded: false }

    case 'exit':
      return { status: 'exited', degraded: false }

    case 'timeout':
      // The fallback from spec 6.9: assume it finished, and say the assumption
      // is a guess so nothing downstream treats it as fact.
      return current.status === 'busy' ? { status: 'idle', degraded: true } : current

    case 'hook': {
      const next = statusForHook(input.event)
      // A hook arriving means the channel works again.
      return next === null ? { ...current, degraded: false } : { status: next, degraded: false }
    }
  }
}

function statusForHook(event: HookEvent): SessionStatus | null {
  switch (event.hook_event_name) {
    case 'Stop':
      return 'idle'
    case 'PermissionRequest':
      return 'waiting'
    case 'SessionEnd':
      return 'exited'
    case 'Notification':
      if (event.matcher && WAITING_MATCHERS.has(event.matcher)) return 'waiting'
      if (event.matcher === 'idle_prompt') return 'idle'
      return 'waiting'
    default:
      return null
  }
}

/** Only tell the user about a state we actually know to be true. */
export function mayNotify(state: StatusState): boolean {
  if (state.degraded) return false
  return state.status === 'idle' || state.status === 'waiting'
}
