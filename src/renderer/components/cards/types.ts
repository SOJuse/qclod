import type { RibbonItem, TabId } from '../../../shared/types'

export type PermissionItem = Extract<RibbonItem, { kind: 'permission' }>
export type QuestionItem = Extract<RibbonItem, { kind: 'question' }>
export type PlanItem = Extract<RibbonItem, { kind: 'plan' }>

interface OpenCardBase {
  tabId: TabId
  /** Set for a subagent's card: the agent's kind, for «от агента <тип>». */
  fromAgent?: string
}

/**
 * A card still waiting for the user, as the pinned plate above the input shows
 * it: the id it is answered by, and the ribbon item it renders from.
 */
export type OpenCard =
  | (OpenCardBase & { kind: 'permission'; requestId: string; item: PermissionItem })
  | (OpenCardBase & { kind: 'question'; toolUseId: string; item: QuestionItem })
  | (OpenCardBase & { kind: 'plan'; requestId: string; item: PlanItem })

/** «Авто-да» about to answer a card: when, what it will say, and the two ways to step in. */
export interface AutoAnswerView {
  /** ms since the epoch. */
  deadline: number
  label: string
  onAnswerNow(): void
  onStop(): void
}
