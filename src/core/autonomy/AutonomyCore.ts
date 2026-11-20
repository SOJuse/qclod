import type { AutonomyView, PermissionMode, TabAutonomyRecord } from '../../shared/types'
import { TICK_MAX_MS } from './constants'
import { pickAnswers, pickedLabels, shownLabel } from './pickAnswers'
import type {
  AskedQuestion,
  AutonomyCommand,
  AutonomyEvent,
  AutonomyInput,
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
 * desktop host keeps one per tab (decision 1); the server host (stage 6)
 * reuses it as is.
 *
 * Scheduling (decision 15): one clock timer at a time, aimed at the nearest
 * deadline but never more than TICK_MAX_MS ahead. Each firing — and each
 * `systemResumed` — looks at the clock afresh and carries out whatever is
 * overdue, once: a machine that slept past a deadline acts on waking.
 */
export class AutonomyCore {
  private readonly options: AutonomyOptions
  private mode: PermissionMode = 'default'
  private readonly cards = new Map<string, OpenCard>()
  private stored: TabAutonomyRecord
  private lastView: string
  private lastRecord: string
  private cancelTick: (() => void) | null = null
  private disposed = false

  constructor(options: AutonomyOptions) {
    this.options = options
    this.stored = { ...(options.record ?? {}) }
    this.lastView = JSON.stringify(this.view)
    this.lastRecord = JSON.stringify(this.stored)
  }

  get view(): AutonomyView {
    const timers: AutonomyView['timers'] = []
    for (const [cardId, card] of this.cards) {
      if (card.deadline === null) continue
      timers.push({ cardId, kind: card.kind, deadline: card.deadline, label: card.label })
    }
    return { timers, limitWait: null, gaveUp: null }
  }

  get record(): TabAutonomyRecord {
    return { ...this.stored }
  }

  handle(input: AutonomyInput): void {
    if (this.disposed) return
    switch (input.type) {
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
      case 'processDied':
        // The cards belonged to the process: nothing is left to answer.
        this.cards.clear()
        break
      case 'systemResumed':
        this.runDue()
        break
      default:
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

  // -------------------------------------------------------------- the clock

  private now(): number {
    return this.options.clock.now()
  }

  /** Every deadline the clock has to wake the core for. */
  private deadlines(): number[] {
    const out: number[] = []
    for (const card of this.cards.values()) if (card.deadline !== null) out.push(card.deadline)
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

  /** After every input: say what changed, aim the clock again. */
  private settle(): void {
    const view = this.view
    const viewText = JSON.stringify(view)
    if (viewText !== this.lastView) {
      this.lastView = viewText
      this.event({ type: 'view', view })
    }
    const recordText = JSON.stringify(this.stored)
    if (recordText !== this.lastRecord) {
      this.lastRecord = recordText
      this.event({ type: 'persist', record: this.record })
    }
    this.reschedule()
  }

  private command(command: AutonomyCommand): void {
    this.options.emit({ to: 'session', command })
  }

  private event(event: AutonomyEvent): void {
    this.options.emit({ to: 'ui', event })
  }
}
