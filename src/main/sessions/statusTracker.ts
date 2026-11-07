import type { HookEvent, TabId } from '../../shared/types'
import { reduceStatus, type StatusState } from './sessionStatus'

/**
 * How long a busy tab may produce NO output at all before the status is
 * downgraded to a guess. Spec 6.9's fallback is silence, not elapsed time: a
 * long turn that is streaming output is working, however long it takes.
 */
export const SILENCE_TIMEOUT_MS = 45_000

const INITIAL: StatusState = { status: 'idle', degraded: false }

/** Per-tab session status, with the silence fallback from spec 6.9. */
export class StatusTracker {
  private readonly states = new Map<TabId, StatusState>()
  private readonly timers = new Map<TabId, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly onChange: (tabId: TabId, state: StatusState) => void,
    private readonly silenceMs: number = SILENCE_TIMEOUT_MS
  ) {}

  get size(): number {
    return this.states.size
  }

  get(tabId: TabId): StatusState | undefined {
    return this.states.get(tabId)
  }

  sent(tabId: TabId): void {
    this.apply(tabId, { kind: 'sent' })
  }

  hook(tabId: TabId, event: HookEvent): void {
    // A hook for a tab that is gone is not ours to act on.
    if (!this.states.has(tabId)) return
    this.apply(tabId, { kind: 'hook', event })
  }

  /** The agent printed something: it is alive, so restart the silence clock. */
  output(tabId: TabId): void {
    if (this.states.get(tabId)?.status !== 'busy') return
    this.arm(tabId)
  }

  exited(tabId: TabId): void {
    this.apply(tabId, { kind: 'exit' })
  }

  /** The tab is closed: drop its state and its timer so neither leaks. */
  forget(tabId: TabId): void {
    this.clear(tabId)
    this.states.delete(tabId)
  }

  dispose(): void {
    for (const tabId of [...this.states.keys()]) this.forget(tabId)
  }

  private apply(tabId: TabId, input: Parameters<typeof reduceStatus>[1]): void {
    const current = this.states.get(tabId) ?? INITIAL
    const next = reduceStatus(current, input)
    this.states.set(tabId, next)

    if (next.status === 'busy') this.arm(tabId)
    else this.clear(tabId)

    if (next.status === current.status && next.degraded === current.degraded) return
    this.onChange(tabId, next)
  }

  private arm(tabId: TabId): void {
    this.clear(tabId)
    this.timers.set(
      tabId,
      setTimeout(() => {
        this.timers.delete(tabId)
        if (this.states.has(tabId)) this.apply(tabId, { kind: 'timeout' })
      }, this.silenceMs)
    )
  }

  private clear(tabId: TabId): void {
    const timer = this.timers.get(tabId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(tabId)
  }
}
