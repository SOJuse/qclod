/**
 * A fake clock and a recording host for AutonomyCore tests. Timers fire only
 * when the test moves the clock with `advance`; `jump` moves it without
 * firing anything, the way a sleeping machine does.
 */
import { AutonomyCore } from '../../src/core/autonomy'
import type {
  AutonomyClock,
  AutonomyCommand,
  AutonomyEvent,
  AutonomyNotice,
  AutonomyOptions,
  AutonomyOutput
} from '../../src/core/autonomy/types'
import type { AutonomyView, TabAutonomyRecord } from '../../src/shared/types'

interface PendingTimer {
  at: number
  fire: () => void
  cancelled: boolean
}

export class FakeClock implements AutonomyClock {
  current: number
  readonly timers: PendingTimer[] = []
  /** Every `ms` ever asked for. */
  readonly requested: number[] = []

  constructor(start = 1_700_000_000_000) {
    this.current = start
  }

  now(): number {
    return this.current
  }

  setTimer(ms: number, fire: () => void): () => void {
    this.requested.push(ms)
    const timer: PendingTimer = { at: this.current + ms, fire, cancelled: false }
    this.timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }

  /** Moves the clock forward by `ms`, firing every timer that comes due, in order. */
  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.cancelled = true
      this.current = Math.max(this.current, due.at)
      due.fire()
    }
    this.current = target
  }

  /** Moves the clock forward with no timer firing: the machine slept. */
  jump(ms: number): void {
    this.current += ms
  }

  /** Fires whatever is overdue now, as a woken machine's timers do. */
  flush(): void {
    this.advance(0)
  }
}

export interface Harness {
  core: AutonomyCore
  clock: FakeClock
  out: AutonomyOutput[]
  commands(): AutonomyCommand[]
  events(): AutonomyEvent[]
  notices(): Array<{ notice: AutonomyNotice; alert: boolean }>
  views(): AutonomyView[]
  persists(): TabAutonomyRecord[]
  clear(): void
}

export function harness(options: Partial<AutonomyOptions> & { start?: number } = {}): Harness {
  const clock = new FakeClock(options.start)
  const out: AutonomyOutput[] = []
  const core = new AutonomyCore({
    clock,
    random: () => 0.5,
    autoAnswerMs: () => 300_000,
    emit: (o) => out.push(o),
    ...options
  })
  const events = (): AutonomyEvent[] => out.flatMap((o) => (o.to === 'ui' ? [o.event] : []))
  return {
    core,
    clock,
    out,
    commands: () => out.flatMap((o) => (o.to === 'session' ? [o.command] : [])),
    events,
    notices: () =>
      events().flatMap((e) => (e.type === 'notice' ? [{ notice: e.notice, alert: e.alert }] : [])),
    views: () => events().flatMap((e) => (e.type === 'view' ? [e.view] : [])),
    persists: () => events().flatMap((e) => (e.type === 'persist' ? [e.record] : [])),
    clear: () => {
      out.length = 0
    }
  }
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
