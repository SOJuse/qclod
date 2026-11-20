import type { RibbonItem, TabId } from '../../../shared/types'
import type { CardAnswers } from '../../chat/cardAnswers'
import type { AutoAnswerView, OpenCard } from './types'

export interface PinnedCardsProps {
  tabId: TabId
  items: RibbonItem[]
  answers: CardAnswers
  /** Set while «авто-да» is about to answer this card. */
  autoAnswerFor?: (card: OpenCard) => AutoAnswerView | undefined
}

/** The open card pinned above the input. Its body comes with задача 11; until then nothing is drawn. */
export function PinnedCards(_props: PinnedCardsProps): JSX.Element | null {
  return null
}
