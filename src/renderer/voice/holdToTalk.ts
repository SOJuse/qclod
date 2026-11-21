import type { KeyLike } from '../input/keyPrecedence'

export type HoldAction = 'start' | 'stop' | null

/**
 * Ctrl+Space and the microphone button, both ways at once (G1, decision 5):
 * held for 400 ms or more — talk while holding, stop on release; a shorter
 * press — start, and the next press stops.
 */
export class HoldToTalk {
  /** When the press that started the recording went down; null — no such press is down. */
  private startedAt: number | null = null

  constructor(private readonly holdMs = 400) {}

  down(listening: boolean, now: number): HoldAction {
    if (listening) {
      this.startedAt = null
      return 'stop'
    }
    this.startedAt = now
    return 'start'
  }

  up(now: number): HoldAction {
    const started = this.startedAt
    this.startedAt = null
    if (started === null) return null
    return now - started >= this.holdMs ? 'stop' : null
  }

  /** Потеря фокуса или скрытие окна: стоп только для удержания. */
  blur(): HoldAction {
    const holding = this.startedAt !== null
    this.startedAt = null
    return holding ? 'stop' : null
  }
}

/** Ctrl+Space by the physical key, so any layout works; Ctrl+Shift+Space is the window's global key. */
export function isVoiceKey(ev: KeyLike): boolean {
  if (ev.isComposing || ev.keyCode === 229) return false
  return ev.code === 'Space' && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey
}
