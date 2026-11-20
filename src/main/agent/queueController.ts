import { randomUUID } from 'node:crypto'
import type { QueuedMessage, UserInput } from '../../shared/types'
import type { AgentDriver, InterruptReceipt, SendPriority } from './driver'
import { composeText } from './userMessage'
import { Outbox, queueModeFrom, type OutboxEntry } from './outbox'

/** Messages on the strip, not read by the agent yet; one more is handed back rather than kept. */
export const MAX_QUEUED = 20

/** A message the CLI dropped from its queue without being asked to. */
const NOT_DELIVERED = 'Сообщение не дошло до агента: ход прервали'

/** A queued image handed back to the window: its copy on disk stands for its bytes. */
function withoutCopiedBytes(input: UserInput): UserInput {
  return {
    ...input,
    attachments: input.attachments.map((a) =>
      a.kind === 'image' && a.path ? { ...a, dataBase64: '' } : a
    )
  }
}

/** What the queue needs from the session it serves; the session keeps turns, waits and status. */
export interface QueueHost {
  driver(): AgentDriver | null
  turnRunning(): boolean
  /**
   * turn += 1, turnRunning = true, status busy unless a card is open.
   * `evenIfWaiting` — busy even then: a message given to the agent by Qclod
   * itself (`sendNow`) always set the tab working.
   */
  startTurn(opts?: { evenIfWaiting?: boolean }): void
  /** turnRunning = false, status idle unless a card is open. */
  endTurn(): void
  currentTurn(): number
  showUser(input: UserInput, composed: string, echoOf: string | null): void
  /** Before init: kept for a resend (`sentBeforeInit`). */
  remember(sent: UserInput): void
  emitQueue(view: QueuedMessage[]): void
  notice(text: string, tone: 'info' | 'error'): void
  cancelWaits(scope?: { upTo?: number }): void
}

/**
 * The user's messages the agent has not read yet, and everything that moves
 * them: the strip, the CLI's own queue, «Отменить», «Отправить сейчас» and the
 * queue's half of «Стоп». The session it serves keeps the turn, the open cards
 * and the status; the queue asks it for them through `QueueHost`.
 */
export class QueueController {
  private readonly host: QueueHost
  /**
   * The user's messages the agent has not read yet, oldest first — on the
   * strip, not in the ribbon. While the agent starts they wait here
   * (`waiting`); once it is up they are with the CLI, which folds them into
   * the turn between steps, and its `command_lifecycle` frames move them
   * along: `started` turns one into a bubble.
   */
  private readonly outbox = new Outbox()
  /**
   * Whether this CLI keeps a queue of its own and reports on it (ruling R6):
   * init says so, or a lifecycle frame has already come. init comes after the
   * first frames and again every turn; until either, a message sent during a
   * turn shows at once, as with an old CLI.
   */
  private cliQueueOn = false
  /**
   * The last result came while the CLI still had a turn of this tab's to run:
   * the tab stays busy and the turn counts as under way until that turn starts
   * or there is nothing left for it to run. `queuedTurns` is how many the
   * result said were waiting, less those taken back since.
   */
  private heldByQueue = false
  private queuedTurns = 0
  /** One more every time the outbox is handed over: a cancel answered after that is not ours. */
  private outboxEpoch = 0
  /**
   * Being taken back for «Отправить сейчас», each with the CLI's answer to
   * come: their `cancelled` frame neither lets the tab go nor counts as
   * unread. A «Стоп» pressed meanwhile waits for that answer too, and the
   * first one to do so claims it (`claimedBy`, its number): only that Stop
   * hands it back, so a second Stop does not hand it back again.
   */
  private readonly resending = new Map<
    string,
    { entry: OutboxEntry; answer: Promise<boolean | null>; claimedBy: number | null }
  >()
  /** One more for every «Стоп»: a send-now answered after one is not sent again. */
  private stops = 0
  /**
   * How many «Стоп» are on their way. Meanwhile a message goes straight to
   * the agent: the queue was handed back when Stop was pressed, and a message
   * typed after that is meant to be sent, not pulled back too.
   */
  private stopsInFlight = 0

  constructor(host: QueueHost) {
    this.host = host
  }

  get size(): number {
    return this.outbox.size
  }

  get cliQueue(): boolean {
    return this.cliQueueOn
  }

  /** True when the strip is full and the message would wait on it. */
  wouldOverflow(): boolean {
    return this.willQueue() && this.outbox.size >= MAX_QUEUED
  }

  /** A message sent now would wait on the strip for the agent to read it. */
  private willQueue(): boolean {
    return this.host.turnRunning() && this.stopsInFlight === 0 && this.cliQueueOn
  }

  /** A message from the user, for a session that is up: under a uuid of its own. */
  submit(input: UserInput): void {
    this.dispatch(input, randomUUID())
  }

  /**
   * Gives a message to the CLI, by what is going on. No turn: it starts one
   * and shows at once. A «Стоп» on its way: the same — the strip was handed
   * back when Stop was pressed, and a message typed after that is meant to
   * be sent, not pulled back too. A turn under way: the CLI folds it in, and
   * it shows when the CLI says the agent read it — or at once, with a CLI that
   * says nothing about its queue.
   */
  private dispatch(input: UserInput, uuid: string): void {
    if (!this.host.turnRunning() || this.stopsInFlight > 0) this.sendNowAs(input, uuid)
    else if (this.cliQueueOn) this.enqueue(input, uuid)
    else this.foldNow(input, uuid)
  }

  /** Starts a turn of its own: shown at once, given to the agent. */
  private sendNowAs(input: UserInput, uuid: string): void {
    const driver = this.host.driver()
    if (!driver) return
    const composed = composeText(input)
    this.host.showUser(input, composed, uuid)
    this.host.startTurn({ evenIfWaiting: true })
    this.transmit(driver, { ...input, text: composed }, uuid)
  }

  /**
   * Into the turn under way, on a CLI that keeps no account of it: shown at
   * once, no new turn. Its echo is still expected — such a CLI may run it as
   * a turn of its own, and echo it — until the result that carried it.
   */
  private foldNow(input: UserInput, uuid: string): void {
    const driver = this.host.driver()
    if (!driver) return
    const composed = composeText(input)
    this.host.showUser(input, composed, uuid)
    this.transmit(driver, { ...input, text: composed }, uuid)
  }

  /** What is on screen goes to the agent; before init it is also kept for a resend. */
  private transmit(driver: AgentDriver, sent: UserInput, uuid: string): void {
    this.host.remember(sent)
    driver.send(sent, { uuid })
  }

  /** Onto the strip and to the CLI; its lifecycle frames take it from there. */
  private enqueue(input: UserInput, uuid: string, priority?: SendPriority): void {
    const driver = this.host.driver()
    if (!driver) return
    const composed = composeText(input)
    this.outbox.add({ uuid, input, composed, state: 'sending' })
    this.emitQueue()
    // Without a priority the CLI takes it as 'next': read at the next step boundary.
    driver.send({ ...input, text: composed }, priority ? { uuid, priority } : { uuid })
  }

  /** Held until the agent is up. The uuid is the one it will go with (ruling R2). */
  hold(input: UserInput): void {
    this.outbox.add({ uuid: randomUUID(), input, composed: composeText(input), state: 'waiting' })
    this.emitQueue()
  }

  /** The agent is up: everything held for it goes, in order, each under the uuid it was given. */
  flushWaiting(): boolean {
    const waiting = this.outbox.pending().filter((e) => e.state === 'waiting')
    if (!this.host.driver() || waiting.length === 0) return false
    for (const entry of waiting) {
      this.outbox.remove(entry.uuid)
      this.dispatch(entry.input, entry.uuid)
    }
    this.emitQueue()
    return true
  }

  /**
   * The queue's half of «Стоп»: interrupt with cancelQueued, hand back what
   * came off. The session refuses the open cards around it and ends the turn.
   */
  async stop(): Promise<UserInput[]> {
    const driver = this.host.driver()
    if (!driver) return []
    this.stops += 1
    const stop = this.stops
    // What is on the strip now is what Stop hands back. Marked before
    // anything is awaited: their `cancelled` frames can come before the
    // receipt does, and must read as asked for, not as messages a stopped
    // turn swallowed. One being taken back by «Отменить» answers for itself.
    // One being taken back for «Отправить сейчас» is not sent again: once the
    // CLI answers, it goes back with the rest (its `cancelled` frame may have
    // taken it off the strip already) — from the first Stop that claimed it.
    const resending = [...this.resending.values()]
    const claimed = resending.filter((r) => r.claimedBy === null)
    for (const r of claimed) r.claimedBy = stop
    const resent = new Set(claimed.map((r) => r.entry))
    const strip = this.outbox.pending()
    const onStrip = strip.filter((e) => !e.requestedCancel)
    // In the strip's order; one already off it goes last.
    const handing = [
      ...strip.filter((e) => !e.requestedCancel || resent.has(e)),
      ...[...resent].filter((e) => !strip.includes(e))
    ]
    const before = new Map(onStrip.map((e) => [e.uuid, e.state]))
    for (const entry of onStrip) {
      entry.requestedCancel = true
      this.outbox.mark(entry.uuid, 'cancelling')
    }
    if (onStrip.length > 0) this.emitQueue()
    const epoch = this.outboxEpoch
    this.stopsInFlight += 1
    let cancelled: Set<string>
    try {
      const receipt = await this.interruptSafely(driver, { cancelQueued: true })
      cancelled = new Set(receipt?.cancelled ?? [])
      // A CLI with no receipt, or one that cannot cancel with it (no
      // `cancelled` in it, or messages still in `still_queued`), is asked
      // about each of the rest in turn: left alone, it runs them after Stop.
      const rest =
        receipt?.cancelled === undefined
          ? onStrip
          : onStrip.filter((e) => !cancelled.has(e.uuid) && receipt.stillQueued.includes(e.uuid))
      for (const uuid of await this.cancelEach(driver, rest)) cancelled.add(uuid)
      // Every send-now on its way is waited for; only those this Stop claimed count.
      const answers = await Promise.all(resending.map((r) => r.answer))
      resending.forEach((r, i) => {
        if (answers[i] === true && r.claimedBy === stop) cancelled.add(r.entry.uuid)
      })
    } finally {
      this.stopsInFlight -= 1
    }
    // An image with its copy on disk goes back without its bytes: the window
    // has the copy, and main reads it again on the next send. Nothing goes
    // back from a strip that was handed to a successor meanwhile.
    const returned: UserInput[] = []
    if (epoch === this.outboxEpoch) {
      for (const entry of handing) {
        if (cancelled.has(entry.uuid)) {
          this.outbox.remove(entry.uuid)
          returned.push(withoutCopiedBytes(entry.input))
        } else if (this.outbox.get(entry.uuid) === entry) {
          // The CLI kept it, or the agent read it first: it is as it was.
          entry.requestedCancel = false
          const was = before.get(entry.uuid)
          if (was) this.outbox.mark(entry.uuid, was)
        }
      }
      if (handing.length > 0) this.emitQueue()
    }
    return returned
  }

  /**
   * «Отменить» (and «Изменить»): takes a message off the strip before the
   * agent reads it, and hands it back. Null when it is not there, when the
   * agent has read it already (its bubble is on its way), or when this CLI
   * cannot take it back.
   */
  async cancel(id: string): Promise<UserInput | null> {
    const entry = this.outbox.get(id)
    if (!entry || entry.requestedCancel) return null
    const driver = this.host.driver()
    // Still only Qclod's — the agent is starting, or the one it went to is
    // gone: nothing to ask anyone.
    if (entry.state === 'waiting' || !driver) {
      this.dropEntry(id)
      return withoutCopiedBytes(entry.input)
    }
    const was = entry.state
    entry.requestedCancel = true
    this.outbox.mark(id, 'cancelling')
    this.emitQueue()
    const epoch = this.outboxEpoch
    const answer = await this.cancelSafely(driver, id)
    // Handed to a successor meanwhile: it is that session's to send.
    if (epoch !== this.outboxEpoch) return null
    if (answer === true) {
      // Its `cancelled` frame may have taken it off the strip already.
      this.dropEntry(id)
      return withoutCopiedBytes(entry.input)
    }
    if (this.outbox.get(id) === entry) {
      entry.requestedCancel = false
      this.outbox.mark(id, was)
      this.emitQueue()
    }
    return null
  }

  /**
   * «Отправить сейчас»: taken back and sent again with `priority: 'now'`,
   * under a new uuid — the strip shows it as a new entry. A CLI that cannot
   * take it back has it queued already: the turn is stopped, and it goes
   * first. False when it is not on the strip, the agent has read it, or a
   * «Стоп» came before the CLI answered (that Stop hands it back).
   */
  async sendNow(id: string): Promise<boolean> {
    const entry = this.outbox.get(id)
    const driver = this.host.driver()
    if (!entry || !driver || !this.cliQueueOn || entry.requestedCancel) return false
    if (entry.state !== 'sending' && entry.state !== 'queued') return false
    // Its `cancelled` frame is our doing, not a stopped turn's.
    entry.requestedCancel = true
    const epoch = this.outboxEpoch
    const stops = this.stops
    const asked = this.cancelSafely(driver, id)
    this.resending.set(id, { entry, answer: asked, claimedBy: null })
    let answer: boolean | null
    try {
      answer = await asked
    } finally {
      this.resending.delete(id)
    }
    if (epoch !== this.outboxEpoch || this.host.driver() !== driver) return false
    // «Стоп» pressed meanwhile wins: it hands the message back to the input
    // field, or leaves it as it was — either way it is not sent again.
    if (this.stops !== stops) return false
    if (answer === true) {
      // Off and on again in one go, so the tab is not let go in between.
      this.outbox.remove(id)
      this.enqueue(entry.input, randomUUID(), 'now')
      return true
    }
    if (this.outbox.get(id) === entry) entry.requestedCancel = false
    if (answer === false) return false
    // A turn genuinely under way is stopped; between turns it goes next anyway.
    if (this.host.turnRunning() && !this.heldByQueue) {
      // As with «Стоп»: the SDK abandons an open question without saying so.
      this.host.cancelWaits({ upTo: this.host.currentTurn() })
      await this.interruptSafely(driver)
    }
    return true
  }

  /**
   * Empties the strip and hands over what was on it, to a successor. With
   * the process gone, everything there is unread: the CLI lost its queue.
   * One being taken back for «Отправить сейчас» goes too, even once its
   * `cancelled` frame has taken it off the strip: the epoch moves on, so that
   * send-now answers false and sends nothing.
   */
  take(): UserInput[] {
    const strip = this.outbox.pending()
    const resent = [...this.resending.values()]
      .map((r) => r.entry)
      .filter((e) => this.outbox.get(e.uuid) !== e)
    const entries = [...strip, ...resent]
    if (entries.length === 0) return []
    this.outboxEpoch += 1
    for (const entry of strip) this.outbox.remove(entry.uuid)
    if (strip.length > 0) this.emitQueue()
    return entries.map((e) => e.input)
  }

  /**
   * Takes over a predecessor's strip. A session that is up sends it all at
   * once, as if just typed; one that is not holds it until it is.
   */
  requeue(inputs: UserInput[]): void {
    if (inputs.length === 0) return
    if (!this.host.driver()) {
      for (const input of inputs) this.hold(input)
      return
    }
    for (const input of inputs) this.dispatch(input, randomUUID())
  }

  /** init comes again with every turn; what it says of the queue only ever turns it on. */
  onInit(m: Record<string, unknown>): void {
    if (!this.cliQueueOn && queueModeFrom(m) === 'cli') {
      this.cliQueueOn = true
      if (this.outbox.size > 0) this.emitQueue()
    }
  }

  /**
   * The CLI's account of a message sent with a uuid. Only what is on the
   * strip is followed: a frame for anything else — the message that started
   * the turn, one sent from the phone — is ignored (ruling R5).
   */
  onLifecycle(m: Record<string, unknown>): void {
    if (!this.cliQueueOn) {
      this.cliQueueOn = true
      if (this.outbox.size > 0) this.emitQueue()
    }
    const uuid = m['command_uuid']
    const entry = typeof uuid === 'string' ? this.outbox.get(uuid) : undefined
    if (!entry) return
    switch (m['state']) {
      case 'queued':
        // One being taken back stays so until the CLI answers.
        if (entry.state === 'sending') {
          this.outbox.mark(entry.uuid, 'queued')
          this.emitQueue()
        }
        break
      case 'started':
        this.outbox.remove(entry.uuid)
        this.emitQueue()
        this.onRead(entry)
        break
      case 'cancelled':
        if (this.resending.has(entry.uuid)) {
          // «Отправить сейчас»: it comes back under a new uuid in a moment.
          this.outbox.remove(entry.uuid)
          this.emitQueue()
          break
        }
        this.dropEntry(entry.uuid)
        if (!entry.requestedCancel) {
          this.host.notice(`${NOT_DELIVERED} — «${entry.input.text}»`, 'error')
        }
        break
      default:
        break
    }
  }

  /**
   * The end of a turn. The tab is free only when the CLI has nothing more of
   * its to run — no turn it says is waiting (`queued_turn_count`), nothing on
   * the strip it holds; otherwise it stays busy (ruling R4). 'hold' — the CLI
   * still owes a turn; the session stays busy.
   */
  onResult(m: Record<string, unknown>): 'release' | 'hold' {
    // What the turn read, by its uuids: anything on the strip it names was
    // read without a frame saying so, and shows now rather than never.
    const read = Array.isArray(m['user_message_uuids']) ? m['user_message_uuids'] : []
    for (const uuid of read) {
      const entry = typeof uuid === 'string' ? this.outbox.get(uuid) : undefined
      if (!entry || entry.state === 'waiting') continue
      this.outbox.remove(entry.uuid)
      this.emitQueue()
      this.onRead(entry)
    }
    const count = m['queued_turn_count']
    this.queuedTurns = typeof count === 'number' && count > 0 ? count : 0
    this.heldByQueue = this.cliOwesTurn()
    return this.heldByQueue ? 'hold' : 'release'
  }

  /**
   * The turn is over for good — the process failed or the session closed, or
   * a «Стоп» ended it: forget the turn's hold. The strip stays, for a successor.
   */
  onDead(): void {
    this.heldByQueue = false
    this.queuedTurns = 0
  }

  /** The strip's rows, as the panel shows them. */
  view(): QueuedMessage[] {
    return this.outbox.view(this.cliQueueOn && this.host.driver() !== null)
  }

  /** Off the strip without the agent reading it. */
  private dropEntry(uuid: string): void {
    if (!this.outbox.remove(uuid)) return
    this.emitQueue()
    this.releaseIfDone(true)
  }

  /**
   * The agent read one of the strip's messages: its bubble shows now. If no
   * turn was under way — or the last one had ended with this waiting — it
   * starts one.
   */
  private onRead(entry: OutboxEntry): void {
    // Folded into a turn under way, it is never echoed (probe 05a): no
    // expectation that could swallow the same words typed later (ruling R10).
    // One that starts a turn of its own may be, until that turn's result.
    const folded = this.host.turnRunning() && !this.heldByQueue
    this.host.showUser(entry.input, entry.composed, folded ? null : entry.uuid)
    this.host.remember({ ...entry.input, text: entry.composed })
    if (folded) return
    this.heldByQueue = false
    if (this.queuedTurns > 0) this.queuedTurns -= 1
    this.host.startTurn()
  }

  /**
   * Whether a result held back by the CLI's queue can let the tab go: nothing
   * left on the strip with the CLI and no turn it said was waiting. `taken`
   * — a message just came off the strip unread, one turn fewer to wait for.
   */
  private releaseIfDone(taken = false): void {
    if (!this.heldByQueue) return
    if (taken && this.queuedTurns > 0) this.queuedTurns -= 1
    if (this.cliOwesTurn()) return
    this.heldByQueue = false
    this.host.endTurn()
  }

  /** The CLI still has something of this tab's to run. */
  private cliOwesTurn(): boolean {
    return this.queuedTurns > 0 || this.outbox.pending().some((e) => e.state !== 'waiting')
  }

  /** A driver that throws (a session already closed) cannot cancel: the same as a CLI that cannot. */
  private async cancelSafely(driver: AgentDriver, uuid: string): Promise<boolean | null> {
    try {
      return await driver.cancelQueued(uuid)
    } catch {
      return null
    }
  }

  private async interruptSafely(
    driver: AgentDriver,
    opts?: { cancelQueued?: boolean }
  ): Promise<InterruptReceipt | undefined> {
    try {
      return await driver.interrupt(opts)
    } catch {
      return undefined
    }
  }

  /** Which of these the CLI took back, asked one by one. */
  private async cancelEach(driver: AgentDriver, entries: OutboxEntry[]): Promise<Set<string>> {
    const answers = await Promise.all(entries.map((e) => this.cancelSafely(driver, e.uuid)))
    return new Set(entries.filter((_, i) => answers[i] === true).map((e) => e.uuid))
  }

  private emitQueue(): void {
    this.host.emitQueue(this.view())
  }
}
