import { randomUUID } from 'node:crypto'
import type { ToolPermissionContext } from '../main/agent/permissionContext'
import { matchRule, type PermissionRule } from '../main/agent/permissionStore'
import { denialText } from '../main/agent/questionAnswer'
import type { PermResolved, RelayPending } from '../shared/relayProtocol'
import type { PermissionAnswer, PermissionMode } from '../shared/types'

/** Not permissions but questions to a person: «авто-да» never waves them through. */
const ALWAYS_ASKED: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

interface Waiting {
  pending: RelayPending
  resolve: (answer: PermissionAnswer) => void
  cleanup: () => void
}

/**
 * The relay's permission gate: one per session, shared by every client.
 *
 * A saved rule decides at once; «авто-да» allows all but questions and plans;
 * anything else waits for the first answer from anyone — a client or the
 * autonomy core. A later answer finds nothing (false). The SDK giving up on a
 * question closes it as answered elsewhere.
 */
export class RelayGate {
  private readonly waiting = new Map<string, Waiting>()
  private readonly askedListeners: Array<(p: RelayPending) => void> = []
  private readonly resolvedListeners: Array<(r: PermResolved) => void> = []
  private readonly now: () => number

  constructor(private readonly opts: { rules: () => PermissionRule[]; mode: () => PermissionMode; now?: () => number }) {
    this.now = opts.now ?? Date.now
  }

  request(toolName: string, input: Record<string, unknown>, ctx: ToolPermissionContext): Promise<PermissionAnswer> {
    const asked = ALWAYS_ASKED.has(toolName)
    if (toolName !== 'AskUserQuestion') {
      const rule = matchRule(this.opts.rules(), toolName, input)
      if (rule === 'deny') return Promise.resolve({ behavior: 'deny', message: denialText() })
      if (rule === 'allow') return Promise.resolve({ behavior: 'allow' })
    }
    if (!asked && this.opts.mode() === 'autoAllow') return Promise.resolve({ behavior: 'allow' })
    if (ctx.signal?.aborted) return Promise.resolve({ behavior: 'deny' })

    let requestId = ctx.toolUseId ?? randomUUID()
    // An id asked twice is a second question, not the first one answered again.
    if (this.waiting.has(requestId)) requestId = `${requestId}-${randomUUID()}`
    const pending: RelayPending = {
      requestId,
      toolName,
      input,
      ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}),
      askedAt: this.now()
    }
    return new Promise<PermissionAnswer>((resolve) => {
      const onAbort = (): void => {
        if (this.settle(requestId, { behavior: 'deny' })) this.resolved({ requestId, by: 'elsewhere' })
      }
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.set(requestId, {
        pending,
        resolve,
        cleanup: () => ctx.signal?.removeEventListener('abort', onAbort)
      })
      for (const cb of this.askedListeners) cb(pending)
    })
  }

  /** false — already decided (or never asked). */
  answer(requestId: string, answer: PermissionAnswer, by: PermResolved['by']): boolean {
    if (!this.settle(requestId, answer)) return false
    this.resolved({ requestId, by, answer })
    return true
  }

  pending(): RelayPending[] {
    return [...this.waiting.values()].map((w) => w.pending)
  }

  onAsked(cb: (p: RelayPending) => void): void {
    this.askedListeners.push(cb)
  }

  onResolved(cb: (r: PermResolved) => void): void {
    this.resolvedListeners.push(cb)
  }

  /** The process is going: nothing is left to answer. */
  cancelAll(): void {
    for (const requestId of [...this.waiting.keys()]) {
      if (this.settle(requestId, { behavior: 'deny' })) this.resolved({ requestId, by: 'elsewhere' })
    }
  }

  private settle(requestId: string, answer: PermissionAnswer): boolean {
    const waiting = this.waiting.get(requestId)
    if (!waiting) return false
    this.waiting.delete(requestId)
    waiting.cleanup()
    waiting.resolve(answer)
    return true
  }

  private resolved(r: PermResolved): void {
    for (const cb of this.resolvedListeners) cb(r)
  }
}
