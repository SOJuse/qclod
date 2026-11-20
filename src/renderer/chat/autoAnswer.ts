import type { AutoAnswerTimer, AutonomyView, TabId } from '../../shared/types'
import type { AutoAnswerView } from '../components/cards/types'

/**
 * The running countdown of one card, by the card's id. `cardIdOf` (stage 2)
 * gives the same id main's timers carry: the question's toolUseId, the plan's
 * requestId. No timer logic lives in the window — this only reads the panel.
 */
export function autoAnswerTimer(view: AutonomyView | undefined, cardId: string): AutoAnswerTimer | null {
  return view?.timers.find((t) => t.cardId === cardId) ?? null
}

/**
 * What PinnedCard shows of a timer: when and what, and the two ways to step
 * in. A refused call changes nothing here — the timer simply stays until the
 * panel says otherwise.
 */
export function toAutoAnswerView(timer: AutoAnswerTimer | null, tabId: TabId): AutoAnswerView | undefined {
  if (!timer) return undefined
  const { cardId } = timer
  return {
    deadline: timer.deadline,
    label: timer.label,
    onAnswerNow: () => void window.qclod.autonomyAnswerNow(tabId, cardId).catch(() => undefined),
    onStop: () => void window.qclod.autonomyHold(tabId, cardId).catch(() => undefined)
  }
}
