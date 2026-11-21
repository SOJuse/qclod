/**
 * The one place of the relay that knows AutonomyCore's API (stage 3): it feeds
 * the core what a server session goes through and carries out what the core
 * decides — the same core, unchanged, that Qclod runs per tab on the desktop.
 *
 * Сверка F5: a question's or a plan's card id is the tool call's toolUseId, the
 * id the card has in Qclod's window; the relay keeps a map from it to the
 * gate's requestId. The view goes out with «in how long», never the server's
 * clock: remainingMs, resetsInMs, continueInMs.
 */
import { AutonomyCore, CONTINUE_TEXT } from '../core/autonomy'
import type { AskedQuestion, AutonomyClock, AutonomyCommand, AutonomyInput } from '../core/autonomy'
import { encodeQuestionAnswer, notesModeFor } from '../main/agent/questionAnswer'
import { classifyStartFailure } from '../main/agent/startFailure'
import { REMOTE_OFF, explainRemoteError, remoteFromMessage } from '../shared/remote'
import type { PermResolved, RelayAutonomyView, RelayPending } from '../shared/relayProtocol'
import type { AutonomyView, RemoteInfo, TabAutonomyRecord } from '../shared/types'
import type { RelaySession, SessionEvent } from './session'

export interface RelayClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

export interface RelayAutonomy {
  act(cardId: string, action: 'hold' | 'answerNow'): void
  view(): RelayAutonomyView
  dispose(): void
}

const realClock: RelayClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return timer
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** Stage 3's view in «in how long»: the client puts it on its own clock. */
export function toRelayView(view: AutonomyView, now: number): RelayAutonomyView {
  const wait = view.limitWait
  return {
    timers: view.timers.map((t) => ({
      cardId: t.cardId,
      kind: t.kind,
      remainingMs: Math.max(0, t.deadline - now),
      label: t.label
    })),
    limitWait: wait && {
      resetsInMs: wait.resetsAt === null ? null : Math.max(0, wait.resetsAt - now),
      continueInMs: Math.max(0, wait.continueAt - now),
      weekly: wait.weekly
    },
    gaveUp: view.gaveUp
  }
}

/** The questions of an AskUserQuestion input as the core reads them: labels as they came. */
function coreQuestions(input: Record<string, unknown>): AskedQuestion[] {
  const questions = input['questions']
  if (!Array.isArray(questions)) return []
  return questions.flatMap((q: unknown) => {
    if (typeof q !== 'object' || q === null) return []
    const r = q as Record<string, unknown>
    if (typeof r['question'] !== 'string') return []
    const options = Array.isArray(r['options'])
      ? r['options'].flatMap((o: unknown) => {
          const label = typeof o === 'object' && o !== null ? (o as Record<string, unknown>)['label'] : undefined
          return typeof label === 'string' ? [label] : []
        })
      : []
    return [{ question: r['question'], options, multiSelect: r['multiSelect'] === true }]
  })
}

const CLOSED_BY: Record<PermResolved['by'], 'person' | 'auto' | 'elsewhere'> = {
  client: 'person',
  autonomy: 'auto',
  elsewhere: 'elsewhere'
}

export function attachAutonomy(
  session: RelaySession,
  opts: { autoAnswerMs: () => number; clock?: RelayClock; random?: () => number }
): RelayAutonomy {
  const clock = opts.clock ?? realClock
  const coreClock: AutonomyClock = {
    now: () => clock.now(),
    setTimer: (ms, fire) => {
      const h = clock.setTimeout(fire, ms)
      return () => clock.clearTimeout(h)
    }
  }
  /** cardId (toolUseId) → the gate's requestId. */
  const cards = new Map<string, string>()
  let cliVersion: string | null = null
  let remote: RemoteInfo = REMOTE_OFF
  let disposed = false

  const initial = session.record
  const record: TabAutonomyRecord = {
    ...(initial.wasRunning ? { working: true as const } : {}),
    ...(initial.remoteControl ? { remote: true as const } : {})
  }

  const core = new AutonomyCore({
    clock: coreClock,
    random: opts.random ?? Math.random,
    autoAnswerMs: opts.autoAnswerMs,
    record,
    emit: (out) => {
      if (disposed) return
      if (out.to === 'session') {
        // Carried out after the core's own turn: the session's answer feeds the core again.
        const command = out.command
        queueMicrotask(() => {
          if (!disposed) run(command)
        })
        return
      }
      const event = out.event
      switch (event.type) {
        case 'view':
          session.live('autonomy', toRelayView(event.view, clock.now()))
          return
        case 'notice':
          // The text is the client's to build (its own time zone): only the structure goes.
          session.notice({ kind: 'autonomy', notice: event.notice, alert: event.alert })
          return
        case 'persist':
          session.markRunning(event.record.working === true)
          return
      }
    }
  })

  function feed(input: AutonomyInput): void {
    if (!disposed) core.handle(input)
  }

  function cardOf(pending: RelayPending): string {
    return pending.toolUseId ?? pending.requestId
  }

  function onAsked(pending: RelayPending): void {
    const cardId = cardOf(pending)
    if (pending.toolName === 'AskUserQuestion') {
      cards.set(cardId, pending.requestId)
      feed({ type: 'questionOpened', cardId, questions: coreQuestions(pending.input) })
      return
    }
    // A plan gets its card in plan mode and in «авто-да» (stage 3, decision 4); otherwise it is a permission.
    const mode = session.record.mode
    if (pending.toolName === 'ExitPlanMode' && (mode === 'plan' || mode === 'autoAllow')) {
      cards.set(cardId, pending.requestId)
      feed({ type: 'planOpened', cardId })
    }
  }

  function onResolved(resolved: PermResolved): void {
    for (const [cardId, requestId] of cards) {
      if (requestId !== resolved.requestId) continue
      cards.delete(cardId)
      feed({ type: 'waitClosed', cardId, by: CLOSED_BY[resolved.by] })
      if (resolved.by === 'client') feed({ type: 'personActed' })
      return
    }
  }

  function onEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'sdk': {
        const m = e.message as Record<string, unknown> | null
        if (m && m['type'] === 'system' && m['subtype'] === 'init' && typeof m['claude_code_version'] === 'string') {
          cliVersion = m['claude_code_version']
        }
        feed({ type: 'sdk', message: e.message })
        const info = remoteFromMessage(e.message, remote)
        if (info) {
          remote = info
          feed({ type: 'remote', info })
        }
        return
      }
      case 'status':
        feed({ type: 'status', status: e.status })
        return
      case 'mode':
        feed({ type: 'mode', mode: e.mode })
        return
      case 'asked':
        onAsked(e.pending)
        return
      case 'resolved':
        onResolved(e.resolved)
        return
      case 'sent':
        if (e.by === 'client') feed({ type: 'personActed' })
        return
      case 'interrupted':
        feed({ type: 'personActed' })
        return
      case 'remoteWanted':
        feed({ type: 'remoteWanted', wanted: e.wanted })
        return
      case 'up':
        cards.clear()
        remote = REMOTE_OFF
        feed({ type: 'mode', mode: session.record.mode })
        feed({ type: 'processUp', carried: 0 })
        return
      case 'died':
        cards.clear()
        feed({
          type: 'processDied',
          cause: classifyStartFailure(e.error) === 'not-logged-in' ? 'login' : 'crash'
        })
        return
    }
  }

  function run(command: AutonomyCommand): void {
    switch (command.type) {
      case 'answerQuestion': {
        const requestId = cards.get(command.cardId)
        const pending = session.pending().find((p) => p.requestId === requestId)
        // Closed meanwhile — answered, stopped, a dead process: nothing goes, never a message.
        if (!requestId || !pending) return
        session.resolve(
          requestId,
          {
            behavior: 'allow',
            updatedInput: encodeQuestionAnswer(pending.input, command.answers, {}, notesModeFor(cliVersion))
          },
          'autonomy'
        )
        return
      }
      case 'approvePlan': {
        const requestId = cards.get(command.cardId)
        const pending = requestId ? session.pending().find((p) => p.requestId === requestId) : undefined
        if (!requestId || !pending) return
        // Still this very card, still open: anyone may have answered while the mode was changing.
        const stillOpen = (): boolean => session.pending().some((p) => p === pending)
        if (session.record.mode !== 'plan') {
          session.resolve(requestId, { behavior: 'allow' }, 'autonomy')
          return
        }
        // In plan mode an approval leaves it, as a person's does; «авто-да» stays.
        let denied = false
        const off = session.onEvent((e) => {
          if (e.type === 'resolved' && e.resolved.requestId === requestId) denied = e.resolved.answer?.behavior !== 'allow'
        })
        void session
          .call('setPermissionMode', ['acceptEdits'])
          .catch(() => undefined)
          .then(() => {
            off()
            if (stillOpen()) {
              session.resolve(requestId, { behavior: 'allow' }, 'autonomy')
              return
            }
            // Turned down meanwhile (or gone with the process): the plan was not approved, plan mode stays.
            if (denied && session.record.mode === 'acceptEdits') {
              session.call('setPermissionMode', ['plan']).catch(() => undefined)
            }
          })
        return
      }
      case 'sendContinue':
        try {
          session.send({ text: CONTINUE_TEXT, attachments: [] }, undefined, 'autonomy')
        } catch {
          // No process to take it: the next processUp decides again.
        }
        return
      case 'restartProcess':
        session.restart(true).catch((error: unknown) => {
          session.notice({
            kind: 'text',
            text: `Сессия не запустилась: ${error instanceof Error ? error.message : String(error)}`,
            tone: 'error'
          })
        })
        return
      case 'enableRemote':
        session.setRemote(true, session.record.title).catch((error: unknown) => {
          remote = { state: 'failed', problem: explainRemoteError(error) }
          feed({ type: 'remote', info: remote })
        })
        return
    }
  }

  const unsubscribe = session.onEvent(onEvent)
  session.setAutonomySource(() => toRelayView(core.view, clock.now()))
  feed({ type: 'mode', mode: initial.mode })

  return {
    act(cardId, action) {
      feed({ type: action, cardId })
    },
    view: () => toRelayView(core.view, clock.now()),
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      core.dispose()
    }
  }
}
