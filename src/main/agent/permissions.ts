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
    knownRequestId?: string
  ): Promise<PermissionAnswer> {
    // Rules are read fresh every time: the user can delete one in settings
    // while an agent is mid-run, and the next call must respect that.
    const decided = matchRule(this.options.loadRules(), toolName, input)
    if (decided) return { behavior: decided }

    const requestId = knownRequestId ?? randomUUID()
    const target = displayTarget(input)

    return new Promise<PermissionAnswer>((resolve) => {
      this.pending.set(requestId, { tabId, toolName, input, resolve })
      this.options.ask({ requestId, tabId, toolName, target, input })
    })
  }

  answer(requestId: string, answer: PermissionAnswer): void {
    const request = this.pending.get(requestId)
    if (!request) return
    this.pending.delete(requestId)

    if (answer.remember) {
      const rules = this.options.loadRules()
      const target = ruleTarget(request.input)
      rules.push({
        id: randomUUID(),
        toolName: request.toolName,
        ...(target ? { target } : {}),
        behavior: answer.behavior
      })
      this.options.saveRules(rules)
    }

    request.resolve({ behavior: answer.behavior })
  }

  /** A closed tab's agent is gone; its questions are answered so nothing leaks. */
  cancelTab(tabId: TabId): void {
    for (const [requestId, request] of [...this.pending.entries()]) {
      if (request.tabId !== tabId) continue
      this.pending.delete(requestId)
      request.resolve({ behavior: 'deny' })
    }
  }

  cancelAll(): void {
    for (const [requestId, request] of [...this.pending.entries()]) {
      this.pending.delete(requestId)
      request.resolve({ behavior: 'deny' })
    }
  }
}
