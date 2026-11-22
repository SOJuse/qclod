/**
 * A server chat's AgentDriver (stage 6): the same surface AgentSession knows,
 * over the server's relay. The agent and its autonomy core live on the server
 * (hostsAutonomy); here are its records, its live events and the cards it
 * waits on.
 *
 * The stream does not end when the channel breaks — the agent goes on — only
 * when the session is closed. After every attach the open cards are made to
 * match the relay's: a card answered there meanwhile closes once, «авто» when
 * the relay's timer did it (Review Focus 1); a question still open opens.
 *
 * An answer given while the server is away waits for it (I3): the card stays
 * open here until the answer is delivered, and goes after the next attach if
 * the relay still waits on it. «Закрыть чат» while away is kept for the next
 * connect (`closeLater`, I6). The stream is cut on every attach and at the
 * end of the seed (`qclod_stream_reset`, I4): the ribbon then takes the
 * whole message over the part of it the deltas brought.
 */
import { randomUUID } from 'node:crypto'
import {
  RELAY_DRIVER_OPS,
  type AttachResult,
  type JournalRecord,
  type OpenParams,
  type PermResolved,
  type RelayAutonomyView,
  type RelayDriverOp,
  type RelayFrame,
  type RelayPending,
  type RelaySnapshot
} from '../../shared/relayProtocol'
import type { AutonomyView, PermissionAnswer, PermissionMode, UserInput } from '../../shared/types'
import { PERMISSION_MODES } from '../../shared/types'
import type { AgentDriver, DriverOptions, SendOptions } from '../agent/driver'
import { localDeadline, type RelayClient, type SessionSink } from './relayClient'
import { readSent } from './relaySeed'

type Ev = Extract<RelayFrame, { t: 'ev' }>
type Live = Extract<RelayFrame, { t: 'live' }>

export interface RelayDriver extends AgentDriver {
  readonly hostsAutonomy: true
  readonly initial: { snapshot: RelaySnapshot; seed: JournalRecord[] }
  /** The relay's id of this session. */
  readonly relaySessionId: string
  autonomy(cardId: string, action: 'hold' | 'answerNow'): Promise<void>
  onResolvedRemotely(cb: (r: PermResolved) => void): () => void
  onAutonomyView(cb: (v: AutonomyView) => void): () => void
}

/** The relay's «in how long» in this machine's clock (Review Focus 2). */
export function toAutonomyView(v: RelayAutonomyView, now: number): AutonomyView {
  return {
    timers: v.timers.map((t) => ({ cardId: t.cardId, kind: t.kind, deadline: localDeadline(t.remainingMs, now), label: t.label })),
    limitWait: v.limitWait
      ? {
          resetsAt: v.limitWait.resetsInMs === null ? null : now + v.limitWait.resetsInMs,
          continueAt: now + v.limitWait.continueInMs,
          weekly: v.limitWait.weekly
        }
      : null,
    gaveUp: v.gaveUp
  }
}

/** The line a gap in the journal leaves (the older part of the conversation is gone there). */
export function gapText(at: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `Начало разговора старше журнала сервера — показано с ${hh}:${mm}`
}

/** A push queue read as an async iterable; it ends only when told to. */
class MessageQueue implements AsyncIterable<unknown> {
  private readonly items: unknown[] = []
  private waiting: ((r: IteratorResult<unknown>) => void) | null = null
  private ended = false

  push(item: unknown): void {
    if (this.ended) return
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w({ value: item, done: false })
    } else this.items.push(item)
  }

  end(): void {
    this.ended = true
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      }
    }
  }
}

interface OpenCard {
  pending: RelayPending
  controller: AbortController
  /** The person's answer, still to be delivered (the server was away). */
  answer?: PermissionAnswer
}

/** The line a card answered while the server is away gets (I3). */
export const ANSWER_LATER_TEXT = 'Ответ отправится, когда сервер вернётся'

/** What the session reads as «the stream was cut here» (I4). */
export const STREAM_RESET = { type: 'qclod_stream_reset' } as const

const SEED_WAIT_MS = 30_000

function openParams(options: DriverOptions): OpenParams {
  const mode = (PERMISSION_MODES as readonly string[]).includes(options.permissionMode ?? '')
    ? (options.permissionMode as PermissionMode)
    : 'default'
  const extra = options.extraArgs && Object.keys(options.extraArgs).length > 0 ? { extraArgs: options.extraArgs } : {}
  return {
    cwd: options.cwd,
    mode,
    ...(options.model ? { model: options.model } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    ...extra
  }
}

export async function createRelayDriver(
  options: DriverOptions,
  deps: {
    client: RelayClient
    relaySessionId?: string
    onSessionId: (s: string) => void
    now?: () => number
    /** «Закрыть чат» that did not reach the server: closed there on the next connect (I6). */
    closeLater?: (s: string) => void
  }
): Promise<RelayDriver> {
  const { client } = deps
  const now = deps.now ?? Date.now
  const queue = new MessageQueue()
  const cards = new Map<string, OpenCard>()
  const resolvedListeners = new Set<(r: PermResolved) => void>()
  const viewListeners = new Set<(v: AutonomyView) => void>()
  /** uuids of the messages sent from here: their `sent` record is our own bubble. */
  const mine = new Set<string>()
  let lastView: AutonomyView | null = null
  let s = deps.relaySessionId ?? ''
  let closed = false

  // Until the journal up to the snapshot is in, records go to the seed. Frames
  // may come before the attach's answer is read: those past the seed wait in `early`.
  let seeding = true
  let seedUntil = Number.POSITIVE_INFINITY
  const seed: JournalRecord[] = []
  const early: Ev[] = []
  const earlyPerms: RelayPending[] = []
  let seedDone: (() => void) | null = null
  /** After a gap, the first record says from when the conversation is shown. */
  let gapPending = false

  const emitView = (v: RelayAutonomyView): void => {
    lastView = toAutonomyView(v, now())
    for (const cb of [...viewListeners]) cb(lastView)
  }

  const resolveRemotely = (r: PermResolved): void => {
    const card = cards.get(r.requestId)
    if (!card) return
    cards.delete(r.requestId)
    // Told first, so the session knows how the card closed when the abort reaches it.
    const told = card.pending.toolUseId ? { ...r, toolUseId: card.pending.toolUseId } : r
    for (const cb of [...resolvedListeners]) cb(told)
    card.controller.abort()
  }

  /** The answer goes now, or — the server away — waits on the card for the next attach (I3). */
  const deliver = (card: OpenCard, answer: PermissionAnswer): void => {
    const requestId = card.pending.requestId
    const later = (): void => {
      if (closed || card.answer !== undefined) return
      card.answer = answer
      cards.set(requestId, card)
      queue.push({ type: 'qclod_relay_notice', notice: { kind: 'text', text: ANSWER_LATER_TEXT, tone: 'info' } })
    }
    if (client.state !== 'online') return later()
    delete card.answer
    cards.delete(requestId)
    client.call('perm.answer', { s, requestId, answer }).catch((err: unknown) => {
      // The channel broke on the way: the next attach says whether it still waits.
      const code = (err as { code?: unknown } | null)?.code
      if ((code === 'offline' || code === 'timeout') && !cards.has(requestId)) later()
    })
  }

  const openCard = (pending: RelayPending): void => {
    if (closed || cards.has(pending.requestId)) return
    const controller = new AbortController()
    const card: OpenCard = { pending, controller }
    cards.set(pending.requestId, card)
    void Promise.resolve()
      .then(() =>
        options.canUseTool(pending.toolName, pending.input, {
          ...(pending.toolUseId ? { toolUseId: pending.toolUseId } : {}),
          signal: controller.signal
        })
      )
      .then(
        (answer: PermissionAnswer) => {
          // Closed meanwhile — answered elsewhere, by the relay's timer, or the session gone: nothing goes.
          if (cards.get(pending.requestId) !== card || controller.signal.aborted) return
          deliver(card, answer)
        },
        () => {
          if (cards.get(pending.requestId) === card) cards.delete(pending.requestId)
        }
      )
  }

  /** The cards made to match the relay's: open what is open there, close what is not. */
  const syncPending = (snapshot: RelaySnapshot): void => {
    const open = new Set(snapshot.pending.map((p) => p.requestId))
    for (const [requestId, card] of [...cards]) {
      if (open.has(requestId)) continue
      const cardId = card.pending.toolUseId ?? requestId
      // Answered while we were away. Its timer ran out here too: the relay's core did it.
      const timer = lastView?.timers.find((t) => t.cardId === cardId)
      const by: PermResolved['by'] = timer && timer.deadline <= now() ? 'autonomy' : 'elsewhere'
      resolveRemotely({ requestId, by })
    }
    emitView(snapshot.autonomy)
    // An answer that waited for the server goes now that it is back and still asks;
    // its card stays where it is meanwhile, so it is not opened a second time.
    const waiting = [...cards.values()].filter((c) => c.answer !== undefined)
    for (const pending of snapshot.pending) openCard(pending)
    for (const card of waiting) deliver(card, card.answer!)
  }

  const onRecord = (f: Ev): void => {
    if (seeding) {
      if (f.q > seedUntil) early.push(f)
      else {
        seed.push({ q: f.q, at: f.at, k: f.k, d: f.d })
        if (f.q >= seedUntil) seedDone?.()
      }
      return
    }
    if (gapPending) {
      gapPending = false
      queue.push({ type: 'qclod_relay_notice', notice: { kind: 'text', text: gapText(f.at), tone: 'info' } })
    }
    switch (f.k) {
      case 'sdk':
        queue.push(f.d)
        return
      case 'sent': {
        const sent = readSent(f.d)
        if (!sent || (sent.uuid && mine.has(sent.uuid))) return
        // Another client's message or the relay's own «продолжай»: a bubble, once.
        const content =
          sent.input.attachments.length === 0
            ? sent.input.text
            : [
                { type: 'text', text: sent.input.text },
                ...sent.input.attachments.flatMap((a) =>
                  a.kind === 'image' && a.dataBase64
                    ? [{ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.dataBase64 } }]
                    : []
                )
              ]
        queue.push({
          type: 'user',
          message: { role: 'user', content },
          uuid: sent.uuid ?? `relay-sent-${f.q}`,
          qclod_echo_follows: true,
          ...(sent.by === 'autonomy' ? { qclod_auto: true } : {})
        })
        return
      }
      case 'notice':
        queue.push({ type: 'qclod_relay_notice', notice: f.d })
        return
    }
  }

  const onLive = (f: Live): void => {
    switch (f.k) {
      case 'stream':
        if (!seeding) queue.push(f.d)
        return
      case 'perm':
        if (seeding) earlyPerms.push(f.d as RelayPending)
        else openCard(f.d as RelayPending)
        return
      case 'permResolved':
        resolveRemotely(f.d as PermResolved)
        return
      case 'autonomy':
        emitView(f.d as RelayAutonomyView)
        return
      case 'closed':
        closed = true
        for (const card of cards.values()) card.controller.abort()
        cards.clear()
        queue.end()
        return
      default:
        return
    }
  }

  const sink: SessionSink = {
    onEvent: onRecord,
    onLive,
    onReattached: (r: AttachResult) => {
      // The deltas of the break are gone: whole messages from the journal take over (I4).
      queue.push(STREAM_RESET)
      if (r.gap) gapPending = true
      syncPending(r.snapshot)
    }
  }

  let result: AttachResult
  if (deps.relaySessionId) {
    result = await client.attach(deps.relaySessionId, 0, sink)
  } else {
    result = await client.open(openParams(options), sink)
    s = result.snapshot.s
    deps.onSessionId(s)
  }
  s = result.snapshot.s
  // The journal up to the snapshot is the seed; what comes after it is live.
  seedUntil = result.snapshot.lastSeq
  for (let i = seed.length - 1; i >= 0; i--) {
    if (seed[i]!.q > seedUntil) {
      const r = seed.splice(i, 1)[0]!
      early.unshift({ t: 'ev', s, q: r.q, k: r.k, at: r.at, d: r.d })
    }
  }
  const alreadyIn = seedUntil === 0 || (seed.length > 0 && seed[seed.length - 1]!.q >= seedUntil)
  if (!alreadyIn) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SEED_WAIT_MS)
      timer.unref?.()
      seedDone = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }
  seeding = false
  // A message the agent is in the middle of: its deltas began before us (I4).
  queue.push(STREAM_RESET)
  for (const f of early.splice(0).sort((a, b) => a.q - b.q)) onRecord(f)
  if (result.snapshot.firstSeq > 1 && seed.length > 0) {
    seed.unshift({ q: 0, at: seed[0]!.at, k: 'notice', d: { kind: 'text', text: gapText(seed[0]!.at), tone: 'info' } })
  }
  lastView = toAutonomyView(result.snapshot.autonomy, now())
  // The cards still open there: once the session reads the stream.
  setTimeout(() => {
    for (const pending of [...result.snapshot.pending, ...earlyPerms]) openCard(pending)
  }, 0)

  const drv = (op: RelayDriverOp, args: unknown[]): Promise<unknown> => client.call('drv', { s, op, args })

  const driver: RelayDriver = {
    hostsAutonomy: true,
    initial: { snapshot: result.snapshot, seed },
    get relaySessionId() {
      return s
    },
    messages: queue,
    send(input: UserInput, opts?: SendOptions): void {
      const uuid = opts?.uuid ?? randomUUID()
      mine.add(uuid)
      // Waits for the server when it is away (RelayClient); a refusal comes back as a notice.
      drv('send', [input, { ...(opts ?? {}), uuid }]).catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err)
        queue.push({ type: 'qclod_relay_notice', notice: { kind: 'text', text: `Сообщение не ушло на сервер: ${why}`, tone: 'error' } })
      })
    },
    cancelQueued: (uuid) => drv('cancelQueued', [uuid]) as Promise<boolean | null>,
    interrupt: (opts) => drv('interrupt', opts ? [opts] : []) as ReturnType<AgentDriver['interrupt']>,
    setPermissionMode: async (mode) => {
      await drv('setPermissionMode', [mode])
    },
    supportedCommands: () => drv('supportedCommands', []) as ReturnType<AgentDriver['supportedCommands']>,
    mcpServerStatus: () => drv('mcpServerStatus', []) as ReturnType<AgentDriver['mcpServerStatus']>,
    getContextUsage: (opts) => drv('getContextUsage', opts ? [opts] : []) as ReturnType<AgentDriver['getContextUsage']>,
    supportedModels: () => drv('supportedModels', []) as ReturnType<AgentDriver['supportedModels']>,
    setModel: async (model) => {
      await drv('setModel', [model])
    },
    setEffort: async (level) => {
      await drv('setEffort', [level])
    },
    planLimits: () => drv('planLimits', []) as ReturnType<AgentDriver['planLimits']>,
    taskOutput: (taskId) => drv('taskOutput', [taskId]) as ReturnType<AgentDriver['taskOutput']>,
    stopTask: async (taskId) => {
      await drv('stopTask', [taskId])
    },
    backgroundTask: (toolUseId) => drv('backgroundTask', [toolUseId]) as ReturnType<AgentDriver['backgroundTask']>,
    remoteAvailability: () => drv('remoteAvailability', []) as ReturnType<AgentDriver['remoteAvailability']>,
    setRemoteControl: (enabled, name) =>
      drv('setRemoteControl', name === undefined ? [enabled] : [enabled, name]) as ReturnType<AgentDriver['setRemoteControl']>,
    autonomy: async (cardId, action) => {
      await client.call('autonomy.act', { s, cardId, action })
    },
    onResolvedRemotely: (cb) => {
      resolvedListeners.add(cb)
      return () => resolvedListeners.delete(cb)
    },
    onAutonomyView: (cb) => {
      viewListeners.add(cb)
      if (lastView) cb(lastView)
      return () => viewListeners.delete(cb)
    },
    dispose: async (opts) => {
      if (closed) return
      closed = true
      for (const card of cards.values()) card.controller.abort()
      cards.clear()
      queue.end()
      if (opts?.detachOnly) {
        client.detach(s)
        return
      }
      client.detach(s)
      if (client.state !== 'online') {
        deps.closeLater?.(s)
        return
      }
      await client.call('session.close', { s }).catch((err: unknown) => {
        const code = (err as { code?: unknown } | null)?.code
        if (code === 'offline' || code === 'timeout') deps.closeLater?.(s)
      })
    }
  }
  return driver
}

/** For tests: every op of RELAY_DRIVER_OPS is a method here. */
export const RELAY_DRIVER_METHODS: readonly RelayDriverOp[] = RELAY_DRIVER_OPS
