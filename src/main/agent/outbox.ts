import type { QueuedMessage, QueuedState, UserInput } from '../../shared/types'
import type { SendPriority } from './driver'
import type { RelayMeta } from './subagentRelay'

/**
 * A message of the user's that the agent has not read yet: held by Qclod while
 * the agent starts (`waiting`), or already with the CLI, which folds it into
 * the turn between steps. The entry is keyed by the uuid it went with, so the
 * CLI's `command_lifecycle` frames find it.
 */
export interface OutboxEntry {
  uuid: string
  input: UserInput
  /** The text as it goes to the agent — what the bubble's echo is matched on. */
  composed: string
  state: QueuedState
  /**
   * Qclod asked the CLI to take it back («Отменить», «Отправить сейчас», «Стоп»),
   * so its `cancelled` frame is the answer, not a turn that swallowed it.
   */
  requestedCancel: boolean
  /** Sent by Qclod itself («продолжай»): its bubble is marked «авто» when the agent reads it. */
  auto?: true
  /** Stage 4: the person's message to a subagent; `input` is the instruction for the main agent. */
  relay?: RelayMeta
  /** Held while the agent starts: the priority it goes with once it is up. */
  priority?: SendPriority
}

/** What the strip above the input shows: the user's messages the agent has not read yet. */
export class Outbox {
  /** A Map keeps the order messages were added in. */
  private readonly entries = new Map<string, OutboxEntry>()

  get size(): number {
    return this.entries.size
  }

  add(entry: Omit<OutboxEntry, 'requestedCancel'>): void {
    this.entries.set(entry.uuid, { ...entry, requestedCancel: false })
  }

  get(uuid: string): OutboxEntry | undefined {
    return this.entries.get(uuid)
  }

  mark(uuid: string, state: QueuedState): void {
    const entry = this.entries.get(uuid)
    if (entry) entry.state = state
  }

  remove(uuid: string): OutboxEntry | undefined {
    const entry = this.entries.get(uuid)
    if (entry) this.entries.delete(uuid)
    return entry
  }

  /** In the order they were added. */
  pending(): OutboxEntry[] {
    return [...this.entries.values()]
  }

  /**
   * The strip's rows. «Отправить сейчас» needs a CLI that keeps a queue, and
   * a message that is with it and not already being taken back.
   */
  view(canSendNow: boolean): QueuedMessage[] {
    return this.pending().map((entry) => ({
      id: entry.uuid,
      // A message to a subagent shows as the person wrote it, to whom — not the instruction.
      text: entry.relay ? `→ агенту ${entry.relay.agent}: ${entry.relay.text}` : entry.input.text,
      attachments: entry.input.attachments.length,
      state: entry.state,
      canSendNow: canSendNow && (entry.state === 'sending' || entry.state === 'queued'),
      ...(entry.relay ? { relay: true as const } : {})
    }))
  }
}

/** The first CLI that folds queued messages into a turn and answers for them. */
const CLI_QUEUE_VERSION = [2, 1, 259]

/** Whether a `claude_code_version` is `least` or later; a version that does not parse is not. */
export function versionAtLeast(version: string, least: number[]): boolean {
  const parts = version.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length === 0 || parts.some((p) => Number.isNaN(p))) return false
  for (let i = 0; i < least.length; i += 1) {
    const have = parts[i] ?? 0
    if (have !== least[i]) return have > least[i]!
  }
  return true
}

/** Режим очереди по system/init: 'cli' — версия ≥ 2.1.259 или есть capability 'interrupt_receipt_v1'; иначе 'local'. */
export function queueModeFrom(init: Record<string, unknown>): 'cli' | 'local' {
  const capabilities = init['capabilities']
  if (Array.isArray(capabilities) && capabilities.includes('interrupt_receipt_v1')) return 'cli'
  const version = init['claude_code_version']
  if (typeof version === 'string' && versionAtLeast(version, CLI_QUEUE_VERSION)) return 'cli'
  return 'local'
}
