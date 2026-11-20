import { AutonomyCore, CONTINUE_TEXT, noticeText } from '../../core/autonomy'
import type { AutonomyClock, AutonomyCommand, AutonomyEvent, AutonomyInput } from '../../core/autonomy'
import { NO_AUTONOMY, type AutonomyView, type SessionStatus, type TabAutonomyRecord, type TabId } from '../../shared/types'
import type { AgentSession } from '../agent/AgentSession'
import type { AgentSessionManager } from '../agent/AgentSessionManager'
import { classifyStartFailure } from '../agent/startFailure'
import type { AutonomyHooks, TabController } from '../tabs/TabController'
import { awakeNeeded } from '../system/keepAwake'

export interface AutonomyHostDeps {
  controller: Pick<TabController, 'list' | 'revive' | 'notice' | 'setAutonomyRecord'>
  manager: Pick<AgentSessionManager, 'get'>
  /** Minutes of the question timer, in ms; read when a card opens. */
  autoAnswerMs: () => number
  /** Something the person should hear of even with the window unfocused. */
  alert: (tabId: TabId, text: string) => void
  /** Whether the machine has to stay awake: an agent works or waits, or a limit is waited out. */
  onAwakeChange: (needed: boolean) => void
  clock?: AutonomyClock
  random?: () => number
}

interface Entry {
  core: AutonomyCore
  session: AgentSession | null
  /** Listeners on the current session; dropped when it is replaced. */
  unsubscribe: Array<() => void>
  status: SessionStatus
  view: AutonomyView
}

const realClock: AutonomyClock = {
  now: () => Date.now(),
  setTimer: (ms, fire) => {
    const timer = setTimeout(fire, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}

const ERROR_NOTICES: ReadonlySet<string> = new Set(['crashGaveUp', 'limitGaveUp', 'remoteGaveUp'])

/**
 * One AutonomyCore per tab, in the main process (decision 1): the core outlives
 * every process restart, so «3 падения за 10 минут» counts across them. The
 * host is the core's hands — it feeds it the session's inputs and turns its
 * commands into calls on the session and the controller.
 */
export class AutonomyHost implements AutonomyHooks {
  private readonly entries = new Map<TabId, Entry>()
  /** After a quit has begun the cores hear nothing and write nothing: a session going down is no event. */
  private frozen = false

  constructor(private readonly deps: AutonomyHostDeps) {}

  // ----------------------------------------------------------- the hooks

  tabAdded(id: TabId, record: TabAutonomyRecord | undefined): void {
    if (this.entries.has(id)) return
    const entry: Entry = {
      core: null as unknown as AutonomyCore,
      session: null,
      unsubscribe: [],
      status: 'stopped',
      view: NO_AUTONOMY
    }
    entry.core = new AutonomyCore({
      clock: this.deps.clock ?? realClock,
      random: this.deps.random ?? Math.random,
      autoAnswerMs: this.deps.autoAnswerMs,
      ...(record ? { record } : {}),
      emit: (out) => {
        if (this.frozen || this.entries.get(id) !== entry) return
        if (out.to === 'session') this.run(id, out.command)
        else this.event(id, entry, out.event)
      }
    })
    this.entries.set(id, entry)
  }

  tabClosed(id: TabId): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    this.detach(entry)
    entry.core.dispose()
    this.refreshAwake()
  }

  sessionAdopted(id: TabId, session: AgentSession): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.detach(entry)
    entry.session = session
    entry.status = session.status
    const current = (): boolean => !this.frozen && this.deps.manager.get(id) === session
    const feed = (input: AutonomyInput): void => {
      // A closed session's cards close too: the manager forgets it before it
      // is disposed, and the waits it cancels then must still leave the core.
      const closing = input.type === 'waitClosed' && !this.frozen && this.entries.get(id) === entry
      if (current() || closing) entry.core.handle(input)
    }
    let last: SessionStatus = session.status
    entry.unsubscribe.push(
      session.onAutonomyInput(feed),
      session.onRemote((info) => feed({ type: 'remote', info })),
      session.onStatus((status) => {
        if (!current()) return
        const was = last
        last = status
        entry.status = status
        // A process that introduced itself and then died. One that never did is
        // the controller's (recoverFromDeadSession); the core does not hear of it.
        if (status === 'error' && was !== 'error' && session.launched && session.sessionId !== null) {
          const cause = classifyStartFailure(session.error ?? '') === 'not-logged-in' ? 'login' : 'crash'
          entry.core.handle({ type: 'processDied', cause })
        }
        this.refreshAwake()
      })
    )
    entry.core.handle({ type: 'mode', mode: session.panelSnapshot().data.permissionMode })
    session.setAutonomyView(entry.core.view)
    this.refreshAwake()
  }

  sessionUp(id: TabId, session: AgentSession, carried: number, clean = false): void {
    const entry = this.entries.get(id)
    if (!entry || this.frozen || this.deps.manager.get(id) !== session) return
    // A session starts in the mode of its tab without saying so (it is told only of changes): read now.
    entry.core.handle({ type: 'mode', mode: session.panelSnapshot().data.permissionMode })
    entry.core.handle({ type: 'processUp', carried, ...(clean ? { clean } : {}) })
  }

  /** A message of the person's that no session has heard yet (held while the session is swapped). */
  personActed(id: TabId): void {
    if (this.frozen) return
    this.entries.get(id)?.core.handle({ type: 'personActed' })
  }

  // ------------------------------------------------------------ the window

  hold(tabId: TabId, cardId: string): void {
    this.entries.get(tabId)?.core.handle({ type: 'hold', cardId })
  }

  answerNow(tabId: TabId, cardId: string): void {
    this.entries.get(tabId)?.core.handle({ type: 'answerNow', cardId })
  }

  /** The person's own Remote Control switch. */
  remoteWanted(tabId: TabId, wanted: boolean): void {
    this.entries.get(tabId)?.core.handle({ type: 'remoteWanted', wanted })
  }

  viewOf(tabId: TabId): AutonomyView {
    return this.entries.get(tabId)?.core.view ?? NO_AUTONOMY
  }

  // --------------------------------------------------------------- the app

  systemResumed(): void {
    if (this.frozen) return
    for (const entry of this.entries.values()) entry.core.handle({ type: 'systemResumed' })
  }

  /**
   * Qclod is going down. A deliberate quit lets go of what was being carried on
   * (decision 8); a session end or an update restart keeps it for the next
   * start. Either way the cores stop here: the sessions about to be closed are
   * no crash and no idle to write down.
   */
  quitting(deliberate: boolean): void {
    if (this.frozen) return
    if (deliberate) for (const entry of this.entries.values()) entry.core.handle({ type: 'personQuit' })
    this.frozen = true
    for (const entry of this.entries.values()) entry.core.dispose()
  }

  // --------------------------------------------------------------- inside

  private detach(entry: Entry): void {
    for (const stop of entry.unsubscribe) stop()
    entry.unsubscribe = []
    entry.session = null
  }

  private refreshAwake(): void {
    const all = [...this.entries.values()]
    this.deps.onAwakeChange(awakeNeeded(all.map((e) => e.status), all.map((e) => e.view)))
  }

  private event(id: TabId, entry: Entry, event: AutonomyEvent): void {
    switch (event.type) {
      case 'view':
        entry.view = event.view
        this.deps.manager.get(id)?.setAutonomyView(event.view)
        this.refreshAwake()
        return
      case 'notice': {
        const text = noticeText(event.notice)
        this.deps.controller.notice(id, text, ERROR_NOTICES.has(event.notice.kind) ? 'error' : 'info')
        if (event.alert) this.deps.alert(id, text)
        return
      }
      case 'persist':
        this.deps.controller.setAutonomyRecord(id, event.record)
        return
    }
  }

  /** The core's command, carried out on the tab's current session. */
  private run(id: TabId, command: AutonomyCommand): void {
    const session = this.deps.manager.get(id)
    switch (command.type) {
      case 'restartProcess':
        this.deps.controller.revive(id).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err)
          this.deps.controller.notice(id, `Сессия не запустилась: ${reason}`, 'error')
        })
        return
      case 'answerQuestion':
        session?.autoAnswerQuestion(command.cardId, command.answers)
        return
      case 'approvePlan':
        void session?.autoApprovePlan(command.cardId)?.catch(() => undefined)
        return
      case 'sendContinue':
        session?.send({ text: CONTINUE_TEXT, attachments: [] }, { auto: true })
        return
      case 'enableRemote': {
        // The CLI may take up to a minute to answer: nothing waits for it here,
        // and a slow answer is no error (ruling S3-R1).
        const title = this.deps.controller.list().find((tab) => tab.id === id)?.title
        void session?.setRemote(true, title)?.catch(() => undefined)
        return
      }
    }
  }
}
