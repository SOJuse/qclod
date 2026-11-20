import { randomUUID } from 'node:crypto'
import type { PermissionAnswer, PermissionRequest, TabId } from '../../shared/types'
import { displayTarget, matchRule, ruleTarget, type PermissionRule } from './permissionStore'

export interface PermissionBrokerOptions {
  loadRules: () => PermissionRule[]
  saveRules: (rules: PermissionRule[]) => void
  /** Shows the question to the person. The answer comes back via `answer()`. */
  ask: (request: PermissionRequest) => void
}

interface Pending {
  tabId: TabId
  toolName: string
  input: Record<string, unknown>
  resolve: (answer: PermissionAnswer) => void
}

/**
 * Stands between the agent and the person for every tool that needs asking.
 *
 * Two things it must never do: ask about something the user has already
 * decided, and leave a request hanging. A `canUseTool` promise that is never
 * settled freezes that tab's agent forever, so closing a tab answers its
 * pending questions with a deny rather than dropping them.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>()
  /**
   * «Разрешить до конца сессии», per chat: kept here only, never on disk, and
   * dropped when that chat's process ends (`clearSession`).
   */
  private readonly sessionRules = new Map<TabId, PermissionRule[]>()

  constructor(private readonly options: PermissionBrokerOptions) {}

  rules(): PermissionRule[] {
    return this.options.loadRules()
  }

  deleteRule(ruleId: string): void {
    this.options.saveRules(this.rules().filter((rule) => rule.id !== ruleId))
  }

  async request(
    tabId: TabId,
    toolName: string,
    input: Record<string, unknown>,
    /** The id the asking side already used; a new one would not be answerable. */
    knownRequestId?: string,
    /**
     * Fires when the asking side stops waiting («Стоп»). The request is then
     * refused and forgotten: a click on its card afterwards answers nothing
     * and, above all, saves no rule.
     */
    signal?: AbortSignal,
    /**
     * «Авто-да»: nobody is asked — a saved rule still decides (a deny wins
     * here as everywhere), and everything else is allowed.
     */
    auto = false
  ): Promise<PermissionAnswer> {
    // Rules are read fresh every time: the user can delete one in settings
    // while an agent is mid-run, and the next call must respect that.
    const decided = matchRule(this.options.loadRules(), toolName, input)
    if (decided) return { behavior: decided }
    if (signal?.aborted) return { behavior: 'deny' }
    // A saved rule has had its say, so a saved deny wins over this chat's allow.
    if (matchRule(this.sessionRules.get(tabId) ?? [], toolName, input) === 'allow') {
      return { behavior: 'allow' }
    }
    if (auto) return { behavior: 'allow' }

    const requestId = knownRequestId ?? randomUUID()
    const target = displayTarget(input)

    return new Promise<PermissionAnswer>((resolve) => {
      const onAbort = (): void => {
        if (this.pending.get(requestId)?.resolve !== settle) return
        this.pending.delete(requestId)
        resolve({ behavior: 'deny' })
      }
      const settle = (answer: PermissionAnswer): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      this.pending.set(requestId, { tabId, toolName, input, resolve: settle })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.options.ask({ requestId, tabId, toolName, target, input })
    })
  }

  answer(requestId: string, answer: PermissionAnswer): void {
    const request = this.pending.get(requestId)
    if (!request) return
    this.pending.delete(requestId)

    const target = ruleTarget(request.input)
    const rule: PermissionRule = {
      id: randomUUID(),
      toolName: request.toolName,
      ...(target ? { target } : {}),
      behavior: answer.behavior
    }
    // The narrower answer wins: a session's allow is never saved for ever.
    if (answer.forSession && answer.behavior === 'allow') {
      this.sessionRules.set(request.tabId, [...(this.sessionRules.get(request.tabId) ?? []), rule])
    } else if (answer.remember) {
      this.options.saveRules([...this.options.loadRules(), rule])
    }

    // How it was answered goes on, for the card to show; the input never does.
    request.resolve({
      behavior: answer.behavior,
      ...(answer.forSession && answer.behavior === 'allow'
        ? { forSession: true as const }
        : answer.remember
          ? { remember: true }
          : {}),
      ...(answer.message && answer.behavior === 'deny' ? { message: answer.message } : {})
    })
  }

  /** The chat's process ended: what was allowed «до конца сессии» is not any more. */
  clearSession(tabId: TabId): void {
    this.sessionRules.delete(tabId)
  }

  /**
   * The tab was switched to «авто-да» while it had questions open: they are
   * answered «allow» now, as the mode would have answered them. No rule is
   * saved — the mode is the standing answer.
   */
  allowTab(tabId: TabId): void {
    for (const [requestId, request] of [...this.pending.entries()]) {
      if (request.tabId !== tabId) continue
      this.pending.delete(requestId)
      request.resolve({ behavior: 'allow' })
    }
  }

  /**
   * A closed tab's agent is gone; its questions are answered so nothing leaks,
   * and its session rules go with it.
   */
  cancelTab(tabId: TabId): void {
    this.clearSession(tabId)
    for (const [requestId, request] of [...this.pending.entries()]) {
      if (request.tabId !== tabId) continue
      this.pending.delete(requestId)
      request.resolve({ behavior: 'deny' })
    }
  }

  cancelAll(): void {
    this.sessionRules.clear()
    for (const [requestId, request] of [...this.pending.entries()]) {
      this.pending.delete(requestId)
      request.resolve({ behavior: 'deny' })
    }
  }
}
