import type { AutonomyView, PermissionMode, RemoteInfo, SessionStatus, TabAutonomyRecord } from '../../shared/types'
import {
  CRASH_MAX,
  CRASH_WINDOW_MS,
  LIMIT_CONTINUES_MAX,
  LIMIT_FALLBACK_MS,
  LIMIT_JITTER_MS,
  REMOTE_RESUME_CHECK_MS,
  REMOTE_RETRY_MAX,
  REMOTE_RETRY_MS,
  TICK_MAX_MS
} from './constants'
import { pickAnswers, pickedLabels, shownLabel } from './pickAnswers'
import type {
  AskedQuestion,
  AutonomyCommand,
  AutonomyEvent,
  AutonomyInput,
  AutonomyNotice,
  AutonomyOptions
} from './types'

/** A question or a plan card waiting for an answer. */
interface OpenCard {
  kind: 'question' | 'plan'
  questions: AskedQuestion[]
  /** «Остановить таймер» or the person's own touch: no timer for it, ever. */
  held: boolean
  /** epoch ms; null while no timer runs for it. */
  deadline: number | null
  label: string
}

type LimitWait = NonNullable<AutonomyView['limitWait']> & {
  /** Carried over from tabs.json: the «продолжай» it ends with was counted before the restart. */
  restored: boolean
}

/** What the current turn has said about the subscription limit. */
interface TurnLimit {
  /** rate_limit_event said `rejected`: when it resets (ms, if known) and whether it is weekly. */
  rejected: { resetsAt: number | null; weekly: boolean } | null
  /** An assistant message carried `error: 'rate_limit'`. */
  errored: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The record as text, its keys in one order: a field removed and set again is no change. */
function recordKey(record: TabAutonomyRecord): string {
  return JSON.stringify(record, Object.keys(record).sort())
}

function cardLabel(kind: OpenCard['kind'], questions: AskedQuestion[]): string {
  if (kind === 'plan') return 'Qclod одобрит план'
  const parts = questions
    .map((q) => pickedLabels(q).map(shownLabel).join(', '))
    .filter((part) => part !== '')
  return `Qclod выберет «${parts.join('; ')}»`
}

/**
 * One tab's autonomy: Qclod carrying on by itself. Pure — no Electron, no
 * session, no real timers: inputs come in through `handle`, commands and
 * events go out through `emit`, and time is the clock it is given. The
 * desktop host keeps one per tab (decision 1), so it outlives every process
 * restart; the server host (stage 6) reuses it as is.
 *
 * Scheduling (decision 15): one clock timer at a time, aimed at the nearest
 * deadline but never more than TICK_MAX_MS ahead. Each firing — and each
 * `systemResumed` — looks at the clock afresh and carries out whatever is
 * overdue, once: a machine that slept past a deadline acts on waking.
 */
export class AutonomyCore {
  private readonly options: AutonomyOptions
  private disposed = false
  private cancelTick: (() => void) | null = null
  /** What was last said, to say only changes. */
  private lastView: string
  private lastRecord: string

  // the cards
  private mode: PermissionMode = 'default'
  private readonly cards = new Map<string, OpenCard>()

  // the record and the process
  private stored: TabAutonomyRecord
  /** Made with `working` or `limitUntil` from tabs.json: the first process up picks it up. */
  private restore: boolean
  private seenUp = false
  private alive = false
  /** busy, waiting or idle — the last of them; error, stopped and starting leave it. */
  private lastWork: SessionStatus | null = null

  // crashes
  private crashes: number[] = []
  private continueOnUp = false
  /** The person wrote while no process was up: their message, not «продолжай», carries on. */
  private personWhileDown = false
  private gaveUp: AutonomyView['gaveUp'] = null

  // limits
  private turn: TurnLimit = { rejected: null, errored: false }
  private limitWait: LimitWait | null = null
  private continuesWithoutPerson = 0

  // Remote Control
  private remote: RemoteInfo | null = null
  private remoteRetries = 0
  private remoteRetryAt: number | null = null
  private remoteGaveUpSaid = false
  private remoteCheckAt: number | null = null

  constructor(options: AutonomyOptions) {
    this.options = options
    this.stored = { ...(options.record ?? {}) }
    this.restore = this.stored.working === true || this.stored.limitUntil !== undefined
    this.lastView = JSON.stringify(this.view)
    this.lastRecord = recordKey(this.stored)
  }

  get view(): AutonomyView {
    const timers: AutonomyView['timers'] = []
    for (const [cardId, card] of this.cards) {
      if (card.deadline === null) continue
      timers.push({ cardId, kind: card.kind, deadline: card.deadline, label: card.label })
    }
    const wait = this.limitWait
    return {
      timers,
      limitWait: wait && { resetsAt: wait.resetsAt, continueAt: wait.continueAt, weekly: wait.weekly },
      gaveUp: this.gaveUp
    }
  }

  get record(): TabAutonomyRecord {
    return { ...this.stored }
  }

  handle(input: AutonomyInput): void {
    if (this.disposed) return
    switch (input.type) {
      case 'sdk':
        this.onSdk(input.message)
        break
      case 'status':
        this.onStatus(input.status)
        break
      case 'mode':
        this.setMode(input.mode)
        break
      case 'questionOpened':
        this.open(input.cardId, 'question', input.questions)
        break
      case 'planOpened':
        this.open(input.cardId, 'plan', [])
        break
      case 'waitClosed':
        this.cards.delete(input.cardId)
        break
      case 'hold': {
        const card = this.cards.get(input.cardId)
        if (card) {
          card.held = true
          card.deadline = null
        }
        break
      }
      case 'answerNow': {
        const card = this.cards.get(input.cardId)
        if (card && !card.held && card.deadline !== null && this.mode === 'autoAllow') {
          this.answer(input.cardId)
        }
        break
      }
      case 'personActed':
        this.continueOnUp = false
        if (!this.alive) this.personWhileDown = true
        this.continuesWithoutPerson = 0
        this.gaveUp = null
        this.endLimitWait()
        break
      case 'processUp':
        this.onProcessUp(input.carried, input.clean === true)
        break
      case 'processDied':
        this.onProcessDied(input.cause)
        break
      case 'remote':
        this.onRemote(input.info)
        break
      case 'remoteWanted':
        this.setRecord({ remote: input.wanted ? true : undefined })
        this.remoteRetries = 0
        this.remoteRetryAt = null
        this.remoteGaveUpSaid = false
        break
      case 'systemResumed':
        if (this.stored.remote) this.remoteCheckAt = this.now() + REMOTE_RESUME_CHECK_MS
        this.runDue()
        break
      case 'personQuit':
        // A deliberate quit is no interruption to carry on after (decision 8).
        this.limitWait = null
        this.setRecord({ working: undefined, limitUntil: undefined })
        break
    }
    this.settle()
  }

  dispose(): void {
    this.disposed = true
    this.cancelTick?.()
    this.cancelTick = null
  }

  // ------------------------------------------------------------ the cards

  private setMode(mode: PermissionMode): void {
    const was = this.mode
    this.mode = mode
    if (mode !== 'autoAllow') {
      // Out of «авто-да»: every timer goes (B8).
      for (const card of this.cards.values()) card.deadline = null
      return
    }
    if (was === 'autoAllow') return
    // Into «авто-да»: open cards get a timer from this moment.
    const deadline = this.now() + this.options.autoAnswerMs()
    for (const card of this.cards.values()) if (!card.held) card.deadline = deadline
  }

  private open(cardId: string, kind: OpenCard['kind'], questions: AskedQuestion[]): void {
    if (this.cards.has(cardId)) return
    this.cards.set(cardId, {
      kind,
      questions,
      held: false,
      deadline: this.mode === 'autoAllow' ? this.now() + this.options.autoAnswerMs() : null,
      label: cardLabel(kind, questions)
    })
  }

  /** Closed here at once: what the session says about it later changes nothing. */
  private answer(cardId: string): void {
    const card = this.cards.get(cardId)
    if (!card) return
    this.cards.delete(cardId)
    this.command(
      card.kind === 'plan'
        ? { type: 'approvePlan', cardId }
        : { type: 'answerQuestion', cardId, answers: pickAnswers(card.questions) }
    )
  }

  // --------------------------------------------------- status and working

  private onStatus(status: SessionStatus): void {
    if (status === 'busy' || status === 'waiting') {
      this.lastWork = status
      this.setRecord({ working: true })
    } else if (status === 'idle') {
      this.lastWork = status
      // Waiting out a limit is still work to carry on after a restart. And a
      // process that is only now coming up on a restore says idle before the
      // first processUp: that is no end of the work being restored.
      if (!this.limitWait && !this.restore) this.setRecord({ working: undefined })
    }
  }

  // -------------------------------------------------- the process: crashes

  private onProcessDied(cause: 'crash' | 'login'): void {
    this.alive = false
    // The cards belonged to the process: nothing is left to answer.
    this.cards.clear()
    this.remoteRetryAt = null
    if (cause !== 'crash') return

    const now = this.now()
    // Only marks older than the window go.
    this.crashes = this.crashes.filter((at) => now - at <= CRASH_WINDOW_MS)
    if (this.crashes.length >= CRASH_MAX) {
      this.continueOnUp = false
      this.gaveUp = 'crashes'
      this.notice({ kind: 'crashGaveUp' })
      return
    }
    this.crashes.push(now)
    const willContinue = this.lastWork === 'busy' || this.lastWork === 'waiting'
    this.notice({ kind: 'crashRestart', attempt: this.crashes.length, willContinue })
    this.command({ type: 'restartProcess' })
    this.continueOnUp = willContinue
  }

  private onProcessUp(carried: number, clean: boolean): void {
    const first = !this.seenUp
    this.seenUp = true
    this.alive = true
    // A new process has none of the old one's cards: their timers would count for nothing.
    this.cards.clear()
    this.remoteRetries = 0
    this.remoteRetryAt = null
    this.remoteGaveUpSaid = false
    const restoring = first && this.restore
    this.restore = false

    if (this.stored.remote) {
      // A plain first start says nothing: the person turned it on and it simply is.
      if (!first || restoring) this.notice({ kind: 'remoteAgain' })
      this.command({ type: 'enableRemote' })
    }

    const crashContinue = this.continueOnUp
    this.continueOnUp = false
    const spoke = this.personWhileDown
    this.personWhileDown = false
    // The person's own messages handed over to the new process say more than
    // «продолжай» — and so does one written while it was starting.
    if (carried > 0 || spoke) {
      if (restoring) this.restoreLimitWait()
      return
    }
    // Not the conversation that was being carried on: nothing to continue, nor to wait for.
    if (clean) {
      if (restoring) this.setRecord({ limitUntil: undefined })
      return
    }

    if (restoring) {
      if (this.restoreLimitWait()) return
      if (this.stored.working) {
        this.notice({ kind: 'restoreContinue' })
        this.command({ type: 'sendContinue', reason: 'restore' })
      }
      return
    }
    if (crashContinue) this.command({ type: 'sendContinue', reason: 'crash' })
  }

  /**
   * A limit still being waited out when Qclod went down: wait until the
   * stored time, which already counted against «подряд без человека».
   * False when there is none left to wait (the time has passed or none was stored).
   */
  private restoreLimitWait(): boolean {
    const until = this.stored.limitUntil
    if (until === undefined) return false
    if (until <= this.now()) {
      this.setRecord({ limitUntil: undefined })
      return false
    }
    this.limitWait = { resetsAt: null, continueAt: until, weekly: false, restored: true }
    // The ribbon of before the restart is gone: say again why nothing happens until then.
    this.notice({ kind: 'limitWait', resetsAt: null, continueAt: until, weekly: false })
    return true
  }

  // -------------------------------------------------------------- limits

  private onSdk(message: unknown): void {
    if (!isObject(message)) return
    switch (message['type']) {
      case 'rate_limit_event': {
        const info = message['rate_limit_info']
        if (!isObject(info)) return
        if (info['status'] === 'rejected') {
          const resetsAt = info['resetsAt']
          const type = info['rateLimitType']
          this.turn.rejected = {
            resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
            weekly: typeof type === 'string' && type.startsWith('seven_day')
          }
        } else if (info['status'] === 'allowed') {
          this.turn.rejected = null
        }
        return
      }
      case 'assistant':
        if (message['error'] === 'rate_limit') this.turn.errored = true
        return
      case 'result': {
        const { rejected, errored } = this.turn
        this.turn = { rejected: null, errored: false }
        // A rejection the turn still got through (overage) is no limit.
        if (message['is_error'] === true && (rejected !== null || errored)) {
          this.startLimitWait(rejected?.resetsAt ?? null, rejected?.weekly ?? false)
        }
        return
      }
    }
  }

  private startLimitWait(resetsAt: number | null, weekly: boolean): void {
    if (this.continuesWithoutPerson >= LIMIT_CONTINUES_MAX) {
      this.limitWait = null
      this.gaveUp = 'limits'
      this.setRecord({ working: undefined, limitUntil: undefined })
      this.notice({ kind: 'limitGaveUp' })
      return
    }
    const now = this.now()
    const jitter = Math.floor(this.options.random() * LIMIT_JITTER_MS)
    const continueAt =
      resetsAt === null ? now + LIMIT_FALLBACK_MS : resetsAt > now ? resetsAt + jitter : now + jitter
    this.limitWait = { resetsAt, continueAt, weekly, restored: false }
    this.setRecord({ working: true, limitUntil: continueAt })
    this.notice({ kind: 'limitWait', resetsAt, continueAt, weekly })
  }

  private limitOver(): void {
    const wait = this.limitWait
    if (!wait) return
    this.limitWait = null
    this.setRecord({ limitUntil: undefined })
    if (!wait.restored) this.continuesWithoutPerson += 1
    this.notice({ kind: 'limitOver' })
    this.command({ type: 'sendContinue', reason: 'limit' })
  }

  private endLimitWait(): void {
    this.limitWait = null
    this.setRecord({ limitUntil: undefined })
  }

  // ------------------------------------------------------ Remote Control

  private onRemote(info: RemoteInfo): void {
    this.remote = info
    if (info.state === 'on') {
      this.remoteRetries = 0
      this.remoteRetryAt = null
      this.remoteGaveUpSaid = false
      return
    }
    const dropped = info.state === 'failed' || (info.state === 'off' && !!info.problem)
    if (!dropped || !this.stored.remote || !this.alive || info.blocked) return
    if (this.remoteRetryAt !== null) return
    if (this.remoteRetries < REMOTE_RETRY_MAX) {
      this.remoteRetryAt = this.now() + REMOTE_RETRY_MS
      return
    }
    if (!this.remoteGaveUpSaid) {
      this.remoteGaveUpSaid = true
      this.notice(info.problem ? { kind: 'remoteGaveUp', problem: info.problem } : { kind: 'remoteGaveUp' })
    }
  }

  private retryRemote(): void {
    this.remoteRetryAt = null
    if (!this.stored.remote || !this.alive) return
    this.remoteRetries += 1
    this.command({ type: 'enableRemote' })
  }

  private checkRemoteAfterWaking(): void {
    this.remoteCheckAt = null
    const state = this.remote?.state
    // A retry already on its way does the same.
    if (!this.stored.remote || !this.alive || this.remote?.blocked || this.remoteRetryAt !== null) return
    if (state === 'off' || state === 'failed') this.command({ type: 'enableRemote' })
  }

  // -------------------------------------------------------------- the clock

  private now(): number {
    return this.options.clock.now()
  }

  /** Every deadline the clock has to wake the core for. */
  private deadlines(): number[] {
    const out: number[] = []
    for (const card of this.cards.values()) if (card.deadline !== null) out.push(card.deadline)
    if (this.limitWait) out.push(this.limitWait.continueAt)
    if (this.remoteRetryAt !== null) out.push(this.remoteRetryAt)
    if (this.remoteCheckAt !== null) out.push(this.remoteCheckAt)
    return out
  }

  /** Carries out, once, everything whose time has come. */
  private runDue(): void {
    const now = this.now()
    const due = [...this.cards].filter(([, card]) => card.deadline !== null && card.deadline <= now)
    for (const [cardId, card] of due) {
      // An earlier answer may have closed or stopped it meanwhile (a host reacting at once).
      if (this.cards.get(cardId) === card && card.deadline !== null) this.answer(cardId)
    }
    if (this.limitWait && this.limitWait.continueAt <= now) this.limitOver()
    if (this.remoteRetryAt !== null && this.remoteRetryAt <= now) this.retryRemote()
    if (this.remoteCheckAt !== null && this.remoteCheckAt <= now) this.checkRemoteAfterWaking()
  }

  private tick = (): void => {
    this.cancelTick = null
    if (this.disposed) return
    this.runDue()
    this.settle()
  }

  private reschedule(): void {
    this.cancelTick?.()
    this.cancelTick = null
    if (this.disposed) return
    const next = this.deadlines()
    if (next.length === 0) return
    const ms = Math.min(TICK_MAX_MS, Math.max(0, Math.min(...next) - this.now()))
    this.cancelTick = this.options.clock.setTimer(ms, this.tick)
  }

  // ---------------------------------------------------------------- output

  /** Sets or (with undefined) removes fields of the record. */
  private setRecord(patch: { [K in keyof TabAutonomyRecord]: TabAutonomyRecord[K] | undefined }): void {
    const next: TabAutonomyRecord = { ...this.stored }
    for (const [key, value] of Object.entries(patch) as Array<[keyof TabAutonomyRecord, unknown]>) {
      if (value === undefined) delete next[key]
      else (next as Record<string, unknown>)[key] = value
    }
    this.stored = next
  }

  /** After every input: say what changed, aim the clock again. */
  private settle(): void {
    const view = this.view
    const viewText = JSON.stringify(view)
    if (viewText !== this.lastView) {
      this.lastView = viewText
      this.event({ type: 'view', view })
    }
    const recordText = recordKey(this.stored)
    if (recordText !== this.lastRecord) {
      this.lastRecord = recordText
      this.event({ type: 'persist', record: this.record })
    }
    this.reschedule()
  }

  private notice(notice: AutonomyNotice): void {
    const alert =
      notice.kind === 'crashGaveUp' ||
      notice.kind === 'limitGaveUp' ||
      notice.kind === 'remoteGaveUp' ||
      (notice.kind === 'limitWait' && notice.weekly)
    this.event({ type: 'notice', notice, alert })
  }

  private command(command: AutonomyCommand): void {
    this.options.emit({ to: 'session', command })
  }

  private event(event: AutonomyEvent): void {
    this.options.emit({ to: 'ui', event })
  }
}
