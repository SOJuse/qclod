/**
 * The contract of AutonomyCore — Qclod carrying on by itself (stage 3). Only
 * types: the core runs in the desktop app's main process and, later, in the
 * server-side host (stage 6), so nothing here may reach for Electron, main or
 * the renderer (tests/unit/coreBoundary.test.ts).
 *
 * The core is fed inputs and answers with outputs: commands for the session,
 * events for the window. It never touches a session, a timer or a file itself.
 */
import type {
  AutonomyView,
  PermissionMode,
  RemoteInfo,
  SessionStatus,
  TabAutonomyRecord
} from '../../shared/types'

/** One question of an open AskUserQuestion card, as the core needs it: labels as they came. */
export interface AskedQuestion {
  question: string
  options: string[]
  multiSelect: boolean
}

export type AutonomyInput =
  /** Every SDK frame, as is. */
  | { type: 'sdk'; message: unknown }
  | { type: 'status'; status: SessionStatus }
  | { type: 'mode'; mode: PermissionMode }
  | { type: 'questionOpened'; cardId: string; questions: AskedQuestion[] }
  | { type: 'planOpened'; cardId: string }
  | { type: 'waitClosed'; cardId: string; by: 'person' | 'elsewhere' | 'stop' | 'auto' }
  /** The person started answering, or pressed «Остановить таймер». */
  | { type: 'hold'; cardId: string }
  | { type: 'answerNow'; cardId: string }
  /** A message or an answer from a person, here or on the phone. */
  | { type: 'personActed' }
  /**
   * A new process is up; carried — the person's messages handed over to it.
   * clean — a fresh conversation in place of one that would not open: no
   * «продолжай» goes there, it has nothing to carry on (decision 12).
   */
  | { type: 'processUp'; carried: number; clean?: boolean }
  | { type: 'processDied'; cause: 'crash' | 'login' }
  | { type: 'remote'; info: RemoteInfo }
  /** The person's own Remote Control switch. */
  | { type: 'remoteWanted'; wanted: boolean }
  | { type: 'systemResumed' }
  /** A deliberate quit: «Выйти» in the tray, the window closed with no tray. */
  | { type: 'personQuit' }

export type ContinueReason = 'crash' | 'limit' | 'restore'

export type AutonomyCommand =
  | { type: 'answerQuestion'; cardId: string; answers: Record<string, string> }
  | { type: 'approvePlan'; cardId: string }
  /** CONTINUE_TEXT, marked auto. */
  | { type: 'sendContinue'; reason: ContinueReason }
  /** The same conversation, resumed. */
  | { type: 'restartProcess' }
  | { type: 'enableRemote' }

/** What the core has to say; the host turns it into text (texts.ts) and a ribbon notice. */
export type AutonomyNotice =
  | { kind: 'crashRestart'; attempt: number; willContinue: boolean }
  | { kind: 'crashGaveUp' }
  | { kind: 'limitWait'; resetsAt: number | null; continueAt: number; weekly: boolean }
  | { kind: 'limitOver' }
  | { kind: 'limitGaveUp' }
  | { kind: 'restoreContinue' }
  | { kind: 'remoteAgain' }
  | { kind: 'remoteGaveUp'; problem?: string }

export type AutonomyEvent =
  | { type: 'view'; view: AutonomyView }
  /** alert — also a system notification. */
  | { type: 'notice'; notice: AutonomyNotice; alert: boolean }
  | { type: 'persist'; record: TabAutonomyRecord }

export type AutonomyOutput =
  | { to: 'session'; command: AutonomyCommand }
  | { to: 'ui'; event: AutonomyEvent }

export interface AutonomyClock {
  now(): number
  /** Calls `fire` once after `ms`; the returned function cancels it. */
  setTimer(ms: number, fire: () => void): () => void
}

export interface AutonomyOptions {
  clock: AutonomyClock
  /** 0 ≤ x < 1, for the jitter after a limit reset. */
  random: () => number
  /** Read when a card opens. */
  autoAnswerMs: () => number
  /** From tabs.json; one with `working` or `limitUntil` makes this a restore. */
  record?: TabAutonomyRecord
  emit: (out: AutonomyOutput) => void
}
