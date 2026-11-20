import type { PermissionAnswer, PlanDecision, TabId } from '../../shared/types'

/** What the user chose on a permission card. */
export type PermissionChoice =
  | { behavior: 'allow'; scope: 'once' | 'always' | 'session' }
  | { behavior: 'deny'; reason?: string }

/**
 * Every way a card in the window answers the agent: the ribbon's cards and the
 * pinned one above the input go through the same three calls. The window
 * sends a choice and texts, never a tool's input: main builds that itself.
 */
export interface CardAnswers {
  permission(requestId: string, choice: PermissionChoice): void
  question(toolUseId: string, answers: Record<string, string>, notes: Record<string, string>): void
  plan(requestId: string, decision: PlanDecision): void
}

/** A choice in the words main takes: «всё такое» is a saved rule, «до конца сессии» is not. */
function permissionAnswer(choice: PermissionChoice): PermissionAnswer {
  if (choice.behavior === 'deny') {
    return choice.reason ? { behavior: 'deny', message: choice.reason } : { behavior: 'deny' }
  }
  if (choice.scope === 'always') return { behavior: 'allow', remember: true }
  if (choice.scope === 'session') return { behavior: 'allow', forSession: true }
  return { behavior: 'allow' }
}

/** The answers of one tab's cards, through window.qclod. */
export function cardAnswers(tabId: TabId): CardAnswers {
  return {
    permission(requestId, choice) {
      void window.qclod.answerPermission(requestId, permissionAnswer(choice))
    },
    question(toolUseId, answers, notes) {
      void window.qclod.answerQuestion(tabId, toolUseId, answers, notes)
    },
    plan(requestId, decision) {
      void window.qclod.answerPlan(tabId, requestId, decision)
    }
  }
}
